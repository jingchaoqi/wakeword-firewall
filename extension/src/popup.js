const $ = id => document.getElementById(id);

function hintFor(v) {
  if (v < 0.6) return '只静音唤醒词本身。设备不会醒，但视频里紧跟其后的指令仍会播出。';
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

// ── 按词的统计 ──────────────────────────────────────────────────────
// 本页的数来自 background（它按标签页记账，存 storage.session，
// service worker 被回收也不丢）；历史累计存 storage.local，跨会话保留。
let stats = { tab: { n: 0, words: {}, blind: null }, hist: { words: {}, total: 0 } };
let which = 'page';

const BLIND_WHY = {
  'worker-mse': '播放器把 MediaSource 放在 Worker 里，抓不到音频数据',
  'drm': 'DRM 保护的内容，音频是密文，解不出来',
};

function paintWords() {
  const src = which === 'page' ? stats.tab.words : stats.hist.words;
  const rows = Object.entries(src || {}).sort((a, b) => b[1] - a[1]);
  const box = $('words');
  box.textContent = '';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'none';
    p.textContent = which === 'page'
      ? '这一页还没拦到唤醒词。' : '还没有拦到过唤醒词。';
    box.appendChild(p);
    return;
  }
  for (const [w, n] of rows) {
    const d = document.createElement('div');
    d.className = 'w' + (which === 'hist' ? ' hist' : '');
    const k = document.createElement('span');
    k.className = 'k'; k.textContent = w; k.title = w;
    const v = document.createElement('span');
    v.className = 'v'; v.textContent = n + ' 次';
    d.append(k, v);
    box.appendChild(d);
  }
}

function selectTab(w) {
  which = w;
  $('tabpage').classList.toggle('on', w === 'page');
  $('tabhist').classList.toggle('on', w === 'hist');
  paintWords();
}
$('tabpage').onclick = () => selectTab('page');
$('tabhist').onclick = () => selectTab('hist');

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 本页计数以 background 为准：内容脚本那份是它自己的内存，
  // 而 background 记的账才是徽标显示的那个数，两处得一致。
  try {
    stats = await chrome.runtime.sendMessage({ type: 'stats', tabId: tab.id }) || stats;
  } catch { /* SW 还没起来 */ }
  paintWords();

  if (stats.tab.blind) {
    $('blindnote').classList.add('on');
    $('blindnote').textContent = '本页有内容挡不住：' +
      (BLIND_WHY[stats.tab.blind] ||
       ('Chrome 解不了这个音频编码（' + String(stats.tab.blind).replace('codec:', '') + '）'));
  }

  // 总开关的实际状态以页面上的内容脚本为准（可能刚被别处改过）；
  // 连不上就退回 storage 里那份，下面几行会补上。
  try {
    const live = await chrome.tabs.sendMessage(tab.id, { type: 'stats' });
    $('on').checked = live.enabled;
  } catch { /* 这个页面没有内容脚本，比如 chrome:// 页 */ }

  const cfg = await chrome.storage.local.get(
    ['keywords', 'enabled', 'muteTail', 'showBanner', 'showBlind', 'uiAccent', 'uiTheme']);
  $('kw').value = cfg.keywords ||
    await fetch(chrome.runtime.getURL('keywords.txt')).then(r => r.text());
  if (cfg.enabled === false) $('on').checked = false;
  // 默认开：第一次用的人需要看到「它真的在工作」，否则会以为没生效
  $('banner').checked = cfg.showBanner !== false;
  paintBanner();
  // 默认关，见 content.js 里那段注释：图标角上的叹号已经在说这件事了
  $('blind').checked = cfg.showBlind === true;
  paintSkin({ uiAccent: cfg.uiAccent, uiTheme: cfg.uiTheme });
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

// ── 外观 ────────────────────────────────────────────────────────────
// 面板和页面上的提示条共用一套设置。这里改完立刻写进 storage，
// 内容脚本监听着 onChanged，页面上的提示条会跟着变，不用刷新。
const TH = window.WWTheme;

function paintSkin(cfg) {
  const p = TH.applyTo(document.documentElement, cfg);
  const i = TH.ORDER.indexOf(p.key);
  $('op').value = String(i);
  // 选中的那一档直接在滑杆下方高亮，不再单独占一行显示「当前是哪档」
  [...$('ticks').children].forEach((el, k) => el.classList.toggle('on', k === i));
  $('bg').value = TH.normHex(cfg && cfg.uiAccent);
}

function saveSkin() {
  const v = {
    uiAccent: TH.normHex($('bg').value),
    uiTheme: TH.ORDER[Number($('op').value)] || TH.DEFAULTS.uiTheme,
  };
  paintSkin(v);
  chrome.storage.local.set(v);
}
$('op').oninput = saveSkin;
$('bg').oninput = saveSkin;

$('skinreset').onclick = async () => {
  // 删掉键而不是写回默认值：默认值以后要是调了，用户不用再点一次「恢复默认」
  await chrome.storage.local.remove(['uiAccent', 'uiTheme']);
  paintSkin({});
};

// 这条提示是固定的，写死在 popup.html 里：图标上那个 ! 跟勾选框无关，
// **始终**会出现。以前按勾选状态显示两句不同的话，读起来像是关掉就没提示了，
// 容易让人以为关掉等于静默失效。
$('blind').onchange = async () => {
  await chrome.storage.local.set({ showBlind: $('blind').checked });
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
