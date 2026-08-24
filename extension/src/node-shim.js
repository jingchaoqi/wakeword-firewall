/**
 * 给 sherpa-onnx 的 wasm 胶水打的一层薄垫片
 * ---------------------------------------
 * npm 上的 sherpa-onnx 是按 Node 环境构建的，胶水里有一句无条件的
 * `require("path")`。在 Worker 里没有 require，会直接抛错。
 * 这里补一个只实现胶水真正用到的五个函数的 path 垫片。
 * （胶水实际用到：isAbsolute / normalize / dirname / basename / join）
 */
(function (g) {
  if (typeof g.require === 'function') return;

  function normalize(p) {
    const abs = p.charAt(0) === '/';
    const parts = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
        else if (!abs) parts.push('..');
      } else parts.push(seg);
    }
    let out = parts.join('/');
    if (abs) out = '/' + out;
    return out || (abs ? '/' : '.');
  }

  const path = {
    isAbsolute: (p) => String(p).charAt(0) === '/',
    normalize,
    dirname(p) {
      p = String(p);
      const i = p.lastIndexOf('/');
      if (i < 0) return '.';
      if (i === 0) return '/';
      return p.slice(0, i);
    },
    basename(p) {
      p = String(p).replace(/\/+$/, '');
      const i = p.lastIndexOf('/');
      return i < 0 ? p : p.slice(i + 1);
    },
    join(...a) { return normalize(a.filter(Boolean).join('/')); },
  };

  g.require = function (name) {
    if (name === 'path') return path;
    // fs / crypto 只在 ENVIRONMENT_IS_NODE 分支里用得到，浏览器走不到
    throw new Error('本环境不提供 Node 模块: ' + name);
  };
})(typeof self !== 'undefined' ? self : this);
