/**
 * 中文 → 模型 token 序列
 * =======================
 * 词表里存的不是「小爱同学」，是模型认识的 token 序列：
 *
 *     x iǎo ài t óng x ué @小爱同学
 *
 * 声母和带声调的韵母拆开。官方的做法是装 Python 跑 `sherpa-onnx-cli text2token`，
 * 对普通用户等于加不了词——这个文件就是把那一步搬进浏览器。
 *
 * 拆分规则（由模型的 token 表反推，共 227 个）：
 *   1. 整个音节本身就是 token → 直接用（零声母字，「爱 ài」「儿 èr」）
 *   2. 否则取最长的声母匹配，剩下的必须也是 token（「小 xiǎo」→ x + iǎo）
 *   3. 两条都不成立 → 这个字模型没见过，报出来别硬塞
 *
 * 同时可在 Node 与浏览器运行，方便离线单测。
 */
(function (root) {
  'use strict';

  const D = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./pinyin-data.js').WWPinyinData || root.WWPinyinData
    : root.WWPinyinData;

  // 长的排前面只是习惯，真正兜住的是下面 tokenSet.has(fin) 那道守卫：
  // 「张 zhāng」即便先试了 z，余下的「hāng」不是合法韵母，会自然落到 zh。
  // 所有韵母都以元音（或 er/en/ang 这类）开头，h 永远不可能是韵母开头，
  // 所以 zh/ch/sh 不会被 z/c/s 抢走。变异检验确认过：打乱顺序结果不变。
  const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
                    'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

  let charToPinyin = null, tokenSet = null;

  function init() {
    if (charToPinyin) return;
    charToPinyin = new Map();
    for (const line of D.PINYIN.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const py = line.slice(0, sp);
      // 反着存的：一个读音对应一串同音字，展开成 字→拼音
      for (const ch of line.slice(sp + 1)) {
        if (!charToPinyin.has(ch)) charToPinyin.set(ch, py);
      }
    }
    tokenSet = new Set(D.TOKENS.split(' '));
  }

  /** 一个带声调音节 → token 数组；拆不了返回 null */
  function splitSyllable(py) {
    init();
    if (tokenSet.has(py)) return [py];
    for (const ini of INITIALS) {
      if (py.startsWith(ini)) {
        const fin = py.slice(ini.length);
        if (tokenSet.has(fin)) return [ini, fin];
      }
    }
    return null;
  }

  /**
   * 中文词 → { ok, tokens, line, bad }
   *   line —— 可直接写进 keywords.txt 的一整行
   *   bad  —— 转不了的字，连同原因
   */
  function convert(text) {
    init();
    const word = String(text || '').replace(/\s+/g, '');
    if (!word) return { ok: false, bad: [], error: 'EMPTY' };

    const out = [];
    const bad = [];
    for (const ch of word) {
      const py = charToPinyin.get(ch);
      if (!py) { bad.push({ ch, why: '不是常用汉字，或模型的拼音表里没有' }); continue; }
      const toks = splitSyllable(py);
      if (!toks) { bad.push({ ch, why: `读音「${py}」拆不出模型认识的声母/韵母` }); continue; }
      out.push(...toks);
    }
    if (bad.length) return { ok: false, tokens: out, bad, error: 'UNSUPPORTED_CHARS' };
    return { ok: true, tokens: out, bad: [], line: out.join(' ') + ' @' + word };
  }

  /** 词表里已经有这个词了吗（按显示名比对，不看 token） */
  function hasWord(keywordsText, word) {
    return String(keywordsText || '').split('\n')
      .some(l => l.trim().split('@')[1] === word);
  }

  const api = { convert, splitSyllable, hasWord };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWText2Token = api;
})(typeof self !== 'undefined' ? self : this);
