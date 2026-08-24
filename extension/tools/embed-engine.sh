#!/usr/bin/env bash
# 把编好的引擎打进扩展包 —— 分发前跑这一次，之后所有用户零配置
#
#   ./tools/embed-engine.sh <构建产物目录>
#   例：./tools/embed-engine.sh ~/ww-build/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm
#
# 干完这一步，vendor/ 里就有引擎了，用户装上扩展直接能用，
# 引导页的第 1 步会自动标记为「已内置，无需任何操作」。
set -e
EXT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?用法: ./tools/embed-engine.sh <构建产物目录>}"

need() { [ -f "$1" ] || { echo "!! 找不到 $1"; exit 1; }; }
need "$SRC/sherpa-onnx-wasm-kws-main.js"
need "$SRC/sherpa-onnx-wasm-kws-main.wasm"

cp "$SRC/sherpa-onnx-wasm-kws-main.js"   "$EXT/vendor/sherpa-onnx-wasm.js"
cp "$SRC/sherpa-onnx-wasm-kws-main.wasm" "$EXT/vendor/sherpa-onnx-wasm.wasm"

if [ -f "$SRC/sherpa-onnx-wasm-kws-main.data" ]; then
  cp "$SRC/sherpa-onnx-wasm-kws-main.data" "$EXT/vendor/sherpa-onnx-wasm.data"
  # 模型已经在 .data 里，包里那份单独的就是纯浪费体积
  if [ -d "$EXT/models" ]; then
    echo "==> 检测到 .data 预加载包，移除重复的 models/（省 5MB）"
    rm -rf "$EXT/models"
  fi
else
  echo "==> 没有 .data，保留 models/ 作为模型来源"
fi

echo
echo "==> 已内置的引擎："
ls -lh "$EXT/vendor/" | grep sherpa-onnx-wasm
echo
echo "==> 扩展总大小： $(du -sh "$EXT" | cut -f1)"
echo "==> 下一步：./tools/pack.sh 打包，或直接在 chrome://extensions 加载已解压"
