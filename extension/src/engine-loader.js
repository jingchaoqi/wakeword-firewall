/**
 * 引擎加载策略
 * ============
 * 优先级：
 *   1) 打进扩展包的 vendor/sherpa-onnx-wasm.{js,wasm,data}  ← 分发时应该走这条
 *   2) 用户自己在引导页装的（存 chrome.storage.local）      ← 自建/开发时的兜底
 *
 * 之所以以「打进包里」为主：Chrome 应用商店禁止加载远程代码，wasm 也算代码。
 * 引擎必须随包分发，用户才可能一键装好。
 */
(function (root) {
  'use strict';
  const U = (p) => chrome.runtime.getURL(p);

  async function tryBundled() {
    try {
      const r = await fetch(U('vendor/sherpa-onnx-wasm.wasm'));
      if (!r.ok) return null;
      const wasm = await r.arrayBuffer();
      const glue = await fetch(U('vendor/sherpa-onnx-wasm.js')).then(x => x.text());
      // .data 是可选的，而且扩展页里 fetch 不存在的资源是 **抛异常** 不是返 404，
      // 所以必须单独包一层 try，否则会把整个「引擎已内置」误判成没装。
      let data = null;
      try {
        const d = await fetch(U('vendor/sherpa-onnx-wasm.data'));
        if (d.ok) data = await d.arrayBuffer();
      } catch (e) { /* 没有 .data，模型走 models/ */ }
      return { glue, wasm, data, source: 'bundled' };
    } catch (e) { return null; }
  }

  // 用户自装那条路要读 chrome.storage。offscreen 文档拿不到它（API 面比普通
  // 扩展页窄，chrome.storage 实测是 undefined），直接调会抛
  // "Cannot read properties of undefined (reading 'local')" ——
  // 于是「引擎没编」这件事就变成一句没头没脑的 TypeError，
  // 内容脚本认不出 NO_ENGINE，页面上什么提示都没有。这里明确挡一下。
  function canReadStore() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      && root.WWEngine;
  }

  async function load() {
    const b = await tryBundled();
    if (b) return b;
    if (!canReadStore()) return null;
    const st = await root.WWEngine.status();
    if (!st.installed) return null;
    const [glue, wasm, data] = await Promise.all([
      root.WWEngine.getText('glue'), root.WWEngine.getBinary('wasm'),
      root.WWEngine.getBinary('data'),
    ]);
    return { glue, wasm, data, source: 'user' };
  }

  async function probe() {
    const b = await tryBundled();
    if (b) return { installed: true, source: 'bundled',
                    wasm: b.wasm.byteLength, data: b.data ? b.data.byteLength : 0,
                    glue: b.glue.length };
    if (!canReadStore()) return { installed: false, source: null };
    const st = await root.WWEngine.status();
    return Object.assign({ source: st.installed ? 'user' : null }, st);
  }

  root.WWEngineLoader = { load, probe };
})(typeof self !== 'undefined' ? self : this);
