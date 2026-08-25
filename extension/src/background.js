// 安装即引导：装完立刻开引导页，别让用户自己找。
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});

// ── offscreen 检测宿主 ──────────────────────────────────────────────
// 检测不能放在内容脚本里：它建的 Worker 继承页面的源和 CSP，大站的
// script-src 'self' 会把 eval 和 blob importScripts 全拦死（已实测）。
// offscreen 文档是扩展源，不受页面 CSP 管，是唯一走得通的宿主。
// 全扩展只能有一个，所以这里只负责「确保它存在」，多标签页由它自己分流。
let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('src/offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url],
  });
  if (existing.length) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url,
    reasons: ['WORKERS'],
    justification: '在扩展源里跑唤醒词检测 Worker——内容脚本受页面 CSP 限制起不来',
  }).catch((e) => {
    // 并发调用时可能已经被别的请求建好了，这种失败可以忽略
    if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
  }).finally(() => { creating = null; });
  return creating;
}

// 统计与徽标。所有检测都在页面侧完成，这里不碰音频。
let counts = {};
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === 'open-welcome') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    return;
  }
  if (m.type === 'ensure-offscreen') {
    // 必须 return true 让通道保持开着，等异步建完再回复
    ensureOffscreen().then(() => reply({ ok: true }))
                     .catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  const id = sender.tab && sender.tab.id;
  if (!id) return;
  if (m.type === 'muted') {
    counts[id] = (counts[id] || 0) + 1;
    chrome.action.setBadgeText({ tabId: id, text: String(counts[id]) });
    chrome.action.setBadgeBackgroundColor({ tabId: id, color: '#1C6A66' });
  } else if (m.type === 'blind') {
    chrome.action.setBadgeText({ tabId: id, text: '—' });
    chrome.action.setBadgeBackgroundColor({ tabId: id, color: '#9E4526' });
  }
});
chrome.tabs.onRemoved.addListener(id => { delete counts[id]; });
