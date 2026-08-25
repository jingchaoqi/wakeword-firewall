/**
 * 真·端到端：hook appendBuffer → 解封装 → WebCodecs 解码 → 重采样 → KWS → GainNode 静音
 * 之前的自检只验了最后两环（直接喂 WAV 给 worker），中间四环从没在浏览器里跑过。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

// 素材自给自足：用扩展自带的 selftest.wav（fetch-models.sh 取的官方测试音频）
// 现场转成 WebM/Opus，不依赖任何私人视频——这是它和 run.js 最大的区别。
const EXT = process.env.WW_EXT || path.resolve(__dirname, '..');
const CHROME = process.env.WW_CHROME ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const WAV = EXT + '/assets/selftest.wav';
const META = JSON.parse(fs.readFileSync(EXT + '/assets/selftest.json', 'utf8'));
const DIR = process.env.WW_MEDIA || '/tmp/ww-e2e-media';

(async () => {
  // ── 1. 用 Chrome 把 wav 转成 WebM/Opus（容器里的 ffmpeg 读不了 wav）──────
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(DIR + '/full.webm')) {
    const b = await chromium.launch({
      executablePath: CHROME,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const p = await b.newPage();
    await p.goto('about:blank');
    const wavB64 = fs.readFileSync(WAV).toString('base64');
    const out = await p.evaluate(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const ac = new AudioContext();
      const buf = await ac.decodeAudioData(u.buffer);
      const dst = ac.createMediaStreamDestination();
      const src = ac.createBufferSource();
      src.buffer = buf; src.connect(dst);
      const rec = new MediaRecorder(dst.stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.start(); src.start();
      await new Promise(r => setTimeout(r, buf.duration * 1000 + 700));
      await new Promise(r => { rec.onstop = r; rec.stop(); });
      const ab = await new Blob(chunks).arrayBuffer();
      let s = ''; const v = new Uint8Array(ab);
      for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode.apply(null, v.subarray(i, i + 0x8000));
      return { b64: btoa(s), dur: buf.duration };
    }, wavB64);
    await b.close();
    fs.writeFileSync(DIR + '/full.webm', Buffer.from(out.b64, 'base64'));
    console.log(`素材就绪: ${out.dur.toFixed(2)}s WebM/Opus, ${fs.statSync(DIR + '/full.webm').size} 字节`);
  }

  // ── 2. 按字节切片，模拟播放器分段投喂（顺便压 webm-demux 跨片解析）──────
  const full = fs.readFileSync(DIR + '/full.webm');
  const names = ['init.m4s', 'seg-1.m4s', 'seg-2.m4s', 'seg-3.m4s', 'seg-4.m4s', 'seg-5.m4s', 'seg-6.m4s'];
  const step = Math.ceil(full.length / names.length);
  names.forEach((n, i) => fs.writeFileSync(path.join(DIR, n), full.subarray(i * step, (i + 1) * step)));
  // 测试页必须用**外部脚本**：严格 CSP 下内联 <script> 会被拦，
  // 那样挂掉的是测试页自己，测不到扩展。真实站点也都是外部脚本。
  fs.writeFileSync(DIR + '/index.html',
    '<!doctype html><meta charset=utf-8><title>MSE 测试页</title>' +
    '<body><audio id=a controls></audio><pre id=log></pre>' +
    '<script src="player.js"></script>');
  fs.writeFileSync(DIR + '/player.js', `
const log=(...m)=>{document.getElementById('log').textContent+=m.join(' ')+'\\n';console.log('[测试页]',...m)};
const a=document.getElementById('a');
const ms=new MediaSource();
a.src=URL.createObjectURL(ms);
ms.addEventListener('sourceopen',async()=>{
  const sb=ms.addSourceBuffer('audio/webm; codecs="opus"');
  for(const f of ${JSON.stringify(names)}){
    const buf=await (await fetch(f)).arrayBuffer();
    await new Promise(r=>{sb.addEventListener('updateend',r,{once:true});sb.appendBuffer(buf)});
    log('appended',f,buf.byteLength+'B','buffered='+(sb.buffered.length?sb.buffered.end(0).toFixed(2):'0')+'s');
  }
  ms.endOfStream();
  log('全部 append 完成，缓冲', sb.buffered.end(0).toFixed(2)+'s');
  window.__appended=true;
});
`);

  const srv = http.createServer((q, s) => {
    const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.slice(1));
    if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
    // 默认加严格 CSP：大站基本都是这样，而这正是旧架构（blob worker + eval）
    // 会死掉的场景。WW_NO_CSP=1 可以关掉做对照。
    const h = { 'Content-Type': f.endsWith('.html') ? 'text/html'
                : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' };
    if (!process.env.WW_NO_CSP) h['Content-Security-Policy'] = "script-src 'self'";
    s.writeHead(200, h);
    s.end(fs.readFileSync(f));
  }).listen(8848);

  // ── 3. 装扩展，把词表换成素材里真有的那个词 ────────────────────────────
  const ctx = await chromium.launchPersistentContext('/tmp/ww-e2e-' + Date.now(), {
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  const cfg = await ctx.newPage();
  await cfg.goto(`chrome-extension://${id}/src/welcome.html`);
  await cfg.evaluate(async (kw) => { await chrome.storage.local.set({ keywords: kw, enabled: true }); }, META.keywords);
  await cfg.close();
  console.log(`词表已设为: ${META.keywords}（期望认出「${META.expect}」）`);

  // ── 4. 开测试页，看整条链路 ──────────────────────────────────────────
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.goto('http://127.0.0.1:8848/index.html');
  await page.waitForFunction(() => window.__appended === true, null, { timeout: 30000 })
    .catch(() => console.log('!! append 没跑完'));
  await page.waitForTimeout(25000);

  console.log('\n──── 扩展日志 ────');
  for (const l of logs) if (/唤醒词防火墙|防火墙|ERROR|错误|失败/.test(l)) console.log('  ' + l.slice(0, 220));
  console.log('\n──── 测试页日志 ────');
  for (const l of logs) if (/测试页/.test(l)) console.log('  ' + l.slice(0, 160));

  const hits = logs.filter(l => /已排程静音|命中/.test(l));
  console.log('\n──── 判定 ────');
  console.log(hits.length ? '✅ 全链路打通: ' + hits.join(' | ') : '❌ 没有静音排程');
  await ctx.close(); srv.close();
  process.exit(hits.length ? 0 : 1);
})();
