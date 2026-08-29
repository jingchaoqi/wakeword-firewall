#!/usr/bin/env bash
# 一键装依赖 + 下载模型（约 75MB，全部来自 GitHub Releases）
set -e
cd "$(dirname "$0")"
echo "▸ 安装 Python 依赖"
pip install sherpa-onnx numpy || pip install sherpa-onnx numpy --break-system-packages
for c in ffmpeg ffprobe; do command -v $c >/dev/null || { echo "!! 需要 $c（ffmpeg 套件）：apt install ffmpeg / brew install ffmpeg"; exit 1; }; done

mkdir -p models && cd models
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
get(){ [ -d "$2" ] && { echo "  已存在 $2"; return; }
       echo "▸ 下载 $2"; curl -L --progress-bar -o t.tar.bz2 "$1" && tar xjf t.tar.bz2 && rm t.tar.bz2; }
get "$B/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2" \
    "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
get "$B/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2" \
    "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
echo "▸ 完成。试试:  python3 scan.py 你的视频.mp4"
