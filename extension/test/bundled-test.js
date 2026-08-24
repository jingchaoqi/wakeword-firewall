const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const ext = path.resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext('/tmp/ww-bd-' + Date.now(), {
    headless: true, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox'],
  });
  await new Promise(r => setTimeout(r, 3500));
  const w = ctx.pages().find(p => p.url().includes('welcome.html'));
  if (!w) { console.log('❌ 没开引导页'); await ctx.close(); process.exit(1); }
  await w.waitForTimeout(1500);
  const msg = await w.textContent('#s1msg');
  const done = await w.$eval('#s1', el => el.classList.contains('done'));
  const hidden = await w.$eval('#s1need', el => getComputedStyle(el).display === 'none');
  const runOk = await w.$eval('#run', el => !el.disabled);
  console.log('\n======== 引擎已内置时的引导页 ========');
  console.log(`  ${done ? '✅' : '❌'}  第 1 步自动标记为完成`);
  console.log(`  ${/随扩展内置/.test(msg) ? '✅' : '❌'}  文案说明「无需任何操作」`);
  console.log(`  ${hidden ? '✅' : '❌'}  构建指引与拖拽区自动隐藏`);
  console.log(`  ${runOk ? '✅' : '❌'}  自检按钮可用`);
  console.log(`\n  实际文案: ${msg.trim()}`);
  await ctx.close();
  process.exit(done && hidden && runOk ? 0 : 1);
})();
