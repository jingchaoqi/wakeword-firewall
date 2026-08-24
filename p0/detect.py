#!/usr/bin/env python3
"""
唤醒词检测器 —— P0 测评核心。
把任意音频重采样成 16k 单声道，流式喂给 sherpa-onnx KeywordSpotter，
输出 [(命中时刻秒, 关键词)]。命中时刻 ≈ 唤醒词结束时间。
"""
import os, subprocess, tempfile, wave
import numpy as np
import sherpa_onnx

ROOT = os.path.dirname(os.path.abspath(__file__))
ZH = os.path.join(ROOT, "models", "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01")

CHUNK_S = 0.1  # 每次喂 100ms，时间分辨率


def load_16k_mono(path):
    """任意格式 → 16k 单声道 float32。用 ffmpeg，所以 mp4/webm/m4a 都能直接吃。"""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", path,
             "-ac", "1", "-ar", "16000", "-f", "wav", tmp],
            check=True,
        )
        with wave.open(tmp, "rb") as w:
            n = w.getnframes()
            raw = w.readframes(n)
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        return a
    finally:
        os.unlink(tmp)


def make_spotter(model_dir=ZH, keywords_file=None, score=1.0, threshold=0.25,
                 num_trailing_blanks=1, use_int8=True, num_threads=2):
    def pick(stem):
        p8 = os.path.join(model_dir, f"{stem}.int8.onnx")
        p = os.path.join(model_dir, f"{stem}.onnx")
        return p8 if (use_int8 and os.path.exists(p8)) else p

    import glob
    enc = glob.glob(os.path.join(model_dir, "encoder-*chunk-16-left-64.onnx"))[0]
    stem = os.path.basename(enc)[: -len(".onnx")]
    tail = stem[len("encoder-"):]

    return sherpa_onnx.KeywordSpotter(
        tokens=os.path.join(model_dir, "tokens.txt"),
        encoder=pick("encoder-" + tail),
        decoder=pick("decoder-" + tail),
        joiner=pick("joiner-" + tail),
        num_threads=num_threads,
        max_active_paths=4,
        keywords_file=keywords_file or os.path.join(model_dir, "keywords.txt"),
        keywords_score=score,
        keywords_threshold=threshold,
        num_trailing_blanks=num_trailing_blanks,
        provider="cpu",
    )


def detect(spotter, samples, sr=16000, keywords=None):
    """返回 [(t_end_seconds, keyword)]"""
    s = spotter.create_stream(keywords) if keywords else spotter.create_stream()
    hits = []
    step = int(sr * CHUNK_S)
    for i in range(0, len(samples), step):
        chunk = samples[i:i + step]
        s.accept_waveform(sr, chunk)
        while spotter.is_ready(s):
            spotter.decode_stream(s)
        r = spotter.get_result(s)
        if r:
            t = (i + len(chunk)) / sr
            hits.append((round(t, 2), r))
            spotter.reset_stream(s)
    # flush
    tail = np.zeros(int(sr * 0.5), dtype=np.float32)
    s.accept_waveform(sr, tail)
    s.input_finished()
    while spotter.is_ready(s):
        spotter.decode_stream(s)
    r = spotter.get_result(s)
    if r:
        hits.append((round(len(samples) / sr, 2), r))
    return hits


def detect_file(spotter, path, keywords=None):
    return detect(spotter, load_16k_mono(path), 16000, keywords)


if __name__ == "__main__":
    import sys
    sp = make_spotter()
    for f in sys.argv[1:]:
        hits = detect_file(sp, f)
        print(f"{os.path.basename(f):40s} -> {hits}")
