# vendor 目录

第三方代码与编译产物。许可见仓库根的 [NOTICE](../../NOTICE)。

| 文件 | 入库？ | 来源 |
|---|---|---|
| `sherpa-onnx-kws.js` | ✅ 在仓库里 | sherpa-onnx 上游 `wasm/kws/sherpa-onnx-kws.js` 的**逐字节副本**，未改一个字符。纯 JS 封装，与环境无关 |
| `build-wasm.sh` | ✅ 在仓库里 | 本项目写的编译脚本 |
| `sherpa-onnx-wasm.js` | ❌ 需自己编 | `build-wasm-simd-kws.sh` 的产物，约 80 KB |
| `sherpa-onnx-wasm.wasm` | ❌ 需自己编 | 同上，约 12 MB |
| `sherpa-onnx-wasm.data` | ❌ 需自己编 | 同上，约 13 MB，模型预加载包 |

后三个被 `.gitignore` 挡着，**干净 clone 之后这里只有两个文件**，这是正常的。
补齐的办法是一条命令：

```bash
./extension/tools/build-all.sh
```

它会编引擎、取模型、打包，每步都跳过已完成的。首次约 20–40 分钟。
`build-wasm.sh` 编完会**自己把产物拷进这个目录**，不需要你手动搬。

> 想同步上游的 `sherpa-onnx-kws.js`，直接和 sherpa-onnx 仓库里那份 `diff`
> 即可——我们没加任何本地修改，包括版权头（上游那份也没有）。

## 为什么必须自己编

两条看起来更省事的路都是死的，都撞过：

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
可自行核对上游的 `.github/workflows/wasm-simd-hf-space-*.yaml`——
一共十个，没有 kws 那一个。

## 模型去哪了

`build-wasm-simd-kws.sh` 用 `--preload-file assets@.` 把模型打进了 `.data`，
所以模型已经在 wasm 的虚拟文件系统里，**不需要再单独 fetch**。

`src/kws-worker.js` 和 `src/engine-loader.js` 已经按这个前提写好了：
拿得到 `.data` 就走预加载路径，拿不到才回落去 `models/` 取。
`build-all.sh` 也会在检测到 `.data` 时删掉重复的 `models/`（省 5.3 MB）。

**这些都是自动的，不需要你改任何源码。**（旧版本的这份 README 让人手动去改
`kws-worker.js`，那份指引已经过时——照做反而会改坏。）
