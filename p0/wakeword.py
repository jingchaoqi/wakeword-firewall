#!/usr/bin/env python3
"""
唤醒词防火墙 · P0 检测核心
--------------------------------
两级流水线，和扩展里预扫描要做的事完全一致：
  一级  sherpa-onnx KWS（3.3M Zipformer）快速找候选，20x+ 实时
  二级  ASR 在候选点周围复核，确认发音 + 给出精确的字级时间戳

二级复核是把误报压下去的关键，也是算准静音窗口的唯一办法。
预扫描架构下时间预算充裕，这一级是"白给"的。
"""
import os, subprocess, tempfile, wave, glob
import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(ROOT, "models")
KWS_DIR = os.path.join(MODELS, "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01")
ASR_DIR = os.path.join(MODELS, "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20")

SR = 16000
CHUNK_S = 0.1          # 喂给 KWS 的帧长，决定时间分辨率
VERIFY_BACK = 2.5      # 复核窗口：命中点往前取多久
VERIFY_FWD = 0.5       # 复核窗口：命中点往后取多久
FALLBACK_LEAD = 1.6    # 没有复核时，静音窗口相对命中点往前推多久
FALLBACK_TAIL = 0.3


# ---------------------------------------------------------------- 音频

def load_audio(path, sr=SR):
    """任意容器 → 单声道 float32。走 ffmpeg，所以 mp4/webm/mkv/m4a/flv 都能直接吃。"""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        tmp = t.name
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", path,
             "-ac", "1", "-ar", str(sr), "-f", "wav", tmp],
            check=True, capture_output=True)
        with wave.open(tmp, "rb") as w:
            raw = w.readframes(w.getnframes())
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    finally:
        os.path.exists(tmp) and os.unlink(tmp)


# ---------------------------------------------------------------- 一级：KWS


def _strip_comments(path):
    """允许词表里写 # 注释和空行；sherpa-onnx 自己不支持，先过滤到临时文件。"""
    keep = []
    for line in open(path, encoding="utf-8"):
        t = line.strip()
        if t and not t.startswith("#"):
            keep.append(t)
    if not keep:
        raise SystemExit(f"词表是空的: {path}")
    fd, tmp = tempfile.mkstemp(suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(keep) + "\n")
    return tmp


def make_spotter(keywords_file=None, score=2.0, threshold=0.25,
                 num_threads=2, use_int8=True, model_dir=KWS_DIR):
    import sherpa_onnx
    enc = sorted(glob.glob(os.path.join(model_dir, "encoder-*chunk-16-left-64.onnx")))
    if not enc:
        raise SystemExit(f"找不到模型，先跑 ./setup.sh 下载  ({model_dir})")
    tail = os.path.basename(enc[0])[len("encoder-"):-len(".onnx")]

    def pick(kind):
        p8 = os.path.join(model_dir, f"{kind}-{tail}.int8.onnx")
        p = os.path.join(model_dir, f"{kind}-{tail}.onnx")
        return p8 if (use_int8 and os.path.exists(p8)) else p

    kwf = _strip_comments(keywords_file or os.path.join(ROOT, "keywords.txt"))
    return sherpa_onnx.KeywordSpotter(
        tokens=os.path.join(model_dir, "tokens.txt"),
        encoder=pick("encoder"), decoder=pick("decoder"), joiner=pick("joiner"),
        num_threads=num_threads, max_active_paths=4,
        keywords_file=kwf,
        keywords_score=score, keywords_threshold=threshold,
        num_trailing_blanks=1, provider="cpu")


def spot(spotter, samples, sr=SR):
    """返回 [(命中时刻秒, 关键词)]。命中时刻在唤醒词结束之后。"""
    s = spotter.create_stream()
    hits, step = [], int(sr * CHUNK_S)
    for i in range(0, len(samples), step):
        s.accept_waveform(sr, samples[i:i + step])
        while spotter.is_ready(s):
            spotter.decode_stream(s)
        r = spotter.get_result(s)
        if r:
            hits.append((round((i + step) / sr, 2), r))
            spotter.reset_stream(s)
    s.accept_waveform(sr, np.zeros(int(sr * 0.5), dtype=np.float32))
    s.input_finished()
    while spotter.is_ready(s):
        spotter.decode_stream(s)
    r = spotter.get_result(s)
    if r:
        hits.append((round(len(samples) / sr, 2), r))
    return hits


# ---------------------------------------------------------------- 二级：ASR 复核

class Verifier:
    def __init__(self, model_dir=ASR_DIR, num_threads=2):
        import sherpa_onnx
        if not os.path.exists(model_dir):
            raise SystemExit(f"找不到 ASR 模型，先跑 ./setup.sh  ({model_dir})")
        self.rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=os.path.join(model_dir, "tokens.txt"),
            encoder=os.path.join(model_dir, "encoder-epoch-99-avg-1.int8.onnx"),
            decoder=os.path.join(model_dir, "decoder-epoch-99-avg-1.onnx"),
            joiner=os.path.join(model_dir, "joiner-epoch-99-avg-1.int8.onnx"),
            num_threads=num_threads, provider="cpu",
            enable_endpoint_detection=False)

    def _run(self, a):
        s = self.rec.create_stream()
        s.accept_waveform(SR, a)
        s.input_finished()
        while self.rec.is_ready(s):
            self.rec.decode_stream(s)
        return self.rec.get_result_all(s)

    def verify(self, samples, t_hit, keyword):
        """在命中点附近复核。返回 (是否确认, 精确起止秒, 转写文本)。"""
        lo = max(0.0, t_hit - VERIFY_BACK)
        hi = min(len(samples) / SR, t_hit + VERIFY_FWD)
        seg = samples[int(lo * SR):int(hi * SR)]
        if len(seg) < SR // 4:
            return False, None, ""
        res = self._run(seg)
        text = "".join(res.tokens).replace("▁", " ").strip()
        flat = text.replace(" ", "")
        kw = keyword.replace(" ", "")
        if kw not in flat:
            return False, None, text

        # 定位关键词每个字的时间戳，得到精确起止
        toks = [(t.replace("▁", "").strip(), ts)
                for t, ts in zip(res.tokens, res.timestamps)]
        toks = [(t, ts) for t, ts in toks if t]
        chars = list(kw)
        for i in range(len(toks) - len(chars) + 1):
            if [t for t, _ in toks[i:i + len(chars)]] == chars:
                start = lo + toks[i][1]
                end = lo + toks[i + len(chars) - 1][1] + 0.25
                return True, (round(start, 2), round(end, 2)), text
        return True, None, text


# ---------------------------------------------------------------- 对外接口

def scan(path, spotter, verifier=None, pad=0.15):
    """扫描一个文件，返回检测结果列表。"""
    a = load_audio(path)
    out = []
    for t_hit, kw in spot(spotter, a):
        rec = {"t_hit": t_hit, "keyword": kw, "verified": None,
               "text": "", "span": None}
        if verifier:
            ok, span, text = verifier.verify(a, t_hit, kw)
            rec.update(verified=ok, text=text, span=span)
            if ok and span:
                rec["mute"] = (round(max(0, span[0] - pad), 2),
                               round(span[1] + pad, 2))
        if "mute" not in rec:
            rec["mute"] = (round(max(0, t_hit - FALLBACK_LEAD), 2),
                           round(t_hit + FALLBACK_TAIL, 2))
        out.append(rec)
    return out, len(a) / SR
