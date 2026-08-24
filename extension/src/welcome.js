/**
 * 安装引导页
 * ==========
 * 原则：能自动做的都自动做，只把真正做不了的留给用户。
 *   1) 引擎在不在 —— 自动查
 *   2) 拖进来的文件 —— 自动识别类型、自动入库
 *   3) 装完能不能用 —— 自动跑一遍真实音频的端到端自检
 *   4) 当前站点抓不抓得到音频 —— 一键探测
 */
'use strict';

const $ = (id) => document.getElementById(id);
const E = window.WWEngine;

function mark(stepId, state) {   // 'done' | 'fail' | null
  const el = $(stepId);
  el.classList.remove('done', 'fail');
  if (state) el.classList.add(state);
}

function show(id, cls, html) {
  const el = $(id);
  el.className = 'result show ' + cls;
  el.innerHTML = html;
}

// ----------------------------------------------------------- 1. 引擎状态

async function refresh() {
  const st = await window.WWEngineLoader.probe();
  const kb = (n) => n ? (n / 1048576).toFixed(1) + ' MB' : '—';
  $('filelist').innerHTML = [
    ['胶水 .js', st.glue], ['引擎 .wasm', st.wasm], ['模型包 .data', st.data],
  ].map(([n, v]) =>
    `<div><span>${n}</span><span class="${v ? 'ok' : 'no'}">${v ? kb(v) : '缺'}</span></div>`
  ).join('');

  if (st.installed && st.source === 'bundled') {
    // 分发版：引擎随包附带，用户什么都不用做
    mark('s1', 'done');
    $('s1msg').innerHTML =
      `引擎已随扩展内置（wasm ${kb(st.wasm)}` +
      (st.data ? `，模型包 ${kb(st.data)}` : '') + '），<b>无需任何操作</b>。';
    $('s1need').style.display = 'none';
    $('run').disabled = false;
  } else if (st.installed) {
    mark('s1', 'done');
    $('s1msg').innerHTML = `引擎已就位（wasm ${kb(st.wasm)}` +
      (st.data ? `，模型包 ${kb(st.data)}` : '') + '）。想换一份就再拖一次。';
    $('s1need').style.display = '';
    $('run').disabled = false;
  } else {
    mark('s1', 'fail');
    $('s1msg').innerHTML = '<b>还没装引擎</b>，扩展目前无法检测唤醒词。';
    $('s1need').style.display = '';
    $('run').disabled = true;
  }
  return st;
}

// ----------------------------------------------------------- 2. 收文件

async function take(files) {
  let n = 0;
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.wasm')) {
      await E.putBinary('wasm', await f.arrayBuffer()); n++;
    } else if (name.endsWith('.data')) {
      await E.putBinary('data', await f.arrayBuffer()); n++;
    } else if (name.endsWith('.js')) {
      const t = await f.text();
      // 只认 emscripten 胶水，别把 sherpa-onnx-kws.js 误当成它
      if (!/ENVIRONMENT_IS_WEB|wasmBinary|Module/.test(t)) {
        show('s2res', 'bad', `<b>${f.name}</b> 看起来不是 emscripten 胶水，已跳过。` +
          '需要的是 <code>sherpa-onnx-wasm-kws-main.js</code>。');
        continue;
      }
      await E.putText('glue', t); n++;
    }
  }
  if (n) {
    $('s2res').className = 'result';
    await refresh();
  }
  return n;
}

const drop = $('drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('hot');
}));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('hot');
}));
drop.addEventListener('drop', (e) => take(e.dataTransfer.files));
drop.addEventListener('click', () => $('pick').click());
$('pick').addEventListener('change', (e) => take(e.target.files));

$('copycmd').onclick = async () => {
  await navigator.clipboard.writeText($('cmd').textContent);
  $('copycmd').textContent = '已复制';
  setTimeout(() => { $('copycmd').textContent = '复制构建命令'; }, 1800);
};

$('dlscript').onclick = async () => {
  const t = await fetch(chrome.runtime.getURL('vendor/build-wasm.sh')).then(r => r.text());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'text/x-shellscript' }));
  a.download = 'build-wasm.sh';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ----------------------------------------------------------- 3. 自检

function parseWav(ab) {
  const dv = new DataView(ab);
  let p = 12, sr = 16000, ch = 1, bits = 16, dataOff = 0, dataLen = 0;
  while (p + 8 <= ab.byteLength) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1),
                                   dv.getUint8(p + 2), dv.getUint8(p + 3));
    const sz = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      ch = dv.getUint16(p + 10, true);
      sr = dv.getUint32(p + 12, true);
      bits = dv.getUint16(p + 22, true);
    } else if (id === 'data') { dataOff = p + 8; dataLen = sz; break; }
    p += 8 + sz + (sz & 1);
  }
  const n = Math.floor(dataLen / (bits / 8) / ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2 * ch, true);
  return { samples: out, sampleRate: sr };
}

