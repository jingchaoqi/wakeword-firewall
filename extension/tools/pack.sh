#!/usr/bin/env bash
# 打分发包：一个 .zip（传应用商店 / 加载已解压）+ 一个 .crx（企业策略部署）
set -e
EXT="$(cd "$(dirname "$0")/.." && pwd)"
ARG1="$1"
[ "$ARG1" = "--allow-no-engine" ] && ARG1=""
OUT="${ARG1:-$EXT/../dist}"
CHROME="${CHROME:-google-chrome}"
mkdir -p "$OUT"

# 引擎不在就别打包。否则会产出一个看着正常、装上却完全不工作的 zip——
# 干净 clone 之后直接跑这个脚本就会踩到（104KB，没有 wasm）。
if [ ! -f "$EXT/vendor/sherpa-onnx-wasm.wasm" ] && [ "$1" != "--allow-no-engine" ]; then
  cat >&2 <<'MSG'
!! 检测引擎不在包里，拒绝打包。

   打出来的 zip 装上去不会工作——vendor/sherpa-onnx-wasm.wasm 缺失。
   仓库里不带这 25MB 二进制，需要本地编一次：

       ./extension/tools/build-all.sh      # 一条命令走完全流程（首次约 20–40 分钟）

   或者分步：
       ./extension/vendor/build-wasm.sh
       ./extension/tools/embed-engine.sh ~/ww-build/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm

   确实要打一个不含引擎的包（比如只看目录结构）：
       ./extension/tools/pack.sh --allow-no-engine
MSG
  exit 1
fi

# 自检素材缺了不致命，但发布包里该有——引导页第 2 步靠它
if [ ! -f "$EXT/assets/selftest.wav" ]; then
  echo "!! assets/selftest.wav 不在，引导页的自检会提示缺素材。" >&2
  echo "   跑 ./extension/tools/fetch-models.sh 补上。" >&2
fi

VER=$(python3 -c "import json;print(json.load(open('$EXT/manifest.json'))['version'])")
NAME="wakeword-firewall-$VER"

# 商店包不要带开发用的东西
STAGE="$OUT/$NAME"
rm -rf "$STAGE"; mkdir -p "$STAGE"
( cd "$EXT" && tar c --exclude=test --exclude=tools --exclude=node_modules \
    --exclude='*.md' . ) | ( cd "$STAGE" && tar x )

( cd "$STAGE" && zip -qr "$OUT/$NAME.zip" . )
echo "==> $OUT/$NAME.zip  $(du -h "$OUT/$NAME.zip" | cut -f1)   ← 传 Chrome 应用商店用这个"

if command -v "$CHROME" >/dev/null; then
  KEY="$EXT/../wakeword-firewall.pem"
  if [ -f "$KEY" ]; then
    "$CHROME" --pack-extension="$STAGE" --pack-extension-key="$KEY" >/dev/null 2>&1 || true
  else
    "$CHROME" --pack-extension="$STAGE" >/dev/null 2>&1 || true
    echo "!! 新生成了私钥，务必保存：$OUT/$NAME.pem（决定扩展 ID）"
  fi
  [ -f "$STAGE.crx" ] && mv "$STAGE.crx" "$OUT/$NAME.crx" && \
    echo "==> $OUT/$NAME.crx   ← 企业策略部署用这个"
else
  echo "!! 没找到 $CHROME，跳过 crx。设置 CHROME=<chrome路径> 再跑一次即可。"
fi
rm -rf "$STAGE"
