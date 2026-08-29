/**
 * 引导流程自测 —— 场景是「用户刚 clone 完，还没编引擎」
 * =====================================================
 * 这个场景 e2e-selftest 覆盖不到（那边跑的是引擎已内置的完整包），
 * 但它恰恰是每个新用户见到的第一屏：引导页该说清楚差什么、怎么补，
 * 视频页该给提示而不是静默失效。
 *
 * 自己造场景：把 extension/ 拷一份出去，删掉 vendor 里的引擎二进制。
 * 不动仓库里那份。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { requireChrome, prepareMedia, serve } = require('./util.js');

const SRC = process.env.WW_EXT || path.resolve(__dirname, '..');
const CHROME = requireChrome();
const DIR = process.env.WW_MEDIA || '/tmp/ww-e2e-media';
const STRIPPED = '/tmp/ww-noengine-' + process.pid;

(async () => {
  // ── 造一份「没有引擎」的扩展 ────────────────────────────────────────
  fs.cpSync(SRC, STRIPPED, {
    recursive: true,
    filter: (s) => !/node_modules|[\\/]test$/.test(s),
  });
  for (const f of ['sherpa-onnx-wasm.js', 'sherpa-onnx-wasm.wasm', 'sherpa-onnx-wasm.data'])
    fs.rmSync(path.join(STRIPPED, 'vendor', f), { force: true });
  fs.rmSync(path.join(STRIPPED, 'models'), { recursive: true, force: true });

  const names = ['init.m4s', 'seg-1.m4s', 'seg-2.m4s', 'seg-3.m4s',
                 'seg-4.m4s', 'seg-5.m4s', 'seg-6.m4s'];
  await prepareMedia({ chrome: CHROME, wav: SRC + '/assets/selftest.wav', dir: DIR, names });
  fs.writeFileSync(DIR + '/ob.html',
    '<!doctype html><meta charset=utf-8><title>MSE 测试页</title>' +
    '<body><audio id=a controls></audio><script src="ob.js"></script>');
  fs.writeFileSync(DIR + '/ob.js', `
const a=document.getElementById('a'), ms=new MediaSource();
a.src=URL.createObjectURL(ms);
ms.addEventListener('sourceopen',async()=>{
  const sb=ms.addSourceBuffer('audio/webm; codecs="opus"');
  for(const f of ${JSON.stringify(names)}){
    const buf=await (await fetch(f)).arrayBuffer();
    await new Promise(r=>{sb.addEventListener('updateend',r,{once:true});sb.appendBuffer(buf)});
  }
  ms.endOfStream();
  window.__appended=true;
});
`);
  const srv = serve(DIR);

  const ctx = await chromium.launchPersistentContext('/tmp/ww-ob-' + Date.now(), {
    headless: true,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${STRIPPED}`, `--load-extension=${STRIPPED}`,
           '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
  });
  const checks = [];
  await new Promise(r => setTimeout(r, 3000));

  // 1) 装完是否自动开了引导页
  const welcome = ctx.pages().find(p => p.url().includes('welcome.html'));
  checks.push(['安装后自动跳转引导页', !!welcome]);

  let w = welcome;
  if (!w) {
    const [sw] = ctx.serviceWorkers();
    const id = sw ? new URL(sw.url()).host : null;
    if (id) { w = await ctx.newPage(); await w.goto(`chrome-extension://${id}/src/welcome.html`); }
  }
  if (w) {
    await w.waitForTimeout(1500);
    const s1 = await w.textContent('#s1msg').catch(() => '');
    checks.push(['引导页正确报告「引擎未装」', /还没装引擎/.test(s1)]);
    const failing = await w.$eval('#s1', el => el.classList.contains('fail')).catch(() => false);
    checks.push(['第 1 步标记为未完成', failing === true]);
    const runDisabled = await w.$eval('#run', el => el.disabled).catch(() => null);
    checks.push(['引擎未装时自检按钮禁用', runDisabled === true]);
    const cmd = await w.textContent('#cmd').catch(() => '');
    checks.push(['构建命令已内置', /build-wasm-simd-kws\.sh/.test(cmd)]);
  }

  // 2) 视频页上是否给出「去设置」提示而不是静默失败
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  await page.goto('http://127.0.0.1:8848/ob.html');
  await page.waitForFunction(() => window.__appended === true, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  checks.push(['引擎缺失时内容脚本给出提示', logs.some(l => /引擎未安装|引擎没打进/.test(l))]);
  const bannerTxt = await page.$eval('.ww-banner', el => el.textContent).catch(() => '');
  checks.push(['页面上出现失效提示条', /引擎|防护/.test(bannerTxt)]);

  // 3) 静音时长设置能存能读
  if (w) {
    await w.evaluate(() => chrome.storage.local.set({ muteTail: 4 }));
    const v = await w.evaluate(async () => (await chrome.storage.local.get('muteTail')).muteTail);
    checks.push(['静音时长设置可持久化', v === 4]);
  }

  if (process.env.WW_DEBUG) { console.log('---- 页面日志 ----'); for (const l of logs) console.log('  '+l.slice(0,200)); }
  console.log('\n============ 引导流程自测（引擎未装场景）============');
  for (const [n, ok] of checks) console.log(`  ${ok ? '✅' : '❌'}  ${n}`);
  await ctx.close();
  srv.close();
  fs.rmSync(STRIPPED, { recursive: true, force: true });
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})();
