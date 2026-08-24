#!/usr/bin/env python3
"""P0 阈值扫描：召回率 vs 误报率。"""
import os, json, sys, time
import numpy as np
from concurrent.futures import ProcessPoolExecutor
from detect import load_16k_mono, make_spotter, detect, ZH

ROOT = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(ROOT, "dataset")
CACHE = os.path.join(DS, "cache.npz")
KWF = os.path.join(DS, "kw_xiaoai.txt")

KEYWORD_LINE = "x iǎo ài t óng x ué @小爱同学\n"


def build_cache():
    rows = json.load(open(os.path.join(DS, "manifest.json")))
    if os.path.exists(CACHE):
        z = np.load(CACHE, allow_pickle=True)
        if len(z["keys"]) == len(rows):
            return rows, {k: z["arrs"][i] for i, k in enumerate(z["keys"])}
    print(f"解码 {len(rows)} 个片段…")
    with ProcessPoolExecutor(max_workers=8) as ex:
        arrs = list(ex.map(load_16k_mono, [r["path"] for r in rows]))
    keys = [r["path"] for r in rows]
    np.savez(CACHE, keys=np.array(keys, dtype=object),
             arrs=np.array(arrs, dtype=object))
    return rows, dict(zip(keys, arrs))


def run_config(args):
    score, thr, trailing, rows, cache_path = args
    z = np.load(cache_path, allow_pickle=True)
    cache = {k: z["arrs"][i] for i, k in enumerate(z["keys"])}
    sp = make_spotter(ZH, keywords_file=KWF, score=score,
                      threshold=thr, num_trailing_blanks=trailing)
    res = {"pos_hit": 0, "pos_n": 0, "hard_fp": 0, "hard_n": 0,
           "neg_fp": 0, "neg_n": 0, "neg_sec": 0.0, "hard_sec": 0.0,
           "fp_examples": []}
    for r in rows:
        a = cache[r["path"]]
        hits = detect(sp, a)
        dur = len(a) / 16000
        if r["kind"] == "pos":
            res["pos_n"] += 1
            if hits:
                res["pos_hit"] += 1
        else:
            k = "hard" if r["kind"] == "hard" else "neg"
            res[f"{k}_n"] += 1
            res[f"{k}_sec"] += dur
            if hits:
                res[f"{k}_fp"] += len(hits)
                if len(res["fp_examples"]) < 12:
                    res["fp_examples"].append(
                        f'[{r["kind"]}/{r["variant"]}] «{r["text"]}»')
    res["score"], res["thr"], res["trailing"] = score, thr, trailing
    return res


def main():
    rows, _ = build_cache()
    os.makedirs(DS, exist_ok=True)
    open(KWF, "w").write(KEYWORD_LINE)

    grid = []
    for score in (1.0, 1.5, 2.0, 2.5):
        for thr in (0.15, 0.25, 0.35, 0.45):
            grid.append((score, thr, 1, rows, CACHE))

    t0 = time.time()
    with ProcessPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(run_config, grid))
    print(f"扫描 {len(grid)} 组配置，用时 {time.time()-t0:.0f}s\n")

    neg_h = results[0]["neg_sec"] / 3600
    hard_h = results[0]["hard_sec"] / 3600
    print(f"负样本时长：普通 {results[0]['neg_sec']/60:.1f} 分钟 / "
          f"易混淆 {results[0]['hard_sec']/60:.1f} 分钟\n")

    hdr = f"{'boost':>6} {'thr':>5} | {'召回':>7} | {'普通负样本误报':>16} | {'易混淆误报':>14}"
    print(hdr); print("-" * len(hdr))
    for r in sorted(results, key=lambda x: (x["score"], x["thr"])):
        rec = r["pos_hit"] / max(r["pos_n"], 1)
        neg_ph = r["neg_fp"] / neg_h if neg_h else 0
        hard_ph = r["hard_fp"] / hard_h if hard_h else 0
        print(f"{r['score']:>6.1f} {r['thr']:>5.2f} | "
              f"{rec*100:>6.1f}% | "
              f"{r['neg_fp']:>3} 次 = {neg_ph:>6.1f}/小时 | "
              f"{r['hard_fp']:>3} 次 = {hard_ph:>6.1f}/小时")

    json.dump(results, open(os.path.join(DS, "sweep.json"), "w"),
              ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
