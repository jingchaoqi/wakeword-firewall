/**
 * ISOLATED world 内容脚本 —— 中间人
 * ================================
 *  - 页面上真的出现音频轨时，才起 Worker 跑唤醒词检测
 *  - 在页面（MAIN world）与 Worker 之间转发 PCM 和时间戳表
 *  - 画一个极简提示条：刚刚拦了什么、一键撤销
 *
 * 检测**不在这里**跑，在 offscreen 文档里跑。原因是源和 CSP：
 * 内容脚本建的 Worker 继承页面的源，大站的 script-src 'self' 会把
 * blob worker 里的 eval 拦死，而扩展 URL 建 worker 又跨源被拦——两条路
 * 全死（已实测）。offscreen 是扩展源，不受页面 CSP 管。
 * 这里只剩一件事：把 PCM 转过去，把时间戳表转回来。
 */
'use strict';

const BASE = chrome.runtime.getURL('');
const L = (...a) => console.log('[唤醒词防火墙/桥]', ...a);

let port = null, ready = false, booting = false, enabled = true;
const queue = [];
const spansBySb = new Map();
let muteCount = 0, pcmCount = 0;

// ---------------------------------------------------------------- Worker

function i16ToB64(ab) {
  const u8 = new Uint8Array(ab);
  let bin = '';
  const CH = 0x8000;                       // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}

async function bootWorker() {
  if (booting || port) return;
  booting = true;
  try {
    const cfg = await chrome.storage.local.get(
      ['enabled', 'score', 'threshold', 'keywords', 'muteTail', 'muteLead']);
    if (cfg.enabled === false) { enabled = false; return; }

    // 宿主拿不到 chrome.storage，配置在这边读好一起送过去
    const kwFile = await fetch(BASE + 'keywords.txt').then(r => r.text());
    const detCfg = {
      keywords: (cfg.keywords && cfg.keywords.trim()) ? cfg.keywords : stripComments(kwFile),
      score: cfg.score ?? 2.0,
      threshold: cfg.threshold ?? 0.25,
      hitLead: cfg.muteLead ?? 1.55,
      hitTail: cfg.muteTail ?? 0.3,
    };

    // 先让 service worker 把 offscreen 文档建起来，再连过去
    const r = await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
    if (!r || !r.ok) throw new Error(r && r.error || '宿主没起来');

    port = chrome.runtime.connect({ name: 'ww-detect' });
    port.onMessage.addListener((m) => onWorkerMessage({ data: m }));
    port.onDisconnect.addListener(() => {
      L('与宿主的连接断了');
      port = null; ready = false;
    });
    port.postMessage({ type: 'start', cfg: detCfg });
  } catch (e) {
    L('启动失败', e && e.message);
    if (/NO_ENGINE/.test(String(e && e.message))) bannerSetup();
    else banner('检测器启动失败：' + (e && e.message));
  } finally { booting = false; }
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    ready = true;
    L('检测器就绪，队列', queue.length, '帧');
    while (queue.length) port.postMessage(queue.shift());
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
    if (/ENGINE_NOT_BUNDLED/.test(m.message)) {
      banner('检测引擎没打进扩展包，本页无法防护（跑 tools/embed-engine.sh）');
    } else if (/NO_ENGINE/.test(m.message)) {
      bannerSetup();
    } else {
      banner('检测器启动失败：' + m.message);
    }
  }
}

// 设置改动立即下发，不用刷新页面（对后续命中生效）
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !port) return;
  if (ch.muteTail || ch.muteLead) {
    port.postMessage({
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
    // chrome.runtime 的消息走 JSON 序列化，ArrayBuffer 传过去会变成 {}（实测），
    // 所以这里必须编码。base64 让 2560 字节变 3416 字符，约 43 KB/s。
    const msg = { type: 'pcm', sbId: d.sbId, t: d.t, b64: i16ToB64(d.pcm) };
    if (ready && port) port.postMessage(msg); else queue.push(msg);
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
