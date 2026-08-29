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
    const kwFile = await fetch(chrome.runtime.getURL('keywords.txt')).then(r => r.text());

    // 自检素材单独取，不能混进上面的 Promise.all。
    // 扩展页里 fetch 不存在的资源是**抛 TypeError**，不是返 404（已实测），
    // 混在一起会让整个自检报一句没头没脑的 "Failed to fetch"，
    // 而仓库默认就是不带 selftest.wav 的——等于每个自建用户都会撞上。
    const wav = await fetch(chrome.runtime.getURL('assets/selftest.wav'))
      .then(r => r.arrayBuffer())
      .catch(() => { throw new Error('MISSING_SELFTEST_WAV'); });

    // 素材配套的词表：官方 test_wavs 认的不是「小爱同学」，得按素材来。
    // 没有这份 json 就沿用扩展自己的词表（用户自备了「小爱同学」录音的情况）。
    const meta = await fetch(chrome.runtime.getURL('assets/selftest.json'))
      .then(r => r.json()).catch(() => null);

    // 必须用扩展 URL 建 worker，不能拼成 blob。
    // MV3 扩展页的 CSP 是 script-src 'self' 'wasm-unsafe-eval'：blob worker 里
    // 无论 eval 还是 importScripts 都会被拦，只有「扩展 URL 建的 worker +
    // importScripts 扩展内 URL」这一条走得通（已实测）。
    if (eng.source !== 'bundled') {
      throw new Error('CSP_NEEDS_BUNDLED');
    }
    const w = new Worker(chrome.runtime.getURL('src/kws-worker.js'));

    const keywords = meta && meta.keywords ? meta.keywords : kwFile.split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#')).join('\n');

    // 引擎自带 .data 时模型已经在虚拟文件系统里；否则要从 models/ 单独送。
    // 同样注意：缺文件是抛异常不是 404，得给出能照做的提示。
    const models = data ? null : await (async () => {
      const g = (p) => fetch(chrome.runtime.getURL(p)).then(r => r.arrayBuffer());
      try {
        return {
          encoder: await g('models/encoder.int8.onnx'),
          decoder: await g('models/decoder.onnx'),
          joiner: await g('models/joiner.int8.onnx'),
          tokens: await g('models/tokens.txt'),
        };
      } catch (e) { throw new Error('MISSING_MODELS'); }
    })();

    const hits = [];
    const done = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('自检超时（30 秒）')), 30000);
      w.onerror = (e) => { clearTimeout(timer); rej(new Error(e.message || 'Worker 错误')); };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'error') { clearTimeout(timer); rej(new Error(m.message)); }
        else if (m.type === 'ready') {
          show('s2res', '', '正在检测…');
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
      type: 'init', wasmBinary: wasm, dataPackage: data || null,
      glueUrl: chrome.runtime.getURL('vendor/sherpa-onnx-wasm.js'),
      shimUrl: chrome.runtime.getURL('src/node-shim.js'),
      kwsUrl: chrome.runtime.getURL('vendor/sherpa-onnx-kws.js'),
      models, keywords, score: 2.0, threshold: 0.25,
    });
    await done;
    w.terminate();

    if (hits.length) {
      const h = hits[0];
      mark('s2', 'done');
      // 别把内部测试词报给用户——素材用的是官方模型包自带的音频，认的不是唤醒词，
      // 显示出来只会让人困惑「为什么是这几个字」。技术细节留在控制台给开发者。
      console.log('[自检] 命中', h.keyword, '@', h.at.toFixed(2) + 's',
                  '静音区间', h.span.map(x => x.toFixed(2)).join('–') + 's');
      // 用户只需要知道「能用」。素材是随扩展打包的一小段测试音频，但说出来
      // 反而让人怀疑是不是录了什么音——这一步全程本地、没有麦克风、不联网，
      // 多解释一句都是给人添疑虑。技术细节上面已经打进控制台了。
      show('s2res', 'good',
        '<b>✓ 检测引擎工作正常</b>' +
        '<br><span class="muted">可以开始用了。</span>');
    } else {
      mark('s2', 'fail');
      show('s2res', 'bad',
        '<b>引擎装上了，但没能识别出结果。</b>多半是词表被改坏了，' +
        '或者引擎用的模型和词表的 token 体系对不上（本词表用的是拼音声母+韵母）。' +
        '<br><span class="muted">控制台有详细日志。</span>');
    }
  } catch (err) {
    mark('s2', 'fail');
    if (err.message === 'CSP_NEEDS_BUNDLED') {
      show('s2res', 'bad',
        '<b>拖进来的引擎没法在扩展页里跑</b> —— MV3 的 CSP 是 ' +
        '<code>script-src \'self\'</code>，「以文本形式存起来再执行」的引擎会被拦死' +
        '（eval 和 blob importScripts 都不行）。' +
        '<br>把引擎打进扩展包再试：' +
        '<br><code>./extension/tools/embed-engine.sh &lt;构建产物目录&gt;</code>' +
        '<br><span class="muted">跑完回 chrome://extensions 点刷新。</span>');
    } else if (err.message === 'MISSING_MODELS') {
      show('s2res', 'bad',
        '<b>缺模型文件</b> —— 你这份引擎没带 <code>.data</code> 预加载包，' +
        '需要 <code>extension/models/</code> 单独提供模型，但那个目录是空的。' +
        '<br><code>./extension/tools/fetch-models.sh</code>' +
        '<br><span class="muted">跑完回 chrome://extensions 点刷新再试。</span>');
    } else if (err.message === 'MISSING_SELFTEST_WAV') {
      // 这不是引擎的问题，别把用户往「拖错文件」上引——仓库默认就不带这个素材。
      show('s2res', 'bad',
        '<b>缺自检素材</b> —— 仓库里不带 <code>extension/assets/selftest.wav</code>。' +
        '<br>跑一下这个脚本会从 sherpa-onnx 官方模型包取一份（可再分发）：' +
        '<br><code>./extension/tools/fetch-models.sh</code>' +
        '<br><span class="muted">跑完回 chrome://extensions 点扩展的刷新图标，再点一次自检。' +
        '想用自己录的「小爱同学」，就替换掉 selftest.wav 并删掉同目录的 selftest.json。</span>');
    } else {
      show('s2res', 'bad', '<b>自检失败：</b>' + (err.message || err) +
        '<br><span class="muted">最常见的原因是拖错了文件——需要的是 ' +
        '<code>sherpa-onnx-wasm-kws-main.js</code>（不是 npm 包里那个 nodejs 版）。</span>');
    }
  } finally {
    $('run').disabled = false;
  }
};

refresh();
