/**
 * ISOLATED world 内容脚本 —— 中间人
 * ================================
 *  - 页面上真的出现音频轨时，才起 Worker 跑唤醒词检测
 *  - 在页面（MAIN world）与 Worker 之间转发 PCM 和时间戳表
 *  - 画一个极简提示条：刚刚拦了什么、一键撤销
 *
 * 为什么 Worker 里不 importScripts / 不 fetch：
 * blob Worker 的源是不透明的，跨源加载 chrome-extension:// 资源会被拦。
 * 所以 wasm 二进制和模型都由内容脚本取好，用 transferable 一次性塞进去。
 */
'use strict';

const BASE = chrome.runtime.getURL('');
const L = (...a) => console.log('[唤醒词防火墙/桥]', ...a);

let worker = null, ready = false, booting = false, enabled = true;
const queue = [];
const spansBySb = new Map();
let muteCount = 0, pcmCount = 0;

// ---------------------------------------------------------------- Worker

async function bootWorker() {
  if (booting || worker) return;
  booting = true;
  try {
    const cfg = await chrome.storage.local.get(['score', 'threshold', 'enabled', 'keywords', 'muteTail', 'muteLead']);
    if (cfg.enabled === false) { enabled = false; return; }

    const text = (p) => fetch(BASE + p).then(r => r.text());
    const bin = (p) => fetch(BASE + p).then(r => r.arrayBuffer());

    // 引擎：优先用打进包里的，没有再用用户自己装的
    const eng = await WWEngineLoader.load();
    if (!eng) { bannerSetup(); return; }
    L('引擎来源:', eng.source === 'bundled' ? '扩展内置' : '用户安装');
    const glue = eng.glue, wasmBinary = eng.wasm, dataPackage = eng.data;
    const [shim, kwsjs, wsrc, kwFile] = await Promise.all([
      text('src/node-shim.js'), text('vendor/sherpa-onnx-kws.js'),
      text('src/kws-worker.js'), text('keywords.txt'),
    ]);
    // 引擎自带 .data 预加载包时，模型已在里面，不必再单独送
    const models = dataPackage ? null : {
      encoder: await bin('models/encoder.int8.onnx'),
      decoder: await bin('models/decoder.onnx'),
      joiner: await bin('models/joiner.int8.onnx'),
      tokens: await bin('models/tokens.txt'),
    };

    // 胶水不拼进来 —— 官方构建的胶水是「全局 var Module」形态，
    // 必须等 Module 配置好之后再执行，所以改为随消息传入、由 worker 自己 eval
    const blob = new Blob([shim, '\n;\n', kwsjs, '\n;\n', wsrc],
                          { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try { worker = new Worker(url); }
    catch (e) {
      L('创建 Worker 失败（多半是页面 CSP 限制 worker-src）', e && e.message);
      banner('本页无法启用防护：页面安全策略不允许创建检测线程');
      return;
    } finally { URL.revokeObjectURL(url); }

    worker.onerror = (e) => L('Worker 错误:', e.message, (e.filename || '') + ':' + e.lineno);
    worker.onmessage = onWorkerMessage;

    const keywords = (cfg.keywords && cfg.keywords.trim())
      ? cfg.keywords : stripComments(kwFile);

    const transfer = [wasmBinary];
    if (dataPackage) transfer.push(dataPackage);
    if (models) transfer.push(models.encoder, models.decoder, models.joiner, models.tokens);
    worker.postMessage({
      type: 'init', wasmBinary, dataPackage, models, keywords, glue,
      score: cfg.score ?? 2.0, threshold: cfg.threshold ?? 0.25,
      hitLead: cfg.muteLead ?? 1.55, hitTail: cfg.muteTail ?? 0.3,
    }, transfer);
  } catch (e) {
    L('启动失败', e && e.message);
  } finally { booting = false; }
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    ready = true;
    L('检测器就绪，队列', queue.length, '帧');
    while (queue.length) worker.postMessage(...queue.shift());
  } else if (m.type === 'hit') {
    const list = spansBySb.get(m.sbId) || [];
    list.push(m.span);
    spansBySb.set(m.sbId, list);
    toPage({ type: 'ww:timeline', sbId: m.sbId, spans: list });
    muteCount++;
    L(`命中「${m.keyword}」→ 静音 ${m.span[0].toFixed(2)}–${m.span[1].toFixed(2)}s`);
    banner(`已屏蔽唤醒词「${m.keyword}」`, true);
  } else if (m.type === 'config-ok') {
    L(`静音区间已更新：唤醒词前 ${m.hitLead}s / 后 ${m.hitTail}s`);
  } else if (m.type === 'error') {
    L('检测器启动失败:', m.message);
    banner('检测器启动失败：' + m.message);
  }
}

// 设置改动立即下发，不用刷新页面（对后续命中生效）
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !worker) return;
  if (ch.muteTail || ch.muteLead) {
    worker.postMessage({
      type: 'config',
      hitTail: ch.muteTail ? ch.muteTail.newValue : undefined,
      hitLead: ch.muteLead ? ch.muteLead.newValue : undefined,
    });
  }
  if (ch.enabled) enabled = ch.enabled.newValue !== false;
});