$('run').onclick = async () => {
  $('run').disabled = true;
  show('s2res', '', '正在加载引擎…');
  try {
    const eng = await window.WWEngineLoader.load();
    if (!eng) throw new Error('引擎不在');
    const glue = eng.glue, wasm = eng.wasm, data = eng.data;
    const [kwsjs, shim, wsrc, kwFile, wav] = await Promise.all([
      fetch(chrome.runtime.getURL('vendor/sherpa-onnx-kws.js')).then(r => r.text()),
      fetch(chrome.runtime.getURL('src/node-shim.js')).then(r => r.text()),
      fetch(chrome.runtime.getURL('src/kws-worker.js')).then(r => r.text()),
      fetch(chrome.runtime.getURL('keywords.txt')).then(r => r.text()),
      fetch(chrome.runtime.getURL('assets/selftest.wav')).then(r => r.arrayBuffer()),
    ]);

    const blob = new Blob([shim, '\n;\n', kwsjs, '\n;\n', wsrc],
                          { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);

    const keywords = kwFile.split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#')).join('\n');

    const models = data ? null : await (async () => {
      const g = (p) => fetch(chrome.runtime.getURL(p)).then(r => r.arrayBuffer());
      return {
        encoder: await g('models/encoder.int8.onnx'),
        decoder: await g('models/decoder.onnx'),
        joiner: await g('models/joiner.int8.onnx'),
        tokens: await g('models/tokens.txt'),
      };
    })();

    const hits = [];
    const done = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('自检超时（30 秒）')), 30000);
      w.onerror = (e) => { clearTimeout(timer); rej(new Error(e.message || 'Worker 错误')); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'error') { clearTimeout(timer); rej(new Error(m.message)); }
        else if (m.type === 'ready') {
          show('s2res', '', '引擎已加载，正在喂音频…');
          const { samples } = parseWav(wav);
          const CH = 1600;
          for (let i = 0; i < samples.length; i += CH) {
            const part = samples.slice(i, i + CH);
            w.postMessage({ type: 'pcm', sbId: 1, t: i / 16000, pcm: part.buffer },
                          [part.buffer]);
          }
          setTimeout(() => { clearTimeout(timer); res(); }, 2500);
        } else if (m.type === 'hit') hits.push(m);
      };
    });

    w.postMessage({
      type: 'init', wasmBinary: wasm, dataPackage: data || null, glue,
      models, keywords, score: 2.0, threshold: 0.25,
    });
    await done;
    w.terminate();

    if (hits.length) {
      const h = hits[0];
      mark('s2', 'done');
      show('s2res', 'good',
        `<b>✓ 检测正常</b> —— 在 ${h.at.toFixed(2)}s 处认出「${h.keyword}」，` +
        `静音区间 ${h.span[0].toFixed(2)}–${h.span[1].toFixed(2)}s。` +
        `<br><span class="muted">测试音频是一段真实短视频，开头喊了一声「小爱同学」。</span>`);
    } else {
      mark('s2', 'fail');
      show('s2res', 'bad',
        '<b>引擎加载成功，但没认出唤醒词。</b>多半是词表被改坏了，' +
        '或者引擎用的模型和词表的 token 体系对不上（本词表用的是拼音声母+韵母）。');
    }
  } catch (err) {
    mark('s2', 'fail');
    show('s2res', 'bad', '<b>自检失败：</b>' + (err.message || err) +
      '<br><span class="muted">最常见的原因是拖错了文件——需要的是 ' +
      '<code>sherpa-onnx-wasm-kws-main.js</code>（不是 npm 包里那个 nodejs 版）。</span>');
  } finally {
    $('run').disabled = false;
  }
};

// ----------------------------------------------------------- 4. 站点探测

$('probe').onclick = async () => {
  show('s3res', '', '正在查…');
  try {
    const tabs = await chrome.tabs.query({});
    const cands = tabs.filter(t => /^https?:/.test(t.url || '') &&
      !t.url.startsWith(chrome.runtime.getURL('')));
    let found = null;
    for (const t of cands) {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          world: 'MAIN',
          func: () => {
            const v = document.querySelector('video, audio');
            if (!v) return null;
            return {
              src: (v.src || '').slice(0, 24),
              hasSrcObject: !!v.srcObject,
              handle: typeof MediaSourceHandle !== 'undefined' &&
                      v.srcObject instanceof MediaSourceHandle,
              workerCapable: !!(self.MediaSource &&
                                MediaSource.canConstructInDedicatedWorker),
              hooked: !!window.__wwInstalled,
            };
          },
        });
        if (r && r.result) { found = { tab: t, ...r.result }; break; }
      } catch (e) { /* 跳过没权限的标签页 */ }
    }

    if (!found) {
      show('s3res', 'bad', '没找到正在播放媒体的标签页。先打开一个视频页再点这里。');
      return;
    }
    const host = new URL(found.tab.url).host;
    if (found.handle) {
      mark('s3', 'fail');
      show('s3res', 'bad', `<b>${host}</b>：这个播放器把 MediaSource 放在 Worker 里` +
        `（<code>srcObject</code> 是 MediaSourceHandle），主线程抓不到音频数据。` +
        `这个站点目前挡不住。`);
    } else if (found.src.startsWith('blob:')) {
      mark('s3', 'done');
      show('s3res', 'good', `<b>${host}</b>：走主线程 MSE（<code>src</code> 是 blob:），` +
        `方案成立 ✓${found.hooked ? '，且扩展已注入。' : '。'}`);
    } else {
      show('s3res', 'bad', `<b>${host}</b>：这个媒体元素不走 MSE` +
        `（<code>src</code> = ${found.src || '空'}），可能是直链播放。` +
        `预扫描用不上，只能靠实时兜底路径。`);
    }
  } catch (e) {
    show('s3res', 'bad', '探测失败：' + e.message);
  }
};

refresh();
