#!/usr/bin/env python3
"""合成 + 声学增强，产出测试集。"""
import os, json, subprocess, itertools
from concurrent.futures import ProcessPoolExecutor
import corpus
from tts import synth

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "dataset")
BASE = os.path.join(OUT, "base")
AUG = os.path.join(OUT, "aug")

SPK = {"pos": [7, 41, 88], "hard": [12, 60, 133], "neg": [21, 99]}

# 六种「真实播放链路」的模拟
VARIANTS = {
    # 干净原始（对照组）
    "clean": None,
    # 流媒体音频压缩：48k AAC 往返一圈
    "aac48": "anull",
    # 变速：说话人语速差异
    "slow": "atempo=0.90",
    "fast": "atempo=1.12",
    # 背景噪声 ~10dB SNR
    "noisy": "__NOISE__0.030",
    # 电视/音箱外放：带限 + 轻混响 + 低噪
    "tv": "highpass=f=180,lowpass=f=7000,aecho=0.8:0.6:35:0.22,__NOISE__0.015",
}


def ff(inp, out, filt):
    """跑一条 ffmpeg，统一走 48k AAC 编码再解回来，模拟流媒体链路。"""
    if filt is None:
        # clean：只转成 wav，不过编码器
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", inp,
               "-ac", "1", "-ar", "16000", out]
        subprocess.run(cmd, check=True)
        return

    noise_amp = None
    if "__NOISE__" in filt:
        parts = filt.split("__NOISE__")
        head = parts[0].rstrip(",")
        noise_amp = float(parts[1].split(",")[0])
        filt = head

    if noise_amp:
        fc = (f"[0:a]{filt + ',' if filt else ''}aresample=16000[a];"
              f"[1:a]volume={noise_amp}[n];"
              f"[a][n]amix=inputs=2:duration=first:dropout_transition=0[m]")
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", inp,
               "-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=16000",
               "-filter_complex", fc, "-map", "[m]",
               "-c:a", "aac", "-b:a", "48k", "-f", "adts", "-"]
        p1 = subprocess.run(cmd, check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "aac",
                        "-i", "pipe:0", "-ac", "1", "-ar", "16000", out],
                       input=p1.stdout, check=True)
    else:
        af = f"{filt},aresample=16000" if filt != "anull" else "aresample=16000"
        p1 = subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", inp, "-af", af,
             "-c:a", "aac", "-b:a", "48k", "-f", "adts", "-"],
            check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "aac",
                        "-i", "pipe:0", "-ac", "1", "-ar", "16000", out],
                       input=p1.stdout, check=True)


def synth_one(job):
    kind, idx, spk, text = job
    p = os.path.join(BASE, f"{kind}_{idx:03d}_s{spk}.wav")
    if not os.path.exists(p):
        synth(text, p, sid=spk)
    return (kind, idx, spk, text, p)


def aug_one(job):
    kind, idx, spk, text, src = job
    rows = []
    for vname, filt in VARIANTS.items():
        dst = os.path.join(AUG, f"{kind}_{idx:03d}_s{spk}_{vname}.wav")
        if not os.path.exists(dst):
            try:
                ff(src, dst, filt)
            except subprocess.CalledProcessError:
                continue
        rows.append({"kind": kind, "idx": idx, "spk": spk, "variant": vname,
                     "text": text, "path": dst})
    return rows


def main():
    os.makedirs(BASE, exist_ok=True)
    os.makedirs(AUG, exist_ok=True)

    jobs = []
    for kind, texts in (("pos", corpus.POSITIVE), ("hard", corpus.HARD_NEG),
                        ("neg", corpus.NEG)):
        for i, t in enumerate(texts):
            for spk in SPK[kind]:
                jobs.append((kind, i, spk, t))

    print(f"合成 {len(jobs)} 条…")
    synthed = [synth_one(j) for j in jobs]   # TTS 本身多线程，串行调用

    print(f"增强 {len(synthed)} × {len(VARIANTS)} 条…")
    rows = []
    with ProcessPoolExecutor(max_workers=8) as ex:
        for r in ex.map(aug_one, synthed):
            rows.extend(r)

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print(f"完成：{len(rows)} 个音频片段 → {OUT}/manifest.json")


if __name__ == "__main__":
    main()
