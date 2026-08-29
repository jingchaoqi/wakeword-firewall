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
// 命中时弹不弹提示。只管「已屏蔽 XXX」那一条——
// 失败类提示（抓不到音频、检测器起不来）不受它控制，那些是必须让人知道的。
let showBanner = true;
// 「本页挡不住」那条提示的开关。它必须**独立于 bootWorker** 读：
// 失明信号可能比检测器起得还早（DRM 是 setMediaKeys 一调用就报），
// 而 enabled=false 时 bootWorker 直接 return，根本读不到配置——
// 跟着 bootWorker 走的话，这个开关在 DRM 页上等于没有。
// 默认**关**：挡不住这件事已经由工具栏图标角上的叹号在说了，页面上再弹一条
// 就是重复打扰——而 DRM 站（Netflix 等）每次进都会触发，很烦。想要页面提示
// 的人去设置面板打开。注意这跟「静默失效」是两回事：徽标始终会变。
let showBlind = false;
const uiCfg = chrome.storage.local.get(['showBanner', 'showBlind'])
  .then((c) => { showBanner = c.showBanner !== false; showBlind = c.showBlind === true; })
  .catch(() => {});
const queue = [];
const spansBySb = new Map();
const wordBySpan = new Map();
const spanKey = (sp) => sp[0].toFixed(3) + ':' + sp[1].toFixed(3);
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
      ['enabled', 'score', 'threshold', 'keywords', 'muteTail', 'muteLead', 'showBanner']);
    if (cfg.enabled === false) { enabled = false; return; }
    showBanner = cfg.showBanner !== false;

    // 宿主拿不到 chrome.storage，配置在这边读好一起送过去
    const kwFile = await fetch(BASE + 'keywords.txt').then(r => r.text());
    const detCfg = {
      // 两边都要 stripComments：用户在设置面板里存下的那份是**连注释一起**存的
      // （面板加载时把 keywords.txt 原样灌进文本框，加完词点保存就整份存回去）。
      // 引擎按 `#` 切单词阈值，`# 唤醒词表 ——` 这种整行注释会让它 stof 抛异常，
      // 检测器直接起不来——而自检页读的是内置文件，照样显示通过。实测踩过。
      keywords: stripComments(
        (cfg.keywords && cfg.keywords.trim()) ? cfg.keywords : kwFile),
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
    // 统计要按词分。命中消息带着词，而「真的静音了」是 MAIN world 那边
    // 播到时才报的另一条消息，只带 span——用 span 把两者对起来。
    wordBySpan.set(spanKey(m.span), m.keyword);
    toPage({ type: 'ww:timeline', sbId: m.sbId, spans: list });
    muteCount++;
    L(`命中「${m.keyword}」→ 静音 ${m.span[0].toFixed(2)}–${m.span[1].toFixed(2)}s`);
    if (showBanner) banner(`已屏蔽唤醒词「${m.keyword}」`, true);
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
  if (area !== 'local') return;
  // showBanner / showBlind / enabled 跟检测器无关，没连上宿主时也要能改
  if (ch.showBanner) showBanner = ch.showBanner.newValue !== false;
  if (ch.showBlind) showBlind = ch.showBlind.newValue === true;
  if (ch.enabled) enabled = ch.enabled.newValue !== false;
  if (!port) return;
  if (ch.muteTail || ch.muteLead) {
    port.postMessage({
      type: 'config',
      hitTail: ch.muteTail ? ch.muteTail.newValue : undefined,
      hitLead: ch.muteLead ? ch.muteLead.newValue : undefined,
    });
  }
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
    // 徽标照常变「—」，跟提示条开关无关：关掉的只是页面上的打扰，
    // 不是「让用户以为还在保护」。静默失效是这个项目最不能出的错。
    chrome.runtime.sendMessage({ type: 'blind', reason: d.reason }).catch(() => {});
    // 等配置读完再决定弹不弹，否则抢在 storage 返回之前就按默认值弹了
    uiCfg.then(() => { if (showBlind) banner('本页无法防护 —— ' + why); });
  } else if (d.type === 'ww:muted') {
    const word = wordBySpan.get(spanKey(d.span));
    chrome.runtime.sendMessage({ type: 'muted', word }).catch(() => {});
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
  // 内容脚本是 document_start 注入的，检测器起不来这类错误往往在 <body> 之前
  // 就发生了。以前这里直接 return，于是最该看见的那条提示恰好总被丢掉——
  // 用户看到的是「什么都没发生」。改成排队等 body。
  if (!document.body) {
    document.addEventListener('DOMContentLoaded',
      () => banner(text, withUndo), { once: true });
    return;
  }
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
