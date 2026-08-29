#!/usr/bin/env bash
# 打分发包：一个 .zip（传应用商店 / 加载已解压）+ 一个 .crx（企业策略部署）
set -e
EXT="$(cd "$(dirname "$0")/.." && pwd)"

# 参数按位置解析会让「--allow-no-engine + 自定义输出目录」两个一起用时静默
# 忽略后者（原来只看 $1）。改成循环，顺序随便写。
ALLOW_NO_ENGINE=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-no-engine) ALLOW_NO_ENGINE=1 ;;
    -*) echo "!! 不认识的参数：$1" >&2; exit 2 ;;
    *)  OUT="$1" ;;
  esac
  shift
done
OUT="${OUT:-$EXT/../dist}"
CHROME="${CHROME:-google-chrome}"
mkdir -p "$OUT"

# 引擎不在就别打包。否则会产出一个看着正常、装上却完全不工作的 zip——
# 干净 clone 之后直接跑这个脚本就会踩到（104KB，没有 wasm）。
if [ ! -f "$EXT/vendor/sherpa-onnx-wasm.wasm" ] && [ -z "$ALLOW_NO_ENGINE" ]; then
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
    --exclude='*.md' --exclude=package.json --exclude=package-lock.json . ) \
  | ( cd "$STAGE" && tar x )

# 发布包里带上许可与第三方声明——Apache-2.0 第 4 条要求随分发件附带
cp "$EXT/../LICENSE" "$EXT/../NOTICE" "$STAGE/" 2>/dev/null || \
  echo "!! 仓库根没有 LICENSE/NOTICE，发布包缺许可文件" >&2

( cd "$STAGE" && zip -qr "$OUT/$NAME.zip" . )
echo "==> $OUT/$NAME.zip  $(du -h "$OUT/$NAME.zip" | cut -f1)   ← 传 Chrome 应用商店用这个"

# ── crx（企业策略部署）─────────────────────────────────────────────
# 私钥决定扩展 ID，换一把 = 换一个扩展，用户的设置全丢。所以**绝不**在没有
# 现成密钥时默默造一把：CI 上那把随 runner 一起销毁，每次构建 ID 都不一样，
# 而 dist/ 里多出来的 .pem 一旦被产物 glob 捞走就是私钥外泄。实测 GitHub
# runner 预装了 google-chrome，这条路默认就会被走到，所以必须显式设防。
KEY="${WW_CRX_KEY:-$EXT/../wakeword-firewall.pem}"
if ! command -v "$CHROME" >/dev/null; then
  echo "== 跳过 crx：没找到 ${CHROME}。要出 crx 就设 CHROME=<chrome路径>。"
elif [ -f "$KEY" ]; then
  "$CHROME" --pack-extension="$STAGE" --pack-extension-key="$KEY" >/dev/null 2>&1 || true
  [ -f "$STAGE.crx" ] && mv "$STAGE.crx" "$OUT/$NAME.crx" && \
    echo "==> $OUT/$NAME.crx   ← 企业策略部署用这个（用已有密钥签的，ID 不变）"
elif [ -n "$WW_NEW_KEY" ]; then
  "$CHROME" --pack-extension="$STAGE" >/dev/null 2>&1 || true
  [ -f "$STAGE.crx" ] && mv "$STAGE.crx" "$OUT/$NAME.crx" && \
    echo "==> $OUT/$NAME.crx"
  echo "!! 新生成了私钥：$OUT/$NAME.pem"
  echo "!! 它决定扩展 ID，**立刻挪到仓库外保存好**。弄丢了就再也发不出同 ID 的更新。"
else
  echo "== 跳过 crx：没有签名密钥（找的是 ${KEY}）。"
  echo "   zip 已经出好了，装扩展/传商店都用它，crx 只有企业策略部署才需要。"
  echo "   第一次要出 crx：WW_NEW_KEY=1 ./extension/tools/pack.sh —— 会生成密钥，"
  echo "   记得把 .pem 挪到仓库外存好，之后每次构建用 WW_CRX_KEY=<路径> 指过去。"
fi
rm -rf "$STAGE"
