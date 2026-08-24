#!/usr/bin/env bash
# 打分发包：一个 .zip（传应用商店 / 加载已解压）+ 一个 .crx（企业策略部署）
set -e
EXT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$EXT/../dist}"
CHROME="${CHROME:-google-chrome}"
mkdir -p "$OUT"

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
