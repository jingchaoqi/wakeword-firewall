#!/usr/bin/env bash
# 给扩展准备模型和自检素材
# =========================
# 两件事，都是从 sherpa-onnx 官方发布（Apache-2.0）取的：
#
#   1) extension/models/   —— 引擎构建不带 .data 预加载包时的模型来源。
#      官方的 build-wasm-simd-kws.sh 会用 --preload-file 把模型打进 .data，
#      那种情况下这个目录用不上（embed-engine.sh 会自动删掉它）。
#      但自己改构建参数、或用别的方式编出来的引擎可能没有 .data，
#      那就得靠这个目录。在这个脚本之前，这条回退路径**没有任何办法准备**。
#
#   2) extension/assets/selftest.wav —— 引导页第 2 步的自检素材。
#      用官方模型包自带的 test_wavs/3.wav（8.03 秒，KWS 实测单一命中
#      「文森特卡索」）。选它是因为它可以合法再分发，不像私人视频截出来的片段。
#      同时写一份 selftest.json 告诉引导页该拿什么词表去认、期望认出什么。
#
# 用法： ./extension/tools/fetch-models.sh
set -e
EXT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

P=sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$P.tar.bz2"

echo "▸ 下载 KWS 模型（约 32 MB）"
curl -L --progress-bar -o "$TMP/kws.tar.bz2" "$URL"
tar xjf "$TMP/kws.tar.bz2" -C "$TMP"
M="$TMP/$P"

echo "▸ 装模型到 extension/models/"
mkdir -p "$EXT/models"
# 名字要和 src/content.js、src/welcome.js 里写的一致。
# encoder/joiner 用 int8（体积小、P0 实测精度够），decoder 本来就小，用 fp32。
cp "$M/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$EXT/models/encoder.int8.onnx"
cp "$M/decoder-epoch-12-avg-2-chunk-16-left-64.onnx"      "$EXT/models/decoder.onnx"
cp "$M/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"  "$EXT/models/joiner.int8.onnx"
cp "$M/tokens.txt"                                        "$EXT/models/tokens.txt"

echo "▸ 装自检素材到 extension/assets/"
mkdir -p "$EXT/assets"
cp "$M/test_wavs/3.wav" "$EXT/assets/selftest.wav"
cat > "$EXT/assets/selftest.json" <<'JSON'
{
  "_comment": "引导页自检用。素材来自 sherpa-onnx 官方 KWS 模型包的 test_wavs/3.wav（Apache-2.0），不是唤醒词录音——自检要验的是引擎链路通不通，用哪个词无所谓。想换成自己录的「小爱同学」，替换 selftest.wav 并把 keywords/expect 改掉即可。",
  "source": "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/test_wavs/3.wav",
  "keywords": "w én s ēn t è k ǎ s uǒ @文森特卡索",
  "expect": "文森特卡索"
}
JSON

echo
echo "▸ 完成："
ls -lh "$EXT/models" | tail -n +2 | awk '{printf "    models/%-20s %s\n", $9, $5}'
ls -lh "$EXT/assets" | tail -n +2 | awk '{printf "    assets/%-20s %s\n", $9, $5}'
echo
echo "▸ 下一步：chrome://extensions 点扩展卡片上的刷新，再跑一遍引导页的自检。"
