/**
 * 统计与徽标
 * ==========
 * 用真实命中来验，不打桩：跑一遍和 e2e 相同的素材（内容里真有「文森特卡索」），
 * 然后查 background 记的账、工具栏徽标、以及换页清零。
 *
 * 另起一个 DRM 页验叹号——DRM 不需要真播出东西，setMediaKeys 一调用就该判定。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { requireChrome, prepareMedia, serve } = require('./util.js');

const EXT = process.env.WW_EXT || path.resolve(__dirname, '..');
const CHROME = requireChrome();
const META = JSON.parse(fs.readFileSync(EXT + '/assets/selftest.json', 'utf8'));
const DIR = process.env.WW_MEDIA || '/tmp/ww-e2e-media';
const NAMES = ['init.m4s', 'seg-1.m4s', 'seg-2.m4s', 'seg-3.m4s',
               'seg-4.m4s', 'seg-5.m4s', 'seg-6.m4s'];

const WORD = META.expect;                       // 「文森特卡索」

function writePages() {
  fs.writeFileSync(DIR + '/st.html',
    '<!doctype html><meta charset=utf-8><title>统计测试页</title>' +
    '<body><audio id=a controls></audio><script src="st.js"></script>');
  fs.writeFileSync(DIR + '/st.js', `
const a=document.getElementById('a'), ms=new MediaSource();
a.src=URL.createObjectURL(ms);
ms.addEventListener('sourceopen',async()=>{
  const sb=ms.addSourceBuffer('audio/webm; codecs="opus"');
  for(const f of ${JSON.stringify(NAMES)}){
    const buf=await (await fetch(f)).arrayBuffer();
    await new Promise(r=>{sb.addEventListener('updateend',r,{once:true});sb.appendBuffer(buf)});
  }
  ms.endOfStream();
  window.__appended=true;
  for(let i=0;i<200&&!window.__wwGain;i++) await new Promise(r=>setTimeout(r,50));
  try{ await a.play(); }catch(e){}
});
`);
  // 空白页，用来验换页清零
  fs.writeFileSync(DIR + '/blank.html', '<!doctype html><meta charset=utf-8><title>空</title><body>空');
  // DRM 页
  fs.writeFileSync(DIR + '/drm.html',
    '<!doctype html><meta charset=utf-8><title>DRM 页</title>' +
    '<body><video id=v></video><script src="drm.js"></script>');
  fs.writeFileSync(DIR + '/drm.js', `
(async () => {
  const v = document.getElementById('v');
  try {
    const ks = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{
      initDataTypes: ['keyids'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
    }]);
    await v.setMediaKeys(await ks.createMediaKeys());
  } catch (e) {}
  window.__drmDone = true;
})();
`);
}

(async () => {
  await prepareMedia({ chrome: CHROME, wav: EXT + '/assets/selftest.wav', dir: DIR, names: NAMES });
  writePages();
  const srv = serve(DIR);
  const checks = [];
  const push = (n, ok) => checks.push([n, ok]);

  const ctx = await chromium.launchPersistentContext('/tmp/ww-stats-' + Date.now(), {
    headless: true,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
  });
  const [sw] = ctx.serviceWorkers().length
    ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
  const id = new URL(sw.url()).host;

  // 词表换成素材里真有的那个词
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${id}/src/welcome.html`);
  await ext.evaluate(async (kw) => {
    await chrome.storage.local.set({ keywords: kw, enabled: true });
  }, META.keywords);

  // 从干净的历史开始，否则同一个 profile 跑两次数字会叠
  await ext.evaluate(async () => {
    await chrome.storage.local.remove('statsAll');
    await chrome.storage.session.clear();
  });

  // ── 1. 真播一遍，等命中 ──────────────────────────────────────────
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8848/st.html');
  await page.waitForFunction(() => window.__appended === true, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(22000);

  const tabId = await ext.evaluate(async () => {
    const ts = await chrome.tabs.query({});
    const t = ts.find(x => (x.url || '').includes('st.html'));
    return t ? t.id : null;
  });
  push('找得到测试标签页', tabId !== null);

  const read = () => ext.evaluate(async (tid) => {
    const s = await chrome.storage.session.get('tabStats');
    const l = await chrome.storage.local.get('statsAll');
    return {
      tab: (s.tabStats || {})[tid] || null,
      hist: l.statsAll || null,
      badge: await chrome.action.getBadgeText({ tabId: tid }),
      title: await chrome.action.getTitle({ tabId: tid }),
    };
  }, tabId);

  const r = await read();
  push('本页记到了屏蔽次数', !!r.tab && r.tab.n >= 1);
  push(`本页按词统计到「${WORD}」`, !!r.tab && r.tab.words && r.tab.words[WORD] >= 1);
  push('没有落进「未知」桶（命中与静音对上了）', !!r.tab && !r.tab.words['未知']);
  push('徽标显示的就是这个次数', r.badge === String(r.tab && r.tab.n));
  push('悬停提示带上了次数', /已屏蔽 \d+ 次/.test(r.title || ''));
  push('历史累计也记了同一个词', !!r.hist && r.hist.words[WORD] >= 1);
  push('历史总数与按词之和一致',
    !!r.hist && r.hist.total === Object.values(r.hist.words).reduce((a, b) => a + b, 0));

  // ── 2. 换页要清零 ────────────────────────────────────────────────
  await page.goto('http://127.0.0.1:8848/blank.html');
  await page.waitForTimeout(2500);
  const r2 = await read();
  push('换页后本页计数清零', !r2.tab || r2.tab.n === 0);
  push('换页后徽标也清空', r2.badge === '');
  const histKept = await ext.evaluate(async () =>
    (await chrome.storage.local.get('statsAll')).statsAll);
  push('换页不影响历史累计', !!histKept && histKept.words[WORD] >= 1);

  // ── 3. DRM 页要出叹号 ────────────────────────────────────────────
  const drm = await ctx.newPage();
  await drm.goto('http://127.0.0.1:8848/drm.html');
  await drm.waitForFunction(() => window.__drmDone === true, null, { timeout: 15000 }).catch(() => {});
  await drm.waitForTimeout(2500);
  const d = await ext.evaluate(async () => {
    const ts = await chrome.tabs.query({});
    const t = ts.find(x => (x.url || '').includes('drm.html'));
    if (!t) return null;
    const s = await chrome.storage.session.get('tabStats');
    return {
      st: (s.tabStats || {})[t.id] || null,
      badge: await chrome.action.getBadgeText({ tabId: t.id }),
      title: await chrome.action.getTitle({ tabId: t.id }),
    };
  });
  push('DRM 被识别为「挡不住」', !!d && d.st && d.st.blind === 'drm');
  push('徽标角上出现叹号', !!d && d.badge === '!');
  push('悬停提示说明了原因', !!d && /挡不住/.test(d.title || ''));

  // ── 4. DRM 页默认不弹页面提示 ────────────────────────────────────
  const banner = await drm.$eval('.ww-banner', el => el.textContent).catch(() => '');
  push('默认不在页面上弹「本页无法防护」', !/本页无法防护/.test(banner));

  // 打开开关后应该弹
  await ext.evaluate(async () => chrome.storage.local.set({ showBlind: true }));
  const drm2 = await ctx.newPage();
  await drm2.goto('http://127.0.0.1:8848/drm.html');
  await drm2.waitForFunction(() => window.__drmDone === true, null, { timeout: 15000 }).catch(() => {});
  await drm2.waitForTimeout(2500);
  const banner2 = await drm2.$eval('.ww-banner', el => el.textContent).catch(() => '');
  push('打开开关后就会弹', /本页无法防护/.test(banner2));

  // ── 5. 设置面板真打开一次 ────────────────────────────────────────
  // popup 之前零覆盖，而它是用户唯一会反复打开的界面。这里只验它能起来、
  // 统计画得出、以及那两条容易被改回去的文案。
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${id}/src/popup.html`);
  await pop.waitForTimeout(1200);
  const pe = await pop.evaluate(() => ({
    err: window.__err || null,
    blindLabel: (document.querySelector('#blind') || {}).parentElement
      ? document.querySelector('#blind').parentElement.textContent.trim() : '',
    hints: [...document.querySelectorAll('.hint')].map(e => e.textContent.trim()),
    tabs: [...document.querySelectorAll('.tabs button')].map(e => e.textContent.trim()),
    rows: document.querySelectorAll('.row').length,
    blindChecked: (document.querySelector('#blind') || {}).checked,
  }));
  push('设置面板打得开', !!pe.blindLabel);
  push('开关文案是「当前页不支持拦截唤醒词时显示悬浮提示」',
    /当前页不支持拦截唤醒词时显示悬浮提示/.test(pe.blindLabel));
  push('说明写明图标标记与开关无关',
    pe.hints.some(h => /无论悬浮提示是否开启/.test(h) && /标记当前页不支持/.test(h)));
  push('说明里不再暗示关掉就没提示',
    !pe.hints.some(h => /默认不弹|不必每次都被页面打断/.test(h)));
  push('两栏标题是「本页屏蔽统计 / 历史屏蔽统计」',
    JSON.stringify(pe.tabs) === JSON.stringify(['本页屏蔽统计', '历史屏蔽统计']));
  push('去掉了「本页已屏蔽 / 监听中的音频轨」两行', pe.rows === 0);

  // ── 6. 外观：改了要即时生效，且能一键恢复 ────────────────────────
  const skin0 = await pop.evaluate(() => ({
    op: document.getElementById('op').value,
    bg: document.getElementById('bg').value,
    rootBg: getComputedStyle(document.documentElement).getPropertyValue('--ww-bg').trim(),
  }));
  push('外观控件读到了默认值', skin0.bg === '#16181c' && Number(skin0.op) === 0.95);

  // 选一个浅色背景，文字色该自动翻成深色
  await pop.evaluate(() => {
    const b = document.getElementById('bg');
    b.value = '#ffffff'; b.dispatchEvent(new Event('input'));
    const o = document.getElementById('op');
    o.value = '0.5'; o.dispatchEvent(new Event('input'));
  });
  await pop.waitForTimeout(400);
  const skin1 = await pop.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--ww-bg').trim(),
      fg: cs.getPropertyValue('--ww-fg').trim(),
      op: cs.getPropertyValue('--ww-op').trim(),
      label: document.getElementById('opv').textContent,
    };
  });
  push('换背景色即时生效', skin1.bg === '#ffffff');
  push('浅底自动换成深色文字（不会调出看不清的配色）', skin1.fg === '#1a1c20');
  push('透明度即时生效', skin1.op === '0.5' && skin1.label === '50%');

  const persisted = await ext.evaluate(async () =>
    await chrome.storage.local.get(['uiBg', 'uiOpacity']));
  push('外观设置存下来了', persisted.uiBg === '#ffffff' && persisted.uiOpacity === 0.5);

  await pop.click('#skinreset');
  await pop.waitForTimeout(400);
  const skin2 = await pop.evaluate(() => ({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--ww-bg').trim(),
    op: document.getElementById('op').value,
  }));
  push('一键恢复默认', skin2.bg === '#16181c' && Number(skin2.op) === 0.95);
  const cleared = await ext.evaluate(async () =>
    Object.keys(await chrome.storage.local.get(['uiBg', 'uiOpacity'])).length);
  push('恢复默认是删键而不是写死值', cleared === 0);

  // ── 7. 外观要真的传到页面上那条提示条 ────────────────────────────
  // 面板里改完就该生效，不用刷新页面——这才是这个功能的用处所在。
  // 只验面板自己会变的话，等于没验。
  await ext.evaluate(async () =>
    chrome.storage.local.set({ uiBg: '#ffffff', uiOpacity: 0.6, showBlind: true }));
  const drm3 = await ctx.newPage();
  await drm3.goto('http://127.0.0.1:8848/drm.html');
  await drm3.waitForFunction(() => window.__drmDone === true, null, { timeout: 15000 }).catch(() => {});
  await drm3.waitForTimeout(2500);
  const bn = await drm3.evaluate(() => {
    const el = document.querySelector('.ww-banner');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, opacity: cs.opacity };
  });
  push('提示条用上了用户选的背景色', !!bn && bn.bg === 'rgb(255, 255, 255)');
  push('提示条文字跟着翻成深色', !!bn && bn.color === 'rgb(26, 28, 32)');
  push('提示条用上了用户设的透明度', !!bn && Math.abs(Number(bn.opacity) - 0.6) < 0.01);
  if (bn) await drm3.screenshot({ path: '/tmp/ww-banner-custom.png' });

  // 改回默认，确认也是即时的（内容脚本监听 onChanged，不是只在启动时读一次）
  await ext.evaluate(async () => chrome.storage.local.remove(['uiBg', 'uiOpacity']));
  await drm3.waitForTimeout(800);
  const bn2 = await drm3.evaluate(() => {
    const el = document.querySelector('.ww-banner');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  push('恢复默认后提示条不用刷新就变回去', bn2 === 'rgb(22, 24, 28)');

  console.log('\n============ 统计与徽标 ============');
  for (const [n, ok] of checks) console.log(`  ${ok ? '✅' : '❌'}  ${n}`);
  if (!checks.every(c => c[1])) {
    console.log('\n  本页: ' + JSON.stringify(r.tab));
    console.log('  历史: ' + JSON.stringify(r.hist));
    console.log('  徽标: ' + JSON.stringify(r.badge) + '  DRM: ' + JSON.stringify(d));
  }
  await ctx.close();
  srv.close();
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})();
