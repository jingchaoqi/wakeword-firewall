# vendor 目录

| 文件 | 状态 |
|---|---|
| `sherpa-onnx-kws.js` | ✅ 来自 npm `sherpa-onnx@1.13.6`，纯 JS 封装，与环境无关，可直接用 |
| `sherpa-onnx-wasm.js` | ⚠️ 目前是 npm 的 Node 版胶水，**换成自编产物后覆盖它** |
| `sherpa-onnx-wasm.wasm` | ❌ **缺失** —— 跑 `./build-wasm.sh` |

## 为什么必须自己编

两条看起来更省事的路都是死的，我都撞过：

**1. npm 包自带的 wasm 用不了。** `sherpa-onnx@1.13.6` 里的
`sherpa-onnx-wasm-nodejs.wasm` 是用 `-sNODERAWFS=1` 构建的——文件系统硬绑
Node 的真实 FS，MEMFS 被禁用。浏览器里一加载就抛：

```
NODERAWFS is currently only supported on Node.js environment.
```

这不是配置问题，是构建目标不同。（顺带一提，这个 wasm 在 **Node 里**是好用的，
P0 阶段就是用它验证的，结果和 Python 版完全一致。）

**2. 官方没有发布 KWS 的浏览器 wasm。** k2-fsa 在 Huggingface Space 上
只放了 ASR / TTS / VAD / 说话人分离 / 语音增强的 wasm，**没有 KWS**。
可自行核对仓库里的 `.github/workflows/wasm-simd-hf-space-*.yaml`——
一共十个，没有 kws 那一个。

## 编完之后要改一处代码

官方的 `build-wasm-simd-kws.sh` 会用 `--preload-file assets@.` 把模型
预打包进 `.data` 文件。也就是说模型已经在虚拟文件系统里了，
`src/kws-worker.js` 里手动 `FS.writeFile` 的那四行要去掉，
路径改成 assets 里的原始文件名：

```js
// 改成（模型已由 .data 预加载，无需写入）
transducer: {
  encoder: './encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  decoder: './decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  joiner:  './joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
},
tokens: './tokens.txt',
```

同时 `src/content.js` 里就不用再 fetch `models/*` 了，改成 fetch
`vendor/sherpa-onnx-wasm.data` 并通过 `Module.getPreloadedPackage`
或 `locateFile` 交给胶水。

`src/node-shim.js` 那层 `require("path")` 垫片大概率也不再需要
（浏览器构建不会有那句无条件的 require），但留着无害。