function stripComments(t) {
  return t.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join('\n');
}

// ---------------------------------------------------------------- 桥接

function toPage(msg) { window.postMessage(Object.assign({ __wwBack: 1 }, msg), '*'); }

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__ww || e.source !== window) return;

  if (d.type === 'ww:track') {
    bootWorker();                       // 有音频轨才开始加载 20MB 的模型
  } else if (d.type === 'ww:pcm') {
    if (!enabled) return;
    pcmCount++;
    const args = [{ type: 'pcm', sbId: d.sbId, t: d.t, pcm: d.pcm }, [d.pcm]];
    if (ready && worker) worker.postMessage(...args); else queue.push(args);
  } else if (d.type === 'ww:blind') {
    const why = {
      'worker-mse': '这个播放器把 MediaSource 放在 Worker 里，抓不到音频数据',
      'drm': '这是 DRM 保护的内容，音频是密文，无法检测',
    }[d.reason] || ('解码器不支持：' + d.reason.replace('codec:', ''));
    L('失明:', why);
    banner('本页无法防护 —— ' + why);
    chrome.runtime.sendMessage({ type: 'blind', reason: d.reason }).catch(() => {});
  } else if (d.type === 'ww:muted') {
    chrome.runtime.sendMessage({ type: 'muted' }).catch(() => {});
  }
});

// 引擎没装时，给一条能点进引导页的提示 —— 只提示一次，别烦人
let setupShown = false;
function bannerSetup() {
  if (setupShown) return;
  setupShown = true;
  L('引擎未安装，跳过本页');
  if (!document.body) return;
  const el = document.createElement('div');
  el.className = 'ww-banner ww-show';
  el.innerHTML = '<span>唤醒词防火墙还没装检测引擎</span>';
  const b = document.createElement('button');
  b.textContent = '去设置';
  b.onclick = () => {
    chrome.runtime.sendMessage({ type: 'open-welcome' }).catch(() => {});
    el.remove();
  };
  el.appendChild(b);
  document.body.appendChild(el);
  setTimeout(() => el.classList.remove('ww-show'), 8000);
}

// ---------------------------------------------------------------- 提示条

let bannerEl = null, bannerTimer = null;

function banner(text, withUndo) {
  if (!document.body) return;
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'ww-banner';
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  bannerEl.appendChild(span);

  if (withUndo) {
    const b = document.createElement('button');
    b.textContent = '误报，恢复';
    b.onclick = () => {
      const last = [...spansBySb.entries()].pop();
      if (last) {
        last[1].pop();
        toPage({ type: 'ww:timeline', sbId: last[0], spans: last[1] });
      }
      bannerEl.remove(); bannerEl = null;
    };
    bannerEl.appendChild(b);
  }
  bannerEl.classList.add('ww-show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    if (bannerEl) bannerEl.classList.remove('ww-show');
  }, 4000);
}

chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m.type === 'stats') send({ muteCount, tracks: spansBySb.size, enabled });
  return true;
});

setInterval(() => {
  if (pcmCount) { L('转发 PCM', pcmCount, '帧  ready=' + ready); pcmCount = 0; }
}, 5000);
