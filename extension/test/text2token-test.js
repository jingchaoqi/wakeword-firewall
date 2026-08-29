/**
 * text2token 的离线单测
 * =====================
 * 标准答案不是我编的——用的是 extension/keywords.txt 里的现成条目。
 * 那些 token 序列当初是官方的 sherpa-onnx-cli text2token 生成的，
 * 而且 P0 阶段在真实音频上验证过能命中。拿它们当基准，
 * 就是在验「浏览器里这套转换和官方工具是否等价」。
 *
 * 例外：「你好悠悠」这条是后来用本文件验的转换器自己生成的，对它而言这一条
 * 是同义反复，证明不了等价性。它的读音单独用 pypinyin 独立核过
 * （nǐ hǎo yōu yōu，四个字都不是多音字）。以后再往词表加词时注意这一点——
 * 要么用官方 CLI 生成，要么就别指望这个测试能替你把关。
 *
 *   node extension/test/text2token-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

// pinyin-data.js 是 UMD 风格，Node 下挂在 module.exports 上
const dataPath = path.resolve(__dirname, '../src/pinyin-data.js');
global.self = global;
require(dataPath);
const T = require('../src/text2token.js');

let pass = 0, fail = 0;
const eq = (a, b, what) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log(`  ✅ ${what}`); }
  else { fail++; console.log(`  ❌ ${what}\n       实际 ${JSON.stringify(a)}\n       期望 ${JSON.stringify(b)}`); }
};

console.log('\n▸ 对着 keywords.txt 的官方结果逐条比对');
const kw = fs.readFileSync(path.resolve(__dirname, '../keywords.txt'), 'utf8');
let checked = 0;
for (const line of kw.split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const at = t.indexOf('@');
  if (at < 0) continue;
  const expected = t.slice(0, at).trim();
  const name = t.slice(at + 1).trim();
  // 「小菜/小蔡同学」= 小菜同学 和 小蔡同学 两种写法共用一条 token 序列
  // （菜/蔡 同音）。最后一段才是完整的词，前面几段是只换了头一个字的变体。
  const word = name.split('/').pop();
  const r = T.convert(word);
  eq(r.ok ? r.tokens.join(' ') : `失败:${JSON.stringify(r.bad)}`, expected, `${word}`);
  checked++;
}
console.log(`  （共比对 ${checked} 条）`);

console.log('\n▸ 同音字应当给出完全相同的 token');
eq(T.convert('小菜同学').tokens, T.convert('小蔡同学').tokens,
   '小菜同学 与 小蔡同学（菜/蔡 同为 cài）');

console.log('\n▸ 零声母字：整个音节本身就是 token');
eq(T.splitSyllable('ài'), ['ài'], '爱 ài');
eq(T.splitSyllable('èr'), ['èr'], '二 èr');
eq(T.splitSyllable('ān'), ['ān'], '安 ān');

console.log('\n▸ zh/ch/sh 必须先于 z/c/s 匹配');
eq(T.splitSyllable('zhāng'), ['zh', 'āng'], '张 zhāng 不能拆成 z + hāng');
eq(T.splitSyllable('chī'), ['ch', 'ī'], '吃 chī');
eq(T.splitSyllable('shēng'), ['sh', 'ēng'], '生 shēng');

console.log('\n▸ 拆不出来时必须返回 null，不能硬塞');
// 这几条是直接打 splitSyllable 的：pinyin-data 只收了「能拆」的字，
// 所以走 convert() 永远碰不到这个分支——变异检验发现的盲区。
eq(T.splitSyllable('zzz'), null, '整个不是 token、声母切完余下也不是');
eq(T.splitSyllable('bpm'), null, '声母匹配上了但韵母非法');
eq(T.splitSyllable(''), null, '空串');

console.log('\n▸ 整行输出可直接写进词表');
{
  const r = T.convert('小爱同学');
  eq(r.line, 'x iǎo ài t óng x ué @小爱同学', 'line 格式');
}

console.log('\n▸ 转不了的输入要说清楚原因，不能硬塞');
{
  const r = T.convert('小爱ABC');
  eq(r.ok, false, '含英文时失败');
  eq(r.bad.map(b => b.ch), ['A', 'B', 'C'], '指出是哪几个字符');
  const e = T.convert('');
  eq(e.error, 'EMPTY', '空输入');
  const emo = T.convert('小爱😀');
  eq(emo.ok, false, 'emoji 也拦下');
}

console.log('\n▸ 查重按显示名，不看 token');
eq(T.hasWord(kw, '小爱同学'), true, '已有的词认得出');
eq(T.hasWord(kw, '小红同学'), false, '没有的词不误报');

console.log('\n▸ 常见唤醒词都能转');
for (const w of ['小米小米', '你好问问', '小晶小晶', '若琪', '叮咚叮咚']) {
  const r = T.convert(w);
  eq(r.ok, true, `${w} → ${r.ok ? r.tokens.join(' ') : JSON.stringify(r.bad)}`);
}

console.log(`\n${'='.repeat(52)}\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
