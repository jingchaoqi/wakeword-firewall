/**
 * 引擎已内置时的引导页
 * ====================
 *  - 第 1 步该自动判定通过（onboarding-test.js 验的是反面）
 *  - 第 2 步的自检真跑一遍，并检查它**说了什么**
 *
 * 后半段是有来由的：自检面对的是刚装完、还不确定这东西靠不靠谱的人。
 * 说「正在喂音频」「用时 1.8 秒的音频片段」会让人怀疑是不是录了音，
 * 而它其实全程本地、不碰麦克风。这类文案没有测试就会悄悄退回去。
 */
const { chromium } = require('playwright');
const path = require('path');
const { requireChrome } = require('./util.js');
(async () => {
  const ext = process.env.WW_EXT || path.resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext('/tmp/ww-bd-' + Date.now(), {
    headless: true, executablePath: requireChrome(),
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

  // ── 第 2 步：真跑一遍自检 ───────────────────────────────────────────
  const checks = [
    ['第 1 步自动标记为完成', done],
    ['文案说明「无需任何操作」', /随扩展内置/.test(msg)],
    ['构建指引与拖拽区自动隐藏', hidden],
    ['自检按钮可用', runOk],
  ];

  let s2 = '';
  if (runOk) {
    await w.click('#run');
    // 等到出结果为止：跑通是 .good，失败是 .bad
    await w.waitForFunction(() => {
      const el = document.getElementById('s2res');
      return el && /good|bad/.test(el.className);
    }, null, { timeout: 60000 }).catch(() => {});
    s2 = (await w.textContent('#s2res').catch(() => '') || '').trim();
    const passed = await w.$eval('#s2', el => el.classList.contains('done')).catch(() => false);

    checks.push(['自检跑通', passed]);
    checks.push(['结果只说「能用」', /检测引擎工作正常/.test(s2)]);
    // 下面三条是防退回的：这些词一旦出现，就是又开始跟用户讲实现细节了
    checks.push(['不提「喂音频」', !/喂音频|喂入|投喂/.test(s2)]);
    checks.push(['不报音频时长', !/秒的音频|音频片段|\d+\.\d+ 秒/.test(s2)]);
    checks.push(['不把内部测试词显示出来', !/文森特卡索/.test(s2)]);

    const desc = await w.textContent('#s2 p').catch(() => '');
    checks.push(['第 2 步说明不再谎称测「小爱同学」', !/小爱同学/.test(desc)]);
    checks.push(['第 2 步说明写明不用麦克风', /不用麦克风/.test(desc)]);
  }

  console.log('');
  for (const [n, ok] of checks.slice(4)) console.log(`  ${ok ? '✅' : '❌'}  ${n}`);
  if (s2) console.log(`\n  自检结果原文: ${s2.replace(/\s+/g, ' ')}`);
  await ctx.close();
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})();
