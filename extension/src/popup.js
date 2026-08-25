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

  const cfg = await chrome.storage.local.get(
    ['keywords', 'enabled', 'muteTail', 'showBanner']);
  $('kw').value = cfg.keywords ||
    await fetch(chrome.runtime.getURL('keywords.txt')).then(r => r.text());
  if (cfg.enabled === false) $('on').checked = false;
  // 默认开：第一次用的人需要看到「它真的在工作」，否则会以为没生效
  $('banner').checked = cfg.showBanner !== false;
  paintBanner();
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
// ── 添加唤醒词 ──────────────────────────────────────────────────────
// 词表里存的是模型的 token 序列（x iǎo ài t óng x ué @小爱同学），
// 用户写不出来。这里把中文转好再追加进去。
function addWord() {
  const word = $('addword').value.trim();
  const msg = $('addmsg');
  if (!word) return;

  const cur = $('kw').value;
  if (window.WWText2Token.hasWord(cur, word)) {
    msg.className = 'addmsg bad';
    msg.textContent = `词表里已经有「${word}」了`;
    return;
  }

  const r = window.WWText2Token.convert(word);
  if (!r.ok) {
    msg.className = 'addmsg bad';
    msg.innerHTML = r.error === 'EMPTY' ? '请输入内容'
      : `转换不了：${r.bad.map(b => `<b>${b.ch}</b>（${b.why}）`).join('、')}`;
    return;
  }

  $('kw').value = (cur.endsWith('\n') || !cur ? cur : cur + '\n') + r.line + '\n';
  $('addword').value = '';
  msg.className = 'addmsg ok';
  // 把转换结果亮出来——用户能看见它变成了什么，出问题时也好自己改
  msg.innerHTML = `已加入「${word}」→ <code>${r.line.split('@')[0].trim()}</code>` +
    '<br>还要点下面的「保存词表」才生效。';
}

$('addbtn').onclick = addWord;
$('addword').onkeydown = (e) => { if (e.key === 'Enter') addWord(); };

$('save').onclick = async () => {
  await chrome.storage.local.set({ keywords: $('kw').value });
  $('save').textContent = '已保存，刷新页面生效';
  $('addmsg').textContent = '';
};
// 「启用防护」的两个方向都需要刷新，但原因不同，说清楚免得用户以为没生效：
//  关 → 后续不再检测，但本页已经排好的静音仍在增益曲线上，撤不掉
//  开 → 检测器要在页面加载时挂 hook，中途打开抓不到已经 append 过的音频
$('on').onchange = async () => {
  const on = $('on').checked;
  await chrome.storage.local.set({ enabled: on });
  $('reloadtext').textContent = on
    ? '已开启，但本页需要刷新才能开始检测'
    : '已关闭，本页已排好的静音需刷新后才撤销';
  $('reload').classList.add('on');
};

$('doreload').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) { chrome.tabs.reload(tab.id); window.close(); }
};

$('guide').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  window.close();
};

$('probe').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') + '#probe' });
  window.close();
};

function paintBanner() {
  $('bannerhint').innerHTML = $('banner').checked
    ? '命中时页面底部弹一条提示，带「误报，恢复」按钮。'
    : '静音照常生效，只是不再弹提示。<b>误报时也就没有一键恢复的入口了</b>，' +
      '工具栏图标上的计数仍会走。';
}
$('banner').onchange = () => {
  paintBanner();
  // 立即生效，不用刷新页面
  chrome.storage.local.set({ showBanner: $('banner').checked });
};
