#!/usr/bin/env python3
"""
扫描真实视频，看看里面有没有唤醒词、在第几秒、该静音哪一段。

  python3 scan.py 视频.mp4
  python3 scan.py 视频目录/ --no-verify        # 只跑一级，最快
  python3 scan.py *.mp4 --threshold 0.45       # 收紧阈值
  python3 scan.py 视频.mp4 --json out.json     # 机器可读输出
"""
import os, sys, time, json, argparse, glob
import wakeword as W

MEDIA = (".mp4", ".mkv", ".webm", ".mov", ".flv", ".ts",
         ".m4a", ".mp3", ".wav", ".aac", ".opus", ".ogg", ".flac")


def expand(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, fs in os.walk(p):
                out += [os.path.join(root, f) for f in sorted(fs)
                        if f.lower().endswith(MEDIA)]
        else:
            out += [x for x in glob.glob(p) if x.lower().endswith(MEDIA)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--keywords", default=None, help="词表文件，默认用 keywords.txt")
    ap.add_argument("--score", type=float, default=2.0, help="关键词加权，越大越容易触发")
    ap.add_argument("--threshold", type=float, default=0.25, help="触发阈值，越大越难触发")
    ap.add_argument("--no-verify", action="store_true", help="跳过 ASR 复核")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    files = expand(a.paths)
    if not files:
        sys.exit("没找到可处理的媒体文件")

    sp = W.make_spotter(keywords_file=a.keywords, score=a.score,
                        threshold=a.threshold)
    vf = None if a.no_verify else W.Verifier()

    all_rows, tot_dur, tot_wall, n_hit, n_ver = [], 0.0, 0.0, 0, 0
    for f in files:
        t0 = time.time()
        try:
            rows, dur = W.scan(f, sp, vf)
        except Exception as e:
            print(f"✗ {os.path.basename(f)}: {e}")
            continue
        wall = time.time() - t0
        tot_dur += dur
        tot_wall += wall
        n_hit += len(rows)
        n_ver += sum(1 for r in rows if r["verified"])

        tag = f"{len(rows)} 处命中" if rows else "无命中"
        print(f"\n▸ {os.path.basename(f)}  [{dur:.1f}s 音频, "
              f"扫描 {wall:.1f}s = {dur/max(wall,1e-6):.0f}x 实时]  {tag}")
        for r in rows:
            m0, m1 = r["mute"]
            mark = {True: "✓已复核", False: "✗复核未通过（疑似误报）",
                    None: "—未复核"}[r["verified"]]
            span = f"精确区间 {r['span'][0]}–{r['span'][1]}s" if r["span"] else "区间为估算"
            print(f"    {r['t_hit']:>7.2f}s  「{r['keyword']}」  {mark}")
            print(f"             静音 {m0:.2f}–{m1:.2f}s ({m1-m0:.2f}s)  {span}")
            if r["text"]:
                print(f"             上下文: …{r['text'][:50]}…")
        all_rows.append({"file": f, "duration": dur, "scan_sec": wall,
                         "hits": rows})

    print(f"\n{'='*64}")
    print(f"文件 {len(files)} 个 · 音频总长 {tot_dur/60:.1f} 分钟 · "
          f"扫描耗时 {tot_wall:.0f}s = {tot_dur/max(tot_wall,1e-6):.0f}x 实时")
    print(f"命中 {n_hit} 处" + (f"，其中 ASR 复核通过 {n_ver} 处" if vf else ""))
    if vf and n_hit:
        print(f"一级误报被二级拦下 {n_hit-n_ver} 处 "
              f"({(n_hit-n_ver)/n_hit*100:.0f}%)")
    if tot_dur > 0:
        print(f"命中密度 {n_hit/(tot_dur/3600):.2f} 次/小时"
              + (f"（复核后 {n_ver/(tot_dur/3600):.2f} 次/小时）" if vf else ""))

    if a.json:
        json.dump(all_rows, open(a.json, "w"), ensure_ascii=False, indent=1)
        print(f"→ {a.json}")


if __name__ == "__main__":
    main()
