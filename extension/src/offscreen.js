/**
 * 检测宿主（offscreen 文档）
 * ==========================
 * 扩展源，不受页面 CSP 管——这是它存在的全部理由，见 offscreen.html 的注释。
 *
 * 职责：
 *  - 起**一个** kws Worker（12MB wasm + 13MB 模型，起一次就够）
 *  - 接受各标签页内容脚本连进来的 Port，按连接分流
 *  - 转发 PCM 进去、命中结果回去
 *
 * PCM 为什么走 base64：chrome.runtime 的消息是 JSON 序列化的，
 * ArrayBuffer 传过去会变成 `{}`（实测），TypedArray 会退化成带数字键的普通对象。
 * base64 让 2560 字节变成 3416 字符，16k 单声道下约 43 KB/s，可以接受。
 */
'use strict';

const L = (...a) => console.log('[唤醒词防火墙/宿主]', ...a);

let worker = null;
let booting = null;                 // 启动中的 Promise，避免并发重复起
const ports = new Map();            // portId -> Port
let nextPortId = 1;

function b64ToI16(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
}

async function ensureWorker(cfg) {
  if (worker) return worker;
  if (booting) return booting;
  booting = (async () => {
    const eng = await window.WWEngineLoader.load();
    if (!eng) throw new Error('NO_ENGINE');
    if (eng.source !== 'bundled') {
      // 用户自装的引擎只有文本形式，而 MV3 扩展页禁 eval、blob importScripts
      // 也被拦，没有办法把它加载起来。必须打进包里。
      throw new Error('ENGINE_NOT_BUNDLED');
    }

    // 配置由内容脚本读好带进来。offscreen 文档拿不到 chrome.storage
    // （它的 API 面比普通扩展页窄，实测 chrome.storage 是 undefined），
    // 而内容脚本本来就有权限，顺手读了一起送过来最省事。
    const keywords = cfg.keywords;

    // 关键：必须用扩展 URL 建 worker（不能是 blob），worker 内部再
    // importScripts 扩展内的胶水。这是 MV3 下唯一不触 CSP 的组合。
    const w = new Worker(chrome.runtime.getURL('src/kws-worker.js'));

    const ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('检测器启动超时（40 秒）')), 40000);
      w.addEventListener('message', function onMsg(e) {
        if (e.data.type === 'ready') { clearTimeout(t); w.removeEventListener('message', onMsg); res(); }
        else if (e.data.type === 'error') { clearTimeout(t); w.removeEventListener('message', onMsg); rej(new Error(e.data.message)); }
      });
      w.onerror = (e) => { clearTimeout(t); rej(new Error(e.message || 'Worker 错误')); };
    });

    w.postMessage({
      type: 'init',
      wasmBinary: eng.wasm, dataPackage: eng.data || null,
      glueUrl: chrome.runtime.getURL('vendor/sherpa-onnx-wasm.js'),
      shimUrl: chrome.runtime.getURL('src/node-shim.js'),
      kwsUrl: chrome.runtime.getURL('vendor/sherpa-onnx-kws.js'),
      models: null, keywords,
      score: cfg.score ?? 2.0, threshold: cfg.threshold ?? 0.25,
      hitLead: cfg.hitLead ?? 1.55, hitTail: cfg.hitTail ?? 0.3,
    }, [eng.wasm, ...(eng.data ? [eng.data] : [])]);

    await ready;

    // 命中结果按 key 前缀路由回对应的那条 Port
    w.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type !== 'hit') return;
      const pid = String(m.key).split(':')[0];
      const port = ports.get(pid);
      if (port) { try { port.postMessage(m); } catch (err) { /* 已断开 */ } }
    });

    worker = w;
    L('检测器就绪');
    return w;
  })().finally(() => { booting = null; });
  return booting;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ww-detect') return;
  const pid = String(nextPortId++);
  ports.set(pid, port);
  L(`标签页接入 #${pid}，当前 ${ports.size} 条`);

  const keys = new Set();

  port.onDisconnect.addListener(() => {
    ports.delete(pid);
    // 把这条连接占的流释放掉，别让关掉的标签页一直占着解码状态
    for (const k of keys) worker && worker.postMessage({ type: 'release', key: k });
    L(`标签页断开 #${pid}，剩 ${ports.size} 条`);
  });

  port.onMessage.addListener(async (m) => {
    try {
      if (m.type === 'start') {
        await ensureWorker(m.cfg || {});
        port.postMessage({ type: 'ready' });
      } else if (m.type === 'pcm') {
        if (!worker) return;
        const key = pid + ':' + m.sbId;
        keys.add(key);
        const i16 = b64ToI16(m.b64);
        worker.postMessage({ type: 'pcm', key, sbId: m.sbId, t: m.t, pcm: i16.buffer },
                           [i16.buffer]);
      } else if (m.type === 'config') {
        if (worker) worker.postMessage(m);
      }
    } catch (err) {
      try { port.postMessage({ type: 'error', message: String(err && err.message || err) }); }
      catch (e) { /* 已断开 */ }
    }
  });
});
