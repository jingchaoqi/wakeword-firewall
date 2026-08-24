#!/usr/bin/env python3
"""按增强类型 / 说话人 / 句中位置拆解召回率，定位低召回的真正原因。"""
import os, json
import numpy as np
from collections import defaultdict
from detect import make_spotter, detect, ZH

ROOT = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(ROOT, "dataset")
KWF = os.path.join(DS, "kw_xiaoai.txt")


def main():
    rows = [r for r in json.load(open(f"{DS}/manifest.json")) if r["kind"] == "pos"]
    z = np.load(f"{DS}/cache.npz", allow_pickle=True)
    cache = {k: z["arrs"][i] for i, k in enumerate(z["keys"])}
    sp = make_spotter(ZH, keywords_file=KWF, score=2.0, threshold=0.25, num_threads=2)

    by_var = defaultdict(lambda: [0, 0])
    by_spk = defaultdict(lambda: [0, 0])
    by_pos = defaultdict(lambda: [0, 0])   # 唤醒词在句首 vs 句中
    by_text = defaultdict(lambda: [0, 0])

    for r in rows:
        hit = bool(detect(sp, cache[r["path"]]))
        pos = "句首" if r["text"].startswith("小爱同学") else "句中"
        for d, k in ((by_var, r["variant"]), (by_spk, r["spk"]),
                     (by_pos, pos), (by_text, r["text"])):
            d[k][1] += 1
            d[k][0] += hit

    def show(title, d, limit=None):
        print(f"\n=== {title} ===")
        items = sorted(d.items(), key=lambda kv: kv[1][0] / max(kv[1][1], 1))
        if limit:
            items = items[:limit]
        for k, (h, n) in items:
            bar = "█" * int(20 * h / max(n, 1))
            print(f"  {str(k)[:34]:36s} {h:>3}/{n:<3} {h/max(n,1)*100:>5.1f}% {bar}")

    show("按增强类型", by_var)
    show("按句中位置", by_pos)
    show("按说话人", by_spk)
    show("召回最差的 10 个句子", by_text, limit=10)


if __name__ == "__main__":
    main()
