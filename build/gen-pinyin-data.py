#!/usr/bin/env python3
"""
生成 extension/src/pinyin-data.js
================================
浏览器里要把「小爱同学」转成模型认识的 token 序列，需要两样东西：
  1. 汉字 → 带声调拼音
  2. 模型的 token 表（声母 + 带声调韵母，共 227 个）

第 2 样从模型包里的 tokens.txt 读。第 1 样用 pypinyin 生成。
只收「拼音能拆成合法 token」的字——拆不出来的收进去也没用。

    pip install pypinyin
    python3 build/gen-pinyin-data.py [tokens.txt 路径]

默认从 extension/models/tokens.txt 读（fetch-models.sh 会放好）。
"""
import sys, os, json, collections
from pypinyin import lazy_pinyin, Style

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'extension/models/tokens.txt')
OUT = os.path.join(ROOT, 'extension/src/pinyin-data.js')

if not os.path.exists(TOK):
    sys.exit(f"找不到 tokens.txt：{TOK}\n先跑 ./extension/tools/fetch-models.sh，或把路径当参数传进来")

tokens = [l.split()[0] for l in open(TOK, encoding='utf-8') if l.strip()]
tokens = [t for t in tokens if not t.startswith('<') and not t.startswith('#')]
tokset = set(tokens)

# 长的排前面只是习惯；真正兜住的是「余下部分必须也是 token」这条
INITIALS = sorted(['zh','ch','sh','b','p','m','f','d','t','n','l','g','k','h',
                   'j','q','x','r','z','c','s','y','w'], key=len, reverse=True)

def split(py):
    if py in tokset: return [py]
    for ini in INITIALS:
        if py.startswith(ini) and py[len(ini):] in tokset:
            return [ini, py[len(ini):]]
    return None

inv = collections.defaultdict(list)
ok = bad = 0
for cp in range(0x4E00, 0x9FA6):            # CJK 基本区
    ch = chr(cp)
    py = lazy_pinyin(ch, style=Style.TONE)
    if not py or py[0] == ch: continue       # pypinyin 不认识这个字
    if split(py[0]): inv[py[0]].append(ch); ok += 1
    else: bad += 1

data = '\n'.join(f"{p} {''.join(cs)}" for p, cs in sorted(inv.items()))
open(OUT, 'w', encoding='utf-8').write(f'''/**
 * 中文 → 模型 token 的转换数据
 * ==============================
 * 由 build/gen-pinyin-data.py 生成，别手改。
 *
 *   PINYIN —— 「带声调拼音 空格 该读音的所有汉字」每行一条。反着存省一半：
 *             不同拼音 {len(inv)} 个，汉字 {ok} 个。
 *   TOKENS —— 模型认识的 {len(tokens)} 个 token。拆出来的东西必须在这里面。
 *
 * 有 {bad} 个字的拼音拆不出合法 token，没收进来。
 * 多音字取 pypinyin 的默认读音；遇到不对的，用户可以直接改生成出来的 token 行。
 */
'use strict';
(function (root) {{
  const PINYIN = {json.dumps(data, ensure_ascii=False)};
  const TOKENS = {json.dumps(' '.join(tokens), ensure_ascii=False)};
  root.WWPinyinData = {{ PINYIN, TOKENS }};
}})(typeof self !== 'undefined' ? self : this);
''')
print(f"汉字 {ok} 个 / 拼音 {len(inv)} 种 / token {len(tokens)} 个 → {OUT} "
      f"({os.path.getsize(OUT)/1024:.0f} KB)")
