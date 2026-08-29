/**
 * 测试公用件
 * ==========
 * 这里只放三样：找浏览器、造素材、起静态服务。都是从 e2e-selftest.js 里抽出来的
 * ——抽出来是因为另外两个测试也要用，而它们之前是**假定外面已经有人起好了
 * 8848 端口的服务**，单独跑必然 ERR_CONNECTION_REFUSED。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

/**
 * 找 Chromium。顺序：WW_CHROME → playwright 自己装的 → 预装目录里实际存在的。
 * 以前只有最后一条且写死了版本号目录，于是这些测试**只在某一台开发容器里跑得起来**，
 * CI 和任何贡献者都是必挂。别再退回硬编码。
 */
function findChrome() {
  const tries = [process.env.WW_CHROME];
  try { tries.push(chromium.executablePath()); } catch { /* 没装浏览器 */ }
  // 预装目录名带的是 playwright 的内部版本号；npm 里 playwright 版本一变，
  // executablePath() 指的号就对不上，明明有浏览器却说找不到。按实际目录兜一层。
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(root).filter(x => x.startsWith('chromium')).sort().reverse())
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome'])
        tries.push(path.join(root, d, sub));
  } catch { /* 没这个目录 */ }
  return tries.find(c => c && fs.existsSync(c)) || null;
}

/** 找不到就报一句能照做的话然后退出，别让调用方各写一遍 */
function requireChrome() {
  const c = findChrome();
  if (c) return c;
  console.error('!! 找不到 Chromium。\n' +
    '   跑 `npx playwright install chromium`，或用 WW_CHROME=<chrome路径> 指定。');
  process.exit(1);
}

/**
 * 用 Chrome 自己把 selftest.wav 转成 WebM/Opus 并切片。
 * 为什么不用 ffmpeg：容器里那份读不了这个 wav；而且这样素材自给自足，
 * 不依赖任何私人视频。转好会缓存在 dir 里，第二次跑直接用。
 */
async function prepareMedia({ chrome, wav, dir, names }) {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dir + '/full.webm')) {
    const b = await chromium.launch({
      executablePath: chrome,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const p = await b.newPage();
    await p.goto('about:blank');
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
      for (let i = 0; i < v.length; i += 0x8000)
        s += String.fromCharCode.apply(null, v.subarray(i, i + 0x8000));
      return { b64: btoa(s), dur: buf.duration };
    }, fs.readFileSync(wav).toString('base64'));
    await b.close();
    fs.writeFileSync(dir + '/full.webm', Buffer.from(out.b64, 'base64'));
    console.log(`素材就绪: ${out.dur.toFixed(2)}s WebM/Opus, ${fs.statSync(dir + '/full.webm').size} 字节`);
  }
  const full = fs.readFileSync(dir + '/full.webm');
  const step = Math.ceil(full.length / names.length);
  names.forEach((n, i) => fs.writeFileSync(path.join(dir, n), full.subarray(i * step, (i + 1) * step)));
}

/**
 * 起静态服务。默认带严格 CSP——大站基本都是这样，而这正是旧架构
 * （blob worker + eval）会死掉的场景。WW_NO_CSP=1 关掉做对照。
 */
function serve(dir, port = 8848) {
  return http.createServer((q, s) => {
    const f = path.join(dir, q.url === '/' ? 'index.html' : q.url.split('?')[0].slice(1));
    if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
    const h = { 'Content-Type': f.endsWith('.html') ? 'text/html'
              : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' };
    if (!process.env.WW_NO_CSP) h['Content-Security-Policy'] = "script-src 'self'";
    s.writeHead(200, h);
    s.end(fs.readFileSync(f));
  }).listen(port);
}

module.exports = { findChrome, requireChrome, prepareMedia, serve };
