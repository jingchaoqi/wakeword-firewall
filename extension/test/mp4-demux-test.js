/**
 * mp4-demux.js 的离线单测
 * =======================
 * 为什么需要它：B 站点播主力是 fMP4 + AAC，但这条路一直没法测——
 * 开源版 Chromium 不带 AAC，addSourceBuffer('audio/mp4; codecs="mp4a.40.2"')
 * 直接 NotSupportedError，端到端测试跑不到 mp4-demux 这一环。
 *
 * 解法：解封装器只认字节结构、不解码，所以可以手搓 fMP4 喂给它。
 * 这里测的是**解析正确性**（timescale / 声道 / 采样率 / AudioSpecificConfig /
 * 样本切分 / 时间戳推进），测不到 WebCodecs 那一环——那部分仍需带 AAC 的
 * 正式版 Chrome 跑 e2e-selftest.js。
 *
 *   node extension/test/mp4-demux-test.js
 */
'use strict';
const M = require('../src/mp4-demux.js');

// ── 最小 fMP4 构造器 ────────────────────────────────────────────────
const str = (s) => Buffer.from(s, 'latin1');
const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u64 = (n) => Buffer.concat([u32(Math.floor(n / 4294967296)), u32(n >>> 0)]);

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), str(type), body]);
}

/** ES_Descriptor 里的长度字段是 7 位一组的变长编码 */
function descLen(n) {
  const out = [];
  do { out.unshift(n & 0x7f); n >>= 7; } while (n > 0);
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
  return Buffer.from(out);
}
function desc(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u8(tag), descLen(body.length), body]);
}

function esds(asc) {
  const dsi = desc(0x05, Buffer.from(asc));
  const dcd = desc(0x04,
    u8(0x40),                       // objectTypeIndication = MPEG-4 Audio
    u8(0x15), Buffer.alloc(3),      // streamType/upStream/reserved + bufferSizeDB(3)
    u32(0), u32(0),                 // maxBitrate / avgBitrate
    dsi);
  const es = desc(0x03, u16(1), u8(0), dcd);   // ES_ID=1, flags=0（无依赖/无 URL/无 OCR）
  return box('esds', u32(0), es);
}

function audioSampleEntry(type, channels, sampleRate, ...children) {
  return box(type,
    Buffer.alloc(6),                // reserved
    u16(1),                         // data_reference_index
    Buffer.alloc(8),                // reserved (version/revision/vendor)
    u16(channels),                  // → base+16
    u16(16),                        // samplesize
    u16(0), u16(0),                 // pre_defined / reserved
    u32(sampleRate << 16),          // → base+24，16.16 定点
    ...children);
}

/** @param opts {timescale, channels, sampleRate, asc, mdhdVersion, entryType} */
function initSegment(opts) {
  const o = Object.assign({
    timescale: 48000, channels: 2, sampleRate: 48000,
    asc: [0x11, 0x90], mdhdVersion: 0, entryType: 'mp4a',
  }, opts);

  const mdhd = o.mdhdVersion === 1
    ? box('mdhd', u8(1), Buffer.alloc(3), u64(0), u64(0), u32(o.timescale), u64(0), u32(0))
    : box('mdhd', u8(0), Buffer.alloc(3), u32(0), u32(0), u32(o.timescale), u32(0), u32(0));

  const entry = o.entryType === 'mp4a'
    ? audioSampleEntry('mp4a', o.channels, o.sampleRate, esds(o.asc))
    : audioSampleEntry(o.entryType, o.channels, o.sampleRate,
                       box('dOps', Buffer.alloc(11)));

  const stbl = box('stbl', box('stsd', u32(0), u32(1), entry));
  const trak = box('trak',
    box('tkhd', u8(0), Buffer.alloc(3), Buffer.alloc(72)),
    box('mdia', mdhd, box('hdlr', u32(0), u32(0), str('soun'), Buffer.alloc(12)),
        box('minf', stbl)));
  return Buffer.concat([
    box('ftyp', str('iso5'), u32(0), str('iso5dash')),
    box('moov', box('mvhd', u8(0), Buffer.alloc(3), Buffer.alloc(96)), trak),
  ]);
}

