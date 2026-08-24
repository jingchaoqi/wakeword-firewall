const $ = id => document.getElementById(id);

function hintFor(v) {
  if (v < 0.6) return '只静音唤醒词本身。设备不会醒，但视频里紧跟其后的指令仍会播出——' +
                     '如果那句指令被<b>别的</b>设备听到，仍可能被执行。';
  if (v < 3)   return '连唤醒词后约 ' + v + ' 秒一起静音，能挡掉「打开灯」这类短指令。';
  return '连唤醒词后 ' + v + ' 秒一起静音，几乎能挡住所有指令注入。' +
         '代价是每次命中会多切掉一段正常内容。';
}

function paint(v) {
  $('tail').value = v;
  $('tailv').textContent = v + 's';
  $('tailhint').innerHTML = hintFor(v);
  for (const b of document.querySelectorAll('.presets button'))
    b.classList.toggle('on', Math.abs(+b.dataset.v - v) < 0.05);
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'stats' });
    $('c').textContent = s.muteCount; $('t').textContent = s.tracks;
    $('on').checked = s.enabled;
  } catch { $('c').textContent = '–'; $('t').textContent = '–'; }

  const cfg = await chrome.storage.local.get(['keywords', 'enabled', 'muteTail']);
  $('kw').value = cfg.keywords ||
    await fetch(chrome.runtime.getURL('keywords.txt')).then(r => r.text());
  if (cfg.enabled === false) $('on').checked = false;
  paint(cfg.muteTail ?? 0.3);
})();

$('tail').oninput = () => {
  const v = Math.round(+$('tail').value * 10) / 10;
  paint(v);
  chrome.storage.local.set({ muteTail: v });      // 立即生效，无需刷新
};
for (const b of document.querySelectorAll('.presets button')) {
  b.onclick = () => {
    const v = +b.dataset.v;
    paint(v);
    chrome.storage.local.set({ muteTail: v });
  };
}
$('save').onclick = async () => {
  await chrome.storage.local.set({ keywords: $('kw').value });
  $('save').textContent = '已保存，刷新页面生效';
};
$('on').onchange = () => chrome.storage.local.set({ enabled: $('on').checked });
