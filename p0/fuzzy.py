#!/usr/bin/env python3
"""
近音变体检测 —— 二级 ASR 之上的拼音模糊匹配。

一级 KWS 只认它训练过的那条 token 序列，「小菜同学」「小坏同学」这种
听起来足以唤醒真实设备的变体它一个都不认。但预扫描的时间预算足够跑
完整 ASR，于是可以：转写 → 转拼音 → 按音节做带容错的比对。

判据：固定音节必须完全一致（xiao / tong / xue），可变音节只要韵母
落在目标韵母的近邻集合里就算命中。这样「小菜/小蔡/小坏/小被同学」
全中，而「小明同学」「小李同学」不会误伤。
"""
from pypinyin import lazy_pinyin, Style

# 韵母近邻表：发音接近、真实唤醒模型大概率也会混淆的
FINAL_NEIGHBORS = {
    "ai":  {"ai", "uai", "ei", "uei", "ui", "an"},
    "iao": {"iao", "ao", "iu", "iou"},
    "ong": {"ong", "eng", "uong"},
    "ue":  {"ue", "ve", "e", "uo"},
    "i":   {"i", "ii", "iii"},
    "u":   {"u", "ou"},
    "an":  {"an", "ang", "ai"},
    "en":  {"en", "eng"},
}

SYL_EXACT, SYL_FINAL, SYL_NEAR, SYL_MISS = 1.0, 0.85, 0.6, 0.0
DEFAULT_THRESHOLD = 0.85


def syl_score(target, cand):
    if target == cand:
        return SYL_EXACT
    tf = lazy_pinyin(target, style=Style.FINALS, strict=False)
    cf = lazy_pinyin(cand, style=Style.FINALS, strict=False)
    # 上面对单音节字符串不适用，直接用启发式切分
    tfin = _final_of(target)
    cfin = _final_of(cand)
    if tfin and tfin == cfin:
        return SYL_FINAL
    if tfin and cfin in FINAL_NEIGHBORS.get(tfin, set()):
        return SYL_NEAR
    return SYL_MISS


_INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l",
             "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"]


def _final_of(syl):
    for ini in _INITIALS:
        if syl.startswith(ini):
            return syl[len(ini):]
    return syl


def match_score(target_syls, cand_syls):
    if len(target_syls) != len(cand_syls):
        return 0.0
    return sum(syl_score(t, c) for t, c in zip(target_syls, cand_syls)) / len(target_syls)


def find_variants(tokens, timestamps, keywords, threshold=DEFAULT_THRESHOLD,
                  tail_pad=0.25):
    """
    tokens/timestamps: ASR 输出的字级序列
    keywords: ["小爱同学", ...]
    返回 [{"span": (start, end), "text": 实际说的字, "keyword": 目标词, "score": 分数}]
    """
    chars = [(t.replace("▁", "").strip(), ts)
             for t, ts in zip(tokens, timestamps)]
    chars = [(c, ts) for c, ts in chars if c and "一" <= c <= "鿿"]
    if not chars:
        return []

    out = []
    for kw in keywords:
        tgt = lazy_pinyin(kw)
        n = len(tgt)
        i = 0
        while i <= len(chars) - n:
            window = "".join(c for c, _ in chars[i:i + n])
            cand = lazy_pinyin(window)
            sc = match_score(tgt, cand)
            if sc >= threshold:
                out.append({
                    "span": (round(chars[i][1], 2),
                             round(chars[i + n - 1][1] + tail_pad, 2)),
                    "text": window, "keyword": kw, "score": round(sc, 3),
                })
                i += n
            else:
                i += 1
    out.sort(key=lambda r: r["span"][0])
    # 去重叠
    merged = []
    for r in out:
        if merged and r["span"][0] < merged[-1]["span"][1]:
            if r["score"] > merged[-1]["score"]:
                merged[-1] = r
            continue
        merged.append(r)
    return merged


if __name__ == "__main__":
    for w in ["小爱同学", "小菜同学", "小蔡同学", "小坏同学", "小被同学",
              "小明同学", "小李同学", "小艾同学", "笑爱同学", "小爱通学"]:
        s = match_score(lazy_pinyin("小爱同学"), lazy_pinyin(w))
        print(f"  {w}  score={s:.3f}  {'→ 屏蔽' if s >= DEFAULT_THRESHOLD else '  放行'}")
