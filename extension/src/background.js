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

// ── 统计与徽标 ──────────────────────────────────────────────────────
// 所有检测都在页面侧完成，这里不碰音频，只记账。
//
// 为什么不能只用内存：MV3 的 service worker 闲置约 30 秒就被回收，
// 内存里的计数跟着没。而徽标是浏览器状态、活得比 SW 久——于是会出现
// 「徽标显示 5，再命中一次变回 1」。所以账记在 storage.session 里
// （随浏览器会话，不落盘），SW 重启后能接着数。
//
// 历史累计另记在 storage.local，跨会话保留。

const SESS = 'tabStats';          // storage.session: { [tabId]: {n, words, blind} }
const HIST = 'statsAll';          // storage.local:   { words, total, since }

// 事件可能密集到来，读-改-写要串起来，否则并发覆盖会丢计数
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn).catch((e) => {
  console.warn('[唤醒词防火墙] 记账失败', e);
}));

async function getTabStats() {
  const o = await chrome.storage.session.get(SESS);
  return o[SESS] || {};
}

function badgeFor(st) {
  // 一页可能既拦到过词、又有另一条轨是 DRM。两个信号都要留住：
  // 数字是战果，叹号是「这页有一部分没护住」。
  if (st.blind) return { text: st.n ? `${st.n}!` : '!', color: '#9E4526' };
  if (st.n) return { text: String(st.n), color: '#1C6A66' };
  return { text: '', color: '#1C6A66' };
}

async function paint(tabId, st) {
  const b = badgeFor(st);
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
    await chrome.action.setTitle({
      tabId,
      title: st.blind
        ? '唤醒词防火墙：本页有内容挡不住（' + st.blind + '）'
        : st.n ? `唤醒词防火墙：本页已屏蔽 ${st.n} 次` : '唤醒词防火墙',
    });
  } catch (e) { /* 标签页没了 */ }
}

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
  if (m.type === 'stats') {                     // popup 来取数
    (async () => {
      const [all, hist] = await Promise.all([
        getTabStats(),
        chrome.storage.local.get(HIST).then((o) => o[HIST] || { words: {}, total: 0 }),
      ]);
      reply({ tab: all[m.tabId] || { n: 0, words: {}, blind: null }, hist });
    })();
    return true;
  }
  if (m.type === 'reset-hist') {
    chrome.storage.local.set({ [HIST]: { words: {}, total: 0, since: m.now } })
      .then(() => reply({ ok: true }));
    return true;
  }

  const id = sender.tab && sender.tab.id;
  if (!id) return;

  if (m.type === 'muted') {
    // 词可能取不到（老版本内容脚本、或命中与静音没对上），别让统计瘸腿
    const w = m.word || '未知';
    serialize(async () => {
      const all = await getTabStats();
      const st = all[id] || { n: 0, words: {}, blind: null };
      st.n++; st.words[w] = (st.words[w] || 0) + 1;
      all[id] = st;
      await chrome.storage.session.set({ [SESS]: all });

      const o = await chrome.storage.local.get(HIST);
      const h = o[HIST] || { words: {}, total: 0, since: Date.now() };
      h.words[w] = (h.words[w] || 0) + 1;
      h.total++;
      await chrome.storage.local.set({ [HIST]: h });

      await paint(id, st);
    });
  } else if (m.type === 'blind') {
    serialize(async () => {
      const all = await getTabStats();
      const st = all[id] || { n: 0, words: {}, blind: null };
      st.blind = m.reason;
      all[id] = st;
      await chrome.storage.session.set({ [SESS]: all });
      await paint(id, st);
    });
  }
});

// 换页要清零账本。徽标本身 Chrome 会在导航时自己重置（per-tab 的 action 设置
// 就是这个语义，变异测试确认过：把这个监听器整个删掉，「换页后徽标清空」
// 那条断言照样通过）。真正会串的是这里记的数——不清的话，新页面第一次命中
// 会从上一页的数接着往上加，popup 里也还显示着上一页的词频。
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status !== 'loading' || !info.url) return;
  serialize(async () => {
    const all = await getTabStats();
    if (!all[id]) { await paint(id, { n: 0, words: {}, blind: null }); return; }
    delete all[id];
    await chrome.storage.session.set({ [SESS]: all });
    await paint(id, { n: 0, words: {}, blind: null });
  });
});

chrome.tabs.onRemoved.addListener((id) => {
  serialize(async () => {
    const all = await getTabStats();
    if (!all[id]) return;
    delete all[id];
    await chrome.storage.session.set({ [SESS]: all });
  });
});
