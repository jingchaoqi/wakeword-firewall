const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const ext = path.resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext('/tmp/ww-profile-' + Date.now(), {
    headless: true,
    // 别写死：换台机器就跑不了。用 WW_CHROME 覆盖。
    executablePath: process.env.WW_CHROME ||
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
      '--mute-audio',
    ],
  });
  const logs = [];
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); logs.push(t); });
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  await page.goto('http://127.0.0.1:8848/index.html');
  try { await page.waitForFunction(() => window.__appended === true, null, { timeout: 20000 }); }
  catch (e) { console.log('!! append 未完成'); }
  await page.waitForTimeout(20000);
  console.log('\n---- 全部控制台输出 ----');
  for (const l of logs) console.log('  ', l.slice(0,260));

  console.log('\n================ 扩展日志 ================');
  for (const l of logs) if (/唤醒词防火墙|测试页|ERROR/.test(l)) console.log('  ' + l);
  const hits = logs.filter(l => /已排程静音/.test(l));
  console.log('\n================ 结果 ================');
  console.log(hits.length ? '✅ 检测并静音: ' + hits.join(' | ') : '❌ 未检测到唤醒词');
  await ctx.close();
  process.exit(hits.length ? 0 : 1);
})();
