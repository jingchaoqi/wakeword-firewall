#!/usr/bin/env bash
# 在配好的 emsdk 环境里跑一次 sherpa 的 wasm KWS 构建。
# 被 build-loop.py 反复调用，也可以单独跑。
#
# 环境变量（都有默认值，一般不用设）：
#   WW_WORK     工作根目录，默认 ~/ww-build（和 extension/vendor/build-wasm.sh 一致）
#   EMSDK_DIR   emsdk 根目录，默认 $WW_WORK/emsdk
#   SHERPA_DIR  sherpa-onnx 源码目录，默认 $WW_WORK/sherpa-onnx
set -e
WORK="${WW_WORK:-$HOME/ww-build}"
EMSDK_DIR="${EMSDK_DIR:-$WORK/emsdk}"
SHERPA_DIR="${SHERPA_DIR:-$WORK/sherpa-onnx}"

[ -f "$EMSDK_DIR/emsdk_env.sh" ] || { echo "找不到 emsdk：$EMSDK_DIR" >&2; exit 1; }
[ -x "$SHERPA_DIR/build-wasm-simd-kws.sh" ] || { echo "找不到 sherpa-onnx：$SHERPA_DIR" >&2; exit 1; }

# emsdk_env.sh 会把 PATH / EMSDK / EM_CONFIG 都设好，比手写这几个变量可靠
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
cd "$SHERPA_DIR"
./build-wasm-simd-kws.sh
