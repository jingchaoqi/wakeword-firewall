#!/usr/bin/env bash
# 构建浏览器版 sherpa-onnx KWS wasm
# =================================
# 没有现成产物可下。k2-fsa 官方只为 ASR / TTS / VAD / 说话人分离
# 发布了 Huggingface Space 的 wasm，**没有 KWS 的**（可查
# sherpa-onnx 仓库 .github/workflows/wasm-simd-hf-space-*.yaml，里面没有 kws）。
#
# npm 包里那个 wasm 是 -sNODERAWFS=1 构建的，浏览器里会抛
# "NODERAWFS is currently only supported on Node.js environment"，用不了。
#
# 所以只能自己编一次。约 20–40 分钟，一次搞定，产物 ~16MB。
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$HOME/ww-build}"
mkdir -p "$WORK" && cd "$WORK"

echo "==> 1/4 安装 emsdk 4.0.23（sherpa 官方指定版本，别用其它版本）"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install 4.0.23
./emsdk activate 4.0.23
source ./emsdk_env.sh
cd "$WORK"

echo "==> 2/4 拉 sherpa-onnx"
[ -d sherpa-onnx ] || git clone --depth 1 https://github.com/k2-fsa/sherpa-onnx.git
cd sherpa-onnx/wasm/kws/assets

echo "==> 3/4 放模型（用 fp32，构建脚本要的就是这四个文件名）"
if [ ! -f encoder-epoch-12-avg-2-chunk-16-left-64.onnx ]; then
  P=sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01
  curl -L -o m.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$P.tar.bz2"
  tar xf m.tar.bz2 && rm m.tar.bz2
  mv $P/encoder-epoch-12-avg-2-chunk-16-left-64.onnx ./
  mv $P/decoder-epoch-12-avg-2-chunk-16-left-64.onnx ./
  mv $P/joiner-epoch-12-avg-2-chunk-16-left-64.onnx ./
  mv $P/tokens.txt ./
  rm -rf $P
fi
ls -lh
cd "$WORK/sherpa-onnx"

echo "==> 4/4 编译（CPU 少就把 -j8 调小，否则可能 OOM）"
./build-wasm-simd-kws.sh

OUT="$WORK/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm"
echo
echo "==> 产物在 $OUT"
ls -lh "$OUT"
cp "$OUT/sherpa-onnx-wasm-kws-main.js"   "$HERE/sherpa-onnx-wasm.js"
cp "$OUT/sherpa-onnx-wasm-kws-main.wasm" "$HERE/sherpa-onnx-wasm.wasm"
[ -f "$OUT/sherpa-onnx-wasm-kws-main.data" ] && \
  cp "$OUT/sherpa-onnx-wasm-kws-main.data" "$HERE/sherpa-onnx-wasm.data"
echo "==> 已拷贝到 $HERE"
echo
echo "这个构建把模型预加载进了 .data，扩展里 models/ 那份就用不上了。"
echo "源码已经按这个前提写好（kws-worker.js 会自动选路径），不用改任何代码。"
echo "下一步：./extension/tools/build-all.sh 会接着去重 models/ 并打包。"
