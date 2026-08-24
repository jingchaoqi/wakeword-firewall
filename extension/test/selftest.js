const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const ext = path.resolve(__dirname, '..');
  const ctx = await chromium.launchPersistentContext('/tmp/ww-st-' + Date.now(), {
    headless: true,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
           '--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--mute-audio'],
  });
  const logs = [];
  const page = await ctx.newPage();
  page.on('console', m => logs.push(m.text()));
  await page.goto('http://127.0.0.1:8848/index.html');
  await page.waitForFunction(() => window.__appended === true, null, { timeout: 30000 });

  // 注入一次「假命中」，专门验证最后一段：时间戳表 → GainNode 静音
  await page.evaluate(() => {
    const a = document.querySelector('audio');
    a.currentTime = 0; a.play();
    window.__wwForceHit([0.49, 1.69]);
  });
  await page.waitForTimeout(3000);

  const d = await page.evaluate(() => window.__wwDebug);
  console.log('\n============ 自测结果 ============');
  const checks = [
    ['MAIN world hook 注入', logs.some(l => /已注入/.test(l))],
    ['识别到音频 SourceBuffer', logs.some(l => /音频 SourceBuffer/.test(l))],
    ['WebM 解封装 + Opus 解码器就绪', logs.some(l => /解码器就绪 opus/.test(l))],
    ['解码 + 重采样出 PCM 帧', d && d.pcmFrames > 100],
    ['接管 <audio> 音频输出', d && d.attached === true],
    ['按时间戳排程静音', d && d.scheduled.length > 0],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'}  ${name}`);
  console.log(`\n  PCM 帧数: ${d ? d.pcmFrames : '-'}   排程静音区间: ${d ? JSON.stringify(d.scheduled) : '-'}`);
  await ctx.close();
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})();
