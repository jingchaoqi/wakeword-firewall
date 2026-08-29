#!/usr/bin/env python3
"""
把视频处理成"屏蔽后"的版本 —— 完整跑一遍扩展里预扫描要做的事。

  python3 mute.py 输入.mp4 -o 输出.mp4

流程：
  1) 一级 KWS 找候选（快，20x 实时）
  2) 全片 ASR 转写 + 拼音模糊匹配，捞出「小菜同学」这类近音变体
  3) 两路结果合并成时间戳表
  4) 按时间戳给音频加增益包络（10ms 升降沿，避免爆音），视频流原样复制
"""
import os, sys, subprocess, tempfile, wave, argparse
import numpy as np
import wakeword as W
import fuzzy

FADE_MS = 10          # 静音升降沿，防爆音
PAD_HEAD = 0.15       # 唤醒词起点前多留一点
PAD_TAIL = 0.20       # 终点后多留一点


# ------------------------------------------------------------------ 检测

def detect_all(path, spotter, verifier, keywords, thr):
    a16 = W.load_audio(path)
    dur = len(a16) / W.SR
    spans = []

    # 一级：KWS
    for t_hit, kw in W.spot(spotter, a16):
        ok, span, text = verifier.verify(a16, t_hit, kw)
        if span:
            spans.append({"span": span, "src": "KWS+复核", "text": kw, "score": 1.0})
        else:
            spans.append({"span": (max(0, t_hit - W.FALLBACK_LEAD), t_hit + W.FALLBACK_TAIL),
                          "src": "KWS(区间估算)", "text": kw, "score": 1.0})

    # 二级：全片 ASR + 拼音模糊
    res = verifier._run(a16)
    for m in fuzzy.find_variants(res.tokens, res.timestamps, keywords, thr):
        spans.append({"span": m["span"], "src": "近音变体",
                      "text": m["text"], "score": m["score"]})

    # 合并重叠
    spans.sort(key=lambda r: r["span"][0])
    merged = []
    for r in spans:
        s, e = max(0.0, r["span"][0] - PAD_HEAD), min(dur, r["span"][1] + PAD_TAIL)
        if merged and s <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], e)
            if r["text"] not in merged[-1]["labels"]:
                merged[-1]["labels"].append(r["text"])
            if r["src"] not in merged[-1]["srcs"]:
                merged[-1]["srcs"].append(r["src"])
        else:
            merged.append({"start": s, "end": e, "labels": [r["text"]],
                           "srcs": [r["src"]]})
    return merged, dur, "".join(res.tokens).replace("▁", " ")


# ------------------------------------------------------------------ 静音

def apply_mute(inp, out, spans):
    """解码原始音频 → 加增益包络 → 与原视频流重新封装。"""
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "a.wav")
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", inp,
                        "-vn", "-c:a", "pcm_s16le", wav], check=True)
        with wave.open(wav, "rb") as w:
            ch, sr, n = w.getnchannels(), w.getframerate(), w.getnframes()
            data = np.frombuffer(w.readframes(n), dtype=np.int16)
        x = data.reshape(-1, ch).astype(np.float32)

        gain = np.ones(len(x), dtype=np.float32)
        fade = max(1, int(sr * FADE_MS / 1000))
        ramp = 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade)))   # 1→0 升余弦
        for sp in spans:
            i0, i1 = int(sp["start"] * sr), int(sp["end"] * sr)
            i0, i1 = max(0, i0), min(len(x), i1)
            if i1 <= i0:
                continue
            gain[i0:i1] = 0.0
            a = max(0, i0 - fade)
            gain[a:i0] = np.minimum(gain[a:i0], ramp[-(i0 - a):] if i0 > a else 1.0)
            b = min(len(x), i1 + fade)
            gain[i1:b] = np.minimum(gain[i1:b], ramp[::-1][:b - i1])

        y = np.clip(x * gain[:, None], -32768, 32767).astype(np.int16)
        wav2 = os.path.join(td, "b.wav")
        with wave.open(wav2, "wb") as w:
            w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes(y.tobytes())

        # 纯音频输入（mp3/m4a/wav）没有 0:v:0，硬映射会让 ffmpeg 直接报
        # "Error parsing options"，然后这里抛 CalledProcessError 的裸栈。
        # 先问一句有没有视频流，没有就只封音频。
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", inp],
            capture_output=True, text=True)
        has_video = "video" in probe.stdout

        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", inp, "-i", wav2]
        if has_video:
            cmd += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"]
        else:
            cmd += ["-map", "1:a:0"]
        cmd += ["-c:a", "aac", "-b:a", "160k", "-shortest", out]
        subprocess.run(cmd, check=True)


# ------------------------------------------------------------------ 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output", default=None)
    ap.add_argument("--keywords", default=None)
    ap.add_argument("--fuzzy-threshold", type=float, default=fuzzy.DEFAULT_THRESHOLD)
    ap.add_argument("--score", type=float, default=2.0)
    ap.add_argument("--threshold", type=float, default=0.25)
    a = ap.parse_args()

    out = a.output or (os.path.splitext(a.input)[0] + "_muted" +
                       os.path.splitext(a.input)[1])
    kwf = a.keywords or os.path.join(W.ROOT, "keywords.txt")
    names = [l.split("@")[-1].strip() for l in open(kwf, encoding="utf-8")
             if l.strip() and not l.startswith("#") and "@" in l]

    sp = W.make_spotter(keywords_file=kwf, score=a.score, threshold=a.threshold)
    vf = W.Verifier()

    import time
    t0 = time.time()
    spans, dur, text = detect_all(a.input, sp, vf, names, a.fuzzy_threshold)
    scan_t = time.time() - t0

    print(f"\n▸ {os.path.basename(a.input)}   {dur:.1f}s 音频")
    print(f"  全片转写: {text[:110]}…")
    print(f"  扫描耗时 {scan_t:.1f}s = {dur/max(scan_t,1e-6):.1f}x 实时（含全片 ASR）\n")
    if not spans:
        print("  未检测到唤醒词")
    total = 0.0
    for s in spans:
        total += s["end"] - s["start"]
        print(f"  静音 {s['start']:>6.2f} – {s['end']:>6.2f}s "
              f"({s['end']-s['start']:.2f}s)  「{'/'.join(s['labels'])}」  "
              f"[{'+'.join(s['srcs'])}]")
    print(f"\n  共 {len(spans)} 段，静音总时长 {total:.2f}s，"
          f"占全片 {total/max(dur,1e-6)*100:.1f}%")

    apply_mute(a.input, out, spans)
    print(f"  → {out}")


if __name__ == "__main__":
    main()
