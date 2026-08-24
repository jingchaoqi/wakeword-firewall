#!/usr/bin/env python3
"""P0 阈值扫描 v2 —— 2 核机器上不超订，每组配置跑完立即落盘。"""
import os, json, time
import numpy as np
from concurrent.futures import ProcessPoolExecutor
from detect import make_spotter, detect, ZH

ROOT = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(ROOT, "dataset")
CACHE = os.path.join(DS, "cache.npz")
KWF = os.path.join(DS, "kw_xiaoai.txt")
OUTJ = os.path.join(DS, "sweep2.json")

GRID = [(1.0, 0.25), (1.0, 0.45), (1.5, 0.25), (2.0, 0.25), (2.0, 0.45)]


def run_config(args):
    score, thr = args
    rows = json.load(open(os.path.join(DS, "manifest.json")))
    z = np.load(CACHE, allow_pickle=True)
    cache = {k: z["arrs"][i] for i, k in enumerate(z["keys"])}
    sp = make_spotter(ZH, keywords_file=KWF, score=score, threshold=thr,
                      num_trailing_blanks=1, num_threads=1)
    r = {"score": score, "thr": thr, "pos_hit": 0, "pos_n": 0,
         "hard_fp": 0, "hard_n": 0, "neg_fp": 0, "neg_n": 0,
         "neg_sec": 0.0, "hard_sec": 0.0, "pos_sec": 0.0,
         "miss": [], "fp": []}
    for row in rows:
        a = cache[row["path"]]
        hits = detect(sp, a)
        dur = len(a) / 16000
        k = row["kind"]
        r[f"{k}_n"] += 1
        r[f"{k}_sec"] += dur
        if k == "pos":
            if hits:
                r["pos_hit"] += 1
            elif len(r["miss"]) < 20:
                r["miss"].append(f'{row["variant"]}/s{row["spk"]} «{row["text"]}»')
        elif hits:
            r[f"{k}_fp"] += len(hits)
            if len(r["fp"]) < 20:
                r["fp"].append(f'[{k}/{row["variant"]}] «{row["text"]}» @{hits}')
    return r


def main():
    open(KWF, "w").write("x iǎo ài t óng x ué @小爱同学\n")
    t0 = time.time()
    results = []
    with ProcessPoolExecutor(max_workers=2) as ex:
        for r in ex.map(run_config, GRID):
            results.append(r)
            json.dump(results, open(OUTJ, "w"), ensure_ascii=False, indent=1)
            print(f"[{len(results)}/{len(GRID)}] boost={r['score']} thr={r['thr']}  "
                  f"召回 {r['pos_hit']}/{r['pos_n']}  "
                  f"误报 普通={r['neg_fp']} 易混淆={r['hard_fp']}  "
                  f"({time.time()-t0:.0f}s)", flush=True)
    print(f"\n完成，用时 {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