/** @param opts {baseTime, samples:[{size,dur}], tfdtVersion} */
function mediaSegment(opts) {
  const o = Object.assign({ baseTime: 0, tfdtVersion: 0 }, opts);
  // mdatBytes 可以故意小于 trun 声明的总量，用来测越界防线
  const payload = o.mdatBytes != null
    ? Buffer.alloc(o.mdatBytes, 1)
    : Buffer.concat(o.samples.map((s, i) => Buffer.alloc(s.size, i + 1)));

  const tfdt = o.tfdtVersion === 1
    ? box('tfdt', u8(1), Buffer.alloc(3), u64(o.baseTime))
    : box('tfdt', u8(0), Buffer.alloc(3), u32(o.baseTime));

  // trun flags: 0x001 data-offset | 0x100 sample-duration | 0x200 sample-size
  const trunBody = Buffer.concat(o.samples.map(s => Buffer.concat([u32(s.dur), u32(s.size)])));
  const mkTrun = (dataOffset) => box('trun',
    u32(0x000301), u32(o.samples.length), u32(dataOffset), trunBody);

  // data_offset 相对 moof 起点，而它自己在 moof 里——先用占位算出长度再回填
  const mkMoof = (trun) => box('moof',
    box('mfhd', u32(0), u32(1)),
    box('traf', box('tfhd', u32(0x000000), u32(1)), tfdt, trun));
  const moofLen = mkMoof(mkTrun(0)).length;
  const moof = mkMoof(mkTrun(moofLen + 8));   // +8 = mdat 头

  return Buffer.concat([moof, box('mdat', payload)]);
}

// ── 断言 ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✅ ${what}`); }
  else { fail++; console.log(`  ❌ ${what}\n       实际 ${a}\n       期望 ${e}`); }
}
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// ── 用例 ────────────────────────────────────────────────────────────
console.log('\n▸ init segment：AAC-LC，mdhd v0');
{
  const init = M.parseInit(toAB(initSegment({})));
  eq(!!init, true, 'parseInit 有返回');
  eq(init.timescale, 48000, 'timescale');
  eq(init.channels, 2, '声道数');
  eq(init.sampleRate, 48000, '采样率');
  eq(init.codec, 'mp4a.40.2', 'codec 从 AudioSpecificConfig 推出来');
  eq(Array.from(init.description || []), [0x11, 0x90],
     'description = AudioSpecificConfig（AAC 必须给，否则被当 ADTS 解）');
}

console.log('\n▸ init segment：mdhd v1（64 位时间字段，timescale 偏移不同）');
{
  const init = M.parseInit(toAB(initSegment({ mdhdVersion: 1, timescale: 44100 })));
  eq(init && init.timescale, 44100, 'v1 分支的 timescale 偏移正确');
}

console.log('\n▸ init segment：单声道 / 16k');
{
  const init = M.parseInit(toAB(initSegment({ channels: 1, sampleRate: 16000 })));
  eq([init.channels, init.sampleRate], [1, 16000], '声道与采样率');
}

console.log('\n▸ init segment：mp4 里的 Opus（description 必须是 null）');
{
  const init = M.parseInit(toAB(initSegment({ entryType: 'Opus' })));
  eq(init && init.codec, 'opus', 'codec');
  eq(init && init.description, null,
     'Opus 不能给 description，给了会被当 ogg 解');
}

console.log('\n▸ isInitSegment 区分 init 与 media');
{
  eq(M.isInitSegment(toAB(initSegment({}))), true, 'init 段有 moov');
  eq(M.isInitSegment(toAB(mediaSegment({ samples: [{ size: 4, dur: 1024 }] }))),
     false, 'media 段没有 moov');
}

