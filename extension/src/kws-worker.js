/**
 * 唤醒词检测 Worker
 * ==================
 * 在独立线程里跑 sherpa-onnx 的 WASM 构建。主线程只负责喂 16k 单声道 PCM，
 * 这边攒够就解码，命中就回报 [起, 止] 区间。
 *
 * 之所以放 Worker：推理会持续吃 CPU，放主线程会卡 UI，放 AudioWorklet 会爆音。
 */
'use strict';

let spotter = null, stream = null, base = null;
// 静音区间 = [报警时刻 - hitLead, 报警时刻 + hitTail]
// hitLead：报警点往前推多久算唤醒词起点。P0 实测报警滞后中位 1.20s，取 1.55s 留余量。
// hitTail：唤醒词之后再多静音多久 —— 这一段决定挡不挡得住「小爱同学，打开卧室灯」里的指令。
let hitLead = 1.55;
let hitTail = 0.3;
let pendingT = null;     // 当前帧对应的媒体时间
let sbId = null;

function say(msg) { self.postMessage(msg); }

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await boot(m);
      say({ type: 'ready' });
    } catch (err) {
      say({ type: 'error', message: String(err && err.message || err) });
    }
  } else if (m.type === 'pcm') {
    feed(m.sbId, m.t, new Int16Array(m.pcm));
  } else if (m.type === 'config') {
    if (typeof m.hitLead === 'number') hitLead = m.hitLead;
    if (typeof m.hitTail === 'number') hitTail = m.hitTail;
    say({ type: 'config-ok', hitLead, hitTail });
  }
};

async function boot(opts) {
  const { wasmBinary, dataPackage, models, keywords, score, threshold, glue } = opts;
  if (typeof opts.hitLead === 'number') hitLead = opts.hitLead;
  if (typeof opts.hitTail === 'number') hitTail = opts.hitTail;

  // 两种胶水形态都要支持：
  //  a) 官方 build-wasm-simd-kws.sh 的产物 —— 非 MODULARIZE，
  //     全局 `var Module`，靠 onRuntimeInitialized 回调通知就绪
  //  b) npm 包里的 —— MODULARIZE，导出一个返回 Promise 的工厂函数
  // 关键：(a) 必须在胶水执行**之前**把 Module 配置好，因为它是
  //   `var Module = typeof Module != "undefined" ? Module : {}`
  let mod = null;

  if (glue) {
    const cfg = { wasmBinary };
    if (dataPackage) {
      // 模型被 --preload-file 打进了 .data，这个钩子让胶水直接吃我们递过去的
      // 字节，而不是自己去 fetch 一个取不到的相对路径
      cfg.getPreloadedPackage = () => dataPackage;
      cfg.locateFile = (p) => p;
    }
    self.Module = cfg;
    const ready = new Promise((res, rej) => {
      cfg.onRuntimeInitialized = () => res();
      cfg.onAbort = (w) => rej(new Error('wasm 启动失败: ' + w));
      setTimeout(() => rej(new Error('等待 wasm 运行时就绪超时（30 秒）')), 30000);
    });
    // 必须用间接 eval 走全局作用域，否则胶水里的 `var Module` 会变成局部变量
    (0, eval)(glue);
    if (typeof self.Module === 'function') {
      mod = await self.Module(cfg);              // 形态 b
    } else {
      await ready;                               // 形态 a
      mod = self.Module;
    }
  } else if (typeof self.Module === 'function') {
    mod = await self.Module({ wasmBinary });
  } else {
    throw new Error('没拿到 wasm 胶水');
  }

  if (typeof mod._SherpaOnnxCreateKeywordSpotter !== 'function') {
    throw new Error('wasm 运行时缺 KWS 导出（胶水和引擎不是同一份构建？）');
  }
  // 注意：官方构建没有把 FS 放进 EXPORTED_RUNTIME_METHODS，
  // 所以只有在需要自己写模型进去时才要求它。带 .data 的构建不需要。

  // 两种情况：引擎自带 .data（模型已在虚拟文件系统里），或我们自己写进去
  let paths;
  if (dataPackage) {
    paths = {
      encoder: 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
      decoder: 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
      joiner: 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
      tokens: 'tokens.txt',
    };
    // .data 由 getPreloadedPackage 喂进来，模型已在虚拟文件系统里。
    // FS 没导出就没法 stat 校验，交给 createKws 自己报错。
  } else if (models) {
    if (!mod.FS) throw new Error('这份引擎没导出 FS，无法写入模型；请改用带 .data 的构建');
    mod.FS.writeFile('/encoder.onnx', new Uint8Array(models.encoder));
    mod.FS.writeFile('/decoder.onnx', new Uint8Array(models.decoder));
    mod.FS.writeFile('/joiner.onnx', new Uint8Array(models.joiner));
    mod.FS.writeFile('/tokens.txt', new Uint8Array(models.tokens));
    paths = { encoder: '/encoder.onnx', decoder: '/decoder.onnx',
              joiner: '/joiner.onnx', tokens: '/tokens.txt' };
  } else {
    throw new Error('既没有 .data 预加载包，也没有单独的模型文件');
  }

  const kwBuf = keywords.endsWith('\n') ? keywords : keywords + '\n';
  const cfg2 = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens, numThreads: 1, provider: 'cpu', debug: 0,
    },
    maxActivePaths: 4,
    keywordsScore: score ?? 2.0,
    keywordsThreshold: threshold ?? 0.25,
    numTrailingBlanks: 1,
    keywords: '',
    keywordsBuf: kwBuf,
    keywordsBufSize: new TextEncoder().encode(kwBuf).length,
  };
  spotter = self.createKws(mod, cfg2);
  stream = spotter.createStream();
  base = mod;
}

function waitFor(pred, ms, msg) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function loop() {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(msg));
      setTimeout(loop, 30);
    })();
  });
}

function feed(id, t, i16) {
  if (!spotter || !stream) return;
  sbId = id;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const tEnd = t + i16.length / 16000;

  stream.acceptWaveform(16000, f32);
  while (spotter.isReady(stream)) spotter.decode(stream);
  const r = spotter.getResult(stream);
  if (r && r.keyword) {
    spotter.reset(stream);
    const span = [Math.max(0, tEnd - hitLead), tEnd + hitTail];
    say({ type: 'hit', sbId: id, keyword: r.keyword, at: tEnd, span });
  }
}
