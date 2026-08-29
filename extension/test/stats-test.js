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

  // ── 0. 出厂词表能不能被引擎吃下 ──────────────────────────────────
  // 下面的测试会把词表换成素材里那个词，e2e 也一样——所以**没有任何测试**
  // 碰过随包发布的 keywords.txt。而「词表里混进引擎解析不了的东西导致检测器
  // 起不来」正是这个项目踩过的坑（当时是整行注释）。往词表加词更要验这条。
  // 这里不设 keywords，让内容脚本回落到内置词表，只看检测器起没起来。
  {
    const probe = await ctx.newPage();
    const logs = [];
    probe.on('console', (m) => logs.push(m.text()));
    await probe.goto('http://127.0.0.1:8848/st.html');
    await probe.waitForFunction(() => window.__appended === true, null, { timeout: 30000 })
      .catch(() => {});
    await probe.waitForFunction(
      () => true, null, { timeout: 100 }).catch(() => {});
    for (let i = 0; i < 60 && !logs.some(l => /检测器就绪|检测器启动失败/.test(l)); i++)
      await probe.waitForTimeout(500);
    const ready = logs.some(l => /检测器就绪/.test(l));
    const failed = logs.filter(l => /检测器启动失败/.test(l));
    push('出厂词表能被引擎加载（检测器起得来）', ready && !failed.length);
    if (failed.length) console.log('  启动失败: ' + failed[0]);
    await probe.close();
  }

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
    noVal: !document.getElementById('opv'),
    // 「外观」标题之后、「唤醒词表」标题之前，不该再有 .hint
    skinHints: (() => {
      const hs = [...document.querySelectorAll('h2')];
      const a = hs.find(h => h.textContent.includes('外观'));
      const b = hs.find(h => h.textContent.includes('唤醒词表'));
      if (!a || !b) return -1;
      let n = 0;
      for (let el = a.nextElementSibling; el && el !== b; el = el.nextElementSibling)
        if (el.classList.contains('hint')) n++;
      return n;
    })(),
    sub: (document.querySelector('.sub') || {}).textContent || '',
    gh: (document.querySelector('.foot a[href]') || {}).href || '',
    blindChecked: (document.querySelector('#blind') || {}).checked,
  }));
  push('设置面板打得开', !!pe.blindLabel);
  push('开关文案是「当前页不支持拦截唤醒词时显示悬浮提示」',
    /当前页不支持拦截唤醒词时显示悬浮提示/.test(pe.blindLabel));
  push('说明写明图标标记与开关无关',
    pe.hints.some(h => /无论悬浮提示是否开启/.test(h) && /标记当前页不支持/.test(h)));
  push('说明里不再暗示关掉就没提示',
    !pe.hints.some(h => /默认不弹|不必每次都被页面打断/.test(h)));
  push('顶部有产品标语', /让家里的智能音箱不再被评测视频意外唤醒/.test(pe.sub));
  push('标语保留了「不产生网络通信」', /全程本地运行，不产生网络通信/.test(pe.sub));
  push('面板底部有 GitHub 链接', pe.gh === 'https://github.com/jingchaoqi/wakeword-firewall');
  push('两栏标题是「本页屏蔽统计 / 历史屏蔽统计」',
    JSON.stringify(pe.tabs) === JSON.stringify(['本页屏蔽统计', '历史屏蔽统计']));
  push('去掉了「本页已屏蔽 / 监听中的音频轨」两行', pe.rows === 0);

  // ── 6. 外观：改了要即时生效，且能一键恢复 ────────────────────────
  const readSkin = () => pop.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      idx: document.getElementById('op').value,
      // 「当前是哪档」现在只由滑杆下方高亮的那个档位名表示
      label: (document.querySelector('.ticks span.on') || {}).textContent || '',
      tickOn: [...document.querySelectorAll('.ticks span')].map(e => e.classList.contains('on')),
      accentInput: document.getElementById('bg').value,
      panel: cs.getPropertyValue('--ww-panel').trim(),
      fg: cs.getPropertyValue('--ww-fg').trim(),
      accent: cs.getPropertyValue('--ww-accent').trim(),
      ticks: [...document.querySelectorAll('.ticks span')].map(e => e.textContent.trim()),
    };
  });

  const skin0 = await readSkin();
  push('默认是月白档', skin0.label === '月白' && skin0.idx === '0');
  push('默认强调色是青绿', skin0.accentInput === '#5cbdb5');
  push('三档的名字都在', JSON.stringify(skin0.ticks) === JSON.stringify(['月白', '烟霭', '玄墨']));
  push('只有选中那档被高亮', skin0.tickOn.filter(Boolean).length === 1 && skin0.tickOn[0]);
  push('不再单独显示「当前档位」', pe.noVal);
  push('外观那节没有多余说明文字', pe.skinHints === 0);
  push('底色是纯色，不再是半透明', /^#|^rgb\(/.test(skin0.panel) && !/rgba/.test(skin0.panel));

  // 逐档切过去，每档都要保证文字读得出来
  const seen = [];
  for (const [i, want] of [[0, '月白'], [1, '烟霭'], [2, '玄墨']]) {
    await pop.evaluate((v) => {
      const o = document.getElementById('op');
      o.value = String(v); o.dispatchEvent(new Event('input'));
    }, i);
    await pop.waitForTimeout(250);
    const k = await readSkin();
    const c = await pop.evaluate(([fg, bg]) => {
      const lum = (h) => {
        const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
          .map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      const a = lum(fg), b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, [k.fg, k.panel]);
    seen.push({ name: k.label, fg: k.fg, bg: k.panel, contrast: +c.toFixed(1) });
    push(`${want}：档名对得上`, k.label === want);
    push(`${want}：文字对比度达到 WCAG AA（实测 ${c.toFixed(1)}）`, c >= 4.5);
  }
  // 米白档绝不能用白字——这是这次改动最容易做错的地方
  push('月白档没有用浅色字', seen[0].fg !== '#e9e7e2' && seen[0].fg !== '#ffffff');

  // 「本页不支持」那条提示：三档下都得读得清。
  // 它以前写死了深色底 #33211A，而文字色跟着主题走——月白档下就是深底深字，
  // 整段看不见。做成断言，别再靠肉眼发现。
  await ext.evaluate(async () => {
    const s = await chrome.storage.session.get('tabStats');
    const all = s.tabStats || {};
    all[-1] = { n: 0, words: {}, blind: 'drm' };
    await chrome.storage.session.set({ tabStats: all });
  });
  for (const [i, name] of [[0, '月白'], [1, '烟霭'], [2, '玄墨']]) {
    await pop.evaluate((v) => {
      const o = document.getElementById('op');
      o.value = String(v); o.dispatchEvent(new Event('input'));
    }, i);
    await pop.waitForTimeout(200);
    const b = await pop.evaluate(() => {
      const el = document.getElementById('blindnote');
      el.classList.add('on');
      el.textContent = '本页有内容挡不住：DRM 保护的内容，音频是密文，解不出来';
      const cs = getComputedStyle(el);
      const rgb = (c) => (c.match(/\d+/g) || []).slice(0, 3).map(Number);
      const lum = (v) => { const x = v.map(n => { const c = n / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
        return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]; };
      // 背景是 transparent 时取面板底色，那才是肉眼看到的
      let bg = rgb(cs.backgroundColor);
      if (!bg.length || /rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor))
        bg = rgb(getComputedStyle(document.body).backgroundColor);
      const a = lum(rgb(cs.color)), c = lum(bg);
      return { contrast: (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05),
               bgDecl: cs.backgroundColor };
    });
    push(`${name}：不支持提示读得清（对比度 ${b.contrast.toFixed(1)}）`, b.contrast >= 4.5);
    if (i === 0) push('不支持提示不再有自己的底色', /rgba\(0, 0, 0, 0\)/.test(b.bgDecl));
  }

  // 强调色：挑一个跟玄墨底色撞的深色，应该被自动拉开
  await pop.evaluate(() => {
    const b = document.getElementById('bg');
    b.value = '#16181c'; b.dispatchEvent(new Event('input'));
  });
  await pop.waitForTimeout(300);
  const clash = await readSkin();
  push('强调色撞底色时自动拉开', clash.accent !== '#16181c');

  await pop.evaluate(() => {
    const b = document.getElementById('bg');
    b.value = '#e06c9f'; b.dispatchEvent(new Event('input'));
  });
  await pop.waitForTimeout(300);
  const persisted = await ext.evaluate(async () =>
    await chrome.storage.local.get(['uiAccent', 'uiTheme']));
  push('外观设置存下来了', persisted.uiAccent === '#e06c9f' && persisted.uiTheme === 'ink');

  await pop.click('#skinreset');
  await pop.waitForTimeout(400);
  const skin2 = await readSkin();
  push('一键恢复默认', skin2.accentInput === '#5cbdb5' && skin2.label === '月白');
  const cleared = await ext.evaluate(async () =>
    Object.keys(await chrome.storage.local.get(['uiAccent', 'uiTheme'])).length);
  push('恢复默认是删键而不是写死值', cleared === 0);
  console.log('\n  三档实测: ' + seen.map(s =>
    `${s.name} ${s.bg}/${s.fg} 对比度 ${s.contrast}`).join('  |  '));

  // ── 7. 外观要真的传到页面上那条提示条 ────────────────────────────
  // 面板里改完就该生效，不用刷新页面——这才是这个功能的用处所在。
  // 只验面板自己会变的话，等于没验。
  await ext.evaluate(async () =>
    chrome.storage.local.set({ uiAccent: '#e06c9f', uiTheme: 'ink', showBlind: true }));
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
  // 提示条要跟着主题走，而且文字得跟着翻——米白底配白字就是这个功能的失败态
  push('提示条用上了选中的主题底色（切到玄墨）', !!bn && bn.bg === 'rgb(22, 24, 28)');
  push('玄墨主题下提示条文字是浅色', !!bn && bn.color === 'rgb(233, 231, 226)');
  if (bn) await drm3.screenshot({ path: '/tmp/ww-banner-custom.png' });

  // 改回默认，确认也是即时的（内容脚本监听 onChanged，不是只在启动时读一次）
  await ext.evaluate(async () => chrome.storage.local.remove(['uiAccent', 'uiTheme']));
  await drm3.waitForTimeout(800);
  const bn2 = await drm3.evaluate(() => {
    const el = document.querySelector('.ww-banner');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  push('恢复默认后提示条不用刷新就变回去', bn2 === 'rgb(245, 241, 232)');

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
