#!/usr/bin/env python3
"""
召回率复测 v2 —— 换用发音正确的 TTS，并且只统计 ASR 确认「确实说出了小爱同学」的样本。
先前那版 aishell3 TTS 把「小爱同学」念成了「小艾/小安/小赖同学」，
用它测出来的召回率是测试集的问题，不是模型的问题。
"""
import os, subprocess, json
import numpy as np
from concurrent.futures import ProcessPoolExecutor
import corpus
from detect import load_16k_mono, make_spotter, detect, ZH
from diagnose import get_asr, transcribe
from gen import ff, VARIANTS
import tts2

ROOT = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(ROOT, "dataset2")
BASE, AUG = os.path.join(D, "base"), os.path.join(D, "aug")
KWF = os.path.join(ROOT, "dataset", "kw_xiaoai.txt")
SPK = [1, 2, 3, 5]


def step_synth():
    os.makedirs(BASE, exist_ok=True)
    out = []
    for i, t in enumerate(corpus.POSITIVE):
        for s in SPK:
            p = os.path.join(BASE, f"pos_{i:03d}_s{s}.wav")
            if not os.path.exists(p):
                tts2.synth(t, p, sid=s)
            out.append({"idx": i, "spk": s, "text": t, "path": p})
    return out


def step_verify(items):
    """用 ASR 确认 TTS 真的把唤醒词念对了。念错的样本直接剔除。"""
    rec = get_asr()
    kept, dropped = [], []
    for it in items:
        txt = transcribe(rec, load_16k_mono(it["path"])).replace(" ", "")
        it["asr"] = txt
        (kept if "小爱同学" in txt else dropped).append(it)
    return kept, dropped


def _aug(it):
    rows = []
    for v, filt in VARIANTS.items():
        dst = os.path.join(AUG, f"pos_{it['idx']:03d}_s{it['spk']}_{v}.wav")
        if not os.path.exists(dst):
            try:
                ff(it["path"], dst, filt)
            except subprocess.CalledProcessError:
                continue
        rows.append({**it, "variant": v, "path": dst})
    return rows


def main():
    print("1) 合成…", flush=True)
    items = step_synth()
    print(f"   {len(items)} 条", flush=True)

    print("2) ASR 校验发音…", flush=True)
    kept, dropped = step_verify(items)
    print(f"   通过 {len(kept)} / 剔除 {len(dropped)}"
          f"  （剔除率 {len(dropped)/len(items)*100:.0f}%）", flush=True)
    for d in dropped[:6]:
        print(f"     ✗ «{d['text']}» → 听成「{d['asr'][:22]}」", flush=True)

    print("3) 声学增强…", flush=True)
    os.makedirs(AUG, exist_ok=True)
    rows = []
    with ProcessPoolExecutor(max_workers=2) as ex:
        for r in ex.map(_aug, kept):
            rows.extend(r)
    print(f"   {len(rows)} 个片段", flush=True)

    print("4) KWS 检测…", flush=True)
    sp = make_spotter(ZH, keywords_file=KWF, score=2.0, threshold=0.25, num_threads=2)
    from collections import defaultdict
    by_var = defaultdict(lambda: [0, 0])
    hit_all = [0, 0]
    lag = []
    for r in rows:
        a = load_16k_mono(r["path"])
        h = detect(sp, a)
        by_var[r["variant"]][1] += 1
        hit_all[1] += 1
        if h:
            by_var[r["variant"]][0] += 1
            hit_all[0] += 1
            if r["text"].startswith("小爱同学"):
                lag.append(h[0][0])

    print(f"\n=== 召回率（ASR 已确认发音正确的样本，boost=2.0 thr=0.25）===")
    for v, (h, n) in sorted(by_var.items(), key=lambda kv: -kv[1][0] / max(kv[1][1], 1)):
        print(f"  {v:8s} {h:>3}/{n:<3} {h/max(n,1)*100:>5.1f}%  {'█'*int(20*h/max(n,1))}")
    print(f"  {'合计':8s} {hit_all[0]:>3}/{hit_all[1]:<3} "
          f"{hit_all[0]/max(hit_all[1],1)*100:>5.1f}%")
    if lag:
        print(f"\n句首唤醒词的报警时刻：中位 {np.median(lag):.2f}s  "
              f"P90 {np.percentile(lag,90):.2f}s  最大 {max(lag):.2f}s")
    json.dump({"by_variant": {k: v for k, v in by_var.items()},
               "total": hit_all, "dropped": len(dropped), "kept": len(kept)},
              open(os.path.join(D, "recall2.json"), "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
