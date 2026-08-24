const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const ext = path.resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext('/tmp/ww-ob-' + Date.now(), {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
           '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
  });
  const checks = [];
  await new Promise(r => setTimeout(r, 3000));

  // 1) 装完是否自动开了引导页
  const pages = ctx.pages();
  const welcome = pages.find(p => p.url().includes('welcome.html'));
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
  await page.goto('http://127.0.0.1:8848/index.html');
  await page.waitForFunction(() => window.__appended === true, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  checks.push(['引擎缺失时内容脚本给出提示', logs.some(l => /引擎未安装/.test(l))]);
  const bannerTxt = await page.$eval('.ww-banner', el => el.textContent).catch(() => '');
  checks.push(['页面上出现「去设置」按钮', /去设置/.test(bannerTxt)]);

  // 3) 静音时长设置能存能读
  if (w) {
    await w.evaluate(() => chrome.storage.local.set({ muteTail: 4 }));
    const v = await w.evaluate(async () => (await chrome.storage.local.get('muteTail')).muteTail);
    checks.push(['静音时长设置可持久化', v === 4]);
  }

  console.log('\n============ 引导流程自测 ============');
  for (const [n, ok] of checks) console.log(`  ${ok ? '✅' : '❌'}  ${n}`);
  await ctx.close();
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})();
