#!/usr/bin/env bash
# 从干净 clone 到可安装的扩展包，一条命令
# =========================================
#   ./extension/tools/build-all.sh
#
# 做四件事，每一步都会跳过已经完成的：
#   1. 编 wasm 引擎        ~20–40 分钟，一次性（仓库不带这 25MB 二进制）
#   2. 取模型和自检素材    ~32 MB，来自 sherpa-onnx 官方发布
#   3. 把引擎打进扩展包
#   4. 出 dist/*.zip
#
# 想跳过打包只把本地的 extension/ 弄成可加载状态：BUILD_ONLY=1
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$EXT/.." && pwd)"
WORK="${WW_WORK:-$HOME/ww-build}"
OUT_WASM="$WORK/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

step "0/4 检查依赖"
missing=""
for c in git cmake make python3 curl; do have "$c" || missing="$missing $c"; done
[ -n "$missing" ] && { echo "!! 缺:$missing"; exit 1; }
echo "   齐了"

# ── 1. 引擎 ─────────────────────────────────────────────────────────
if [ -f "$EXT/vendor/sherpa-onnx-wasm.wasm" ]; then
  step "1/4 引擎已在 vendor/，跳过编译"
  ls -lh "$EXT/vendor/"sherpa-onnx-wasm.* | awk '{printf "   %-34s %s\n", $9, $5}'
elif [ -f "$OUT_WASM/sherpa-onnx-wasm-kws-main.wasm" ]; then
  step "1/4 已有构建产物（${OUT_WASM}），跳过编译"
else
  step "1/4 编 wasm 引擎（20–40 分钟，只此一次）"
  echo "   官方没有发布 KWS 的浏览器 wasm，npm 那份是 Node 专用构建，必须自己编。"
  "$EXT/vendor/build-wasm.sh" "$WORK"
fi

# ── 2. 模型与自检素材 ───────────────────────────────────────────────
# models/ 不是永远都该在：引擎自带 .data 预加载包时，embed-engine 会主动删掉它
# （模型已经在 .data 里，留着白占 5MB）。所以判据是「素材在 + 模型有着落」，
# 不能硬要求 models/ 存在——否则每次跑都会重下 32MB。
if [ -f "$EXT/assets/selftest.wav" ] && \
   { [ -f "$EXT/vendor/sherpa-onnx-wasm.data" ] || [ -d "$EXT/models" ]; }; then
  step "2/4 模型与自检素材已就位，跳过"
else
  step "2/4 取模型与自检素材"
  "$HERE/fetch-models.sh"
fi

# ── 3. 打进包 ───────────────────────────────────────────────────────
# 注意顺序：embed-engine 在引擎自带 .data 时会删掉 models/（模型已在 .data 里，
# 留着白占 5MB）。所以必须放在 fetch-models 之后。
if [ -f "$EXT/vendor/sherpa-onnx-wasm.wasm" ]; then
  step "3/4 引擎已内置，跳过"
else
  step "3/4 把引擎打进扩展包"
  "$HERE/embed-engine.sh" "$OUT_WASM"
fi

# build-wasm.sh 自己就会把产物拷进 vendor/，所以上面那个 embed-engine 分支在
# 完整流程里几乎永远走不到，而模型去重恰好写在 embed-engine 里——结果每次出的
# 包都白白多背 5.7MB 的 models/（.data 里已经有一份，engine-loader 拿到 .data
# 就再也不看 models/）。去重挪到这里，跟 embed-engine 走哪条分支无关。
if [ -f "$EXT/vendor/sherpa-onnx-wasm.data" ] && [ -d "$EXT/models" ]; then
  echo "   .data 预加载包已含模型，移除重复的 models/（省 $(du -sh "$EXT/models" | cut -f1)）"
  rm -rf "$EXT/models"
fi

echo
echo "   extension/ 现在可以直接在 chrome://extensions 用「加载已解压」装了"

# ── 4. 打包 ─────────────────────────────────────────────────────────
if [ -n "$BUILD_ONLY" ]; then
  step "4/4 BUILD_ONLY=1，跳过打包"
else
  step "4/4 打包"
  "$HERE/pack.sh" "${1:-$ROOT/dist}"
fi

step "完成"
