// 安装即引导：装完立刻开引导页，别让用户自己找。
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  }
});

// 统计与徽标。所有检测都在页面侧完成，这里不碰音频。
let counts = {};
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m.type === 'open-welcome') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
    return;
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