console.log('\n▸ media segment：样本切分与时间戳推进');
{
  const init = { timescale: 48000 };
  const seg = mediaSegment({
    baseTime: 48000,                        // 正好第 1 秒
    samples: [{ size: 10, dur: 1024 }, { size: 20, dur: 1024 }, { size: 30, dur: 1024 }],
  });
  const f = M.parseSegment(toAB(seg), init);
  eq(f.length, 3, '样本数');
  eq(f.map(x => x.data.length), [10, 20, 30], '每个样本的字节数');
  eq(f.map(x => Array.from(x.data.slice(0, 1))[0]), [1, 2, 3],
     '样本内容按 trun 的 size 依次切开，没有错位');
  eq(f[0].timestampUs, 1000000, '首样本时间戳 = baseTime/timescale');
  eq(f[1].timestampUs, Math.round((48000 + 1024) / 48000 * 1e6),
     '第二个样本按 duration 推进');
  eq(f[0].durationUs, Math.round(1024 / 48000 * 1e6), 'duration 换算');
}

console.log('\n▸ media segment：tfdt v1（64 位 baseMediaDecodeTime）');
{
  const big = 48000 * 3600;                 // 一小时，超出 32 位表达不成问题但走 v1 分支
  const seg = mediaSegment({ baseTime: big, tfdtVersion: 1, samples: [{ size: 8, dur: 1024 }] });
  const f = M.parseSegment(toAB(seg), { timescale: 48000 });
  eq(f.length, 1, '样本数');
  eq(f[0].timestampUs, Math.round(big / 48000 * 1e6), 'v1 的 64 位读取正确');
}

console.log('\n▸ media segment：一个缓冲里多个 moof+mdat 对');
{
  const a = mediaSegment({ baseTime: 0, samples: [{ size: 5, dur: 1024 }] });
  const b = mediaSegment({ baseTime: 1024, samples: [{ size: 7, dur: 1024 }] });
  const f = M.parseSegment(toAB(Buffer.concat([a, b])), { timescale: 48000 });
  eq(f.length, 2, '两个分片都解出来了');
  eq(f.map(x => x.data.length), [5, 7], '各自的样本大小');
  eq(f[1].timestampUs, Math.round(1024 / 48000 * 1e6), '第二个分片的时间戳');
}

console.log('\n▸ 健壮性：trun 声明的样本比 mdat 实际装的多');
{
  // 这条是给 `off + s4.sz > buf.byteLength` 那道防线准备的。
  // 上面那个「截断缓冲」用例走不到它——mdat 的 box 头声明长度超出缓冲时，
  // walk 直接 break，样本循环根本不会跑。（变异检验发现的盲区。）
  const seg = mediaSegment({
    samples: [{ size: 100, dur: 1024 }, { size: 100, dur: 1024 }],
    mdatBytes: 100,                     // 只装得下第一个
  });
  let threw = null, f = [];
  try { f = M.parseSegment(toAB(seg), { timescale: 48000 }); } catch (e) { threw = e.message; }
  eq(threw, null, '不抛异常');
  eq(f.length, 1, '装得下的那个解出来，越界的那个被丢掉');
  eq(f[0].data.length, 100, '解出来的样本长度正确');
}

console.log('\n▸ 健壮性：截断的缓冲不能崩');
{
  const seg = mediaSegment({ samples: [{ size: 100, dur: 1024 }] });
  const cut = seg.subarray(0, seg.length - 60);   // mdat 被砍掉一半
  let threw = null;
  let f = [];
  try { f = M.parseSegment(toAB(cut), { timescale: 48000 }); } catch (e) { threw = e.message; }
  eq(threw, null, '截断不抛异常');
  eq(f.length, 0, '放不下的样本被丢掉，不返回半截数据');
}

console.log(`\n${'='.repeat(50)}\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
