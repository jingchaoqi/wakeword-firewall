/**
 * 引擎存储
 * ========
 * 浏览器版 wasm 没有官方产物、必须自编，所以不适合硬打进扩展包。
 * 改成：用户在引导页把编好的文件拖进来存起来，之后一直可用，
 * 换引擎、升级引擎都不用重新打包扩展。
 *
 * 为什么用 chrome.storage.local 而不是 IndexedDB：
 * 内容脚本虽然跑在扩展的 ISOLATED world，但它的 IndexedDB 是**页面**那个源的，
 * 读不到引导页（扩展源）写进去的东西。chrome.storage.local 才是两边共享的那个。
 * 代价是只能存字符串，所以二进制走 base64。
 */
(function (root) {
  'use strict';

  const KEYS = { glue: 'eng_glue', wasm: 'eng_wasm', data: 'eng_data' };

  function toB64(ab) {
    const u = new Uint8Array(ab);
    let s = '';
    const CH = 0x8000;                       // 分块，避免 apply 参数过多爆栈
    for (let i = 0; i < u.length; i += CH) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    }
    return btoa(s);
  }

  function fromB64(b64) {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }

  const api = {
    async putBinary(kind, ab) {
      await chrome.storage.local.set({ [KEYS[kind]]: toB64(ab) });
    },
    async putText(kind, t) {
      await chrome.storage.local.set({ [KEYS[kind]]: t });
    },
    async getBinary(kind) {
      const r = await chrome.storage.local.get(KEYS[kind]);
      const v = r[KEYS[kind]];
      return v ? fromB64(v) : null;
    },
    async getText(kind) {
      const r = await chrome.storage.local.get(KEYS[kind]);
      return r[KEYS[kind]] || null;
    },
    async clear() {
      await chrome.storage.local.remove(Object.values(KEYS));
    },
    /** 只看有没有、多大，不解码，便宜 */
    async status() {
      const r = await chrome.storage.local.get(Object.values(KEYS));
      const size = (k) => {
        const v = r[KEYS[k]];
        if (!v) return 0;
        return k === 'glue' ? v.length : Math.floor(v.length * 3 / 4);
      };
      const glue = size('glue'), wasm = size('wasm'), data = size('data');
      return { installed: !!(glue && wasm), glue, wasm, data };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWEngine = api;
})(typeof self !== 'undefined' ? self : this);
