/**
 * 极简 fMP4 (ISO-BMFF) 音频解封装器
 * ---------------------------------
 * 只做一件事：从播放器 appendBuffer 的字节流里抠出音频编码帧 + 时间戳，
 * 好喂给 WebCodecs 的 AudioDecoder。不解码、不重封装。
 *
 * 支持：
 *   init segment  → moov/trak/mdia/mdhd(timescale) + stsd/mp4a/esds(AudioSpecificConfig)
 *                   或 stsd/Opus/dOps
 *   media segment → moof/traf/tfhd + tfdt(baseMediaDecodeTime) + trun(样本表) + mdat
 *
 * 同时可在 Node 与浏览器运行，方便离线单测。
 */
(function (root) {
  'use strict';

  function u32(v, o) { return v.getUint32(o); }
  function u64(v, o) { return v.getUint32(o) * 4294967296 + v.getUint32(o + 4); }

  /** 遍历一层 box，回调 (type, payloadStart, payloadEnd, headerSize) */
  function walk(view, start, end, cb) {
    let p = start;
    while (p + 8 <= end) {
      let size = u32(view, p);
      const type = String.fromCharCode(
        view.getUint8(p + 4), view.getUint8(p + 5),
        view.getUint8(p + 6), view.getUint8(p + 7));
      let hdr = 8;
      if (size === 1) { size = u64(view, p + 8); hdr = 16; }
      else if (size === 0) { size = end - p; }
      if (size < hdr || p + size > end) break;
      cb(type, p + hdr, p + size, hdr);
      p += size;
    }
  }

  function find(view, start, end, path) {
    let result = null;
    walk(view, start, end, (type, s, e) => {
      if (result) return;
      if (type === path[0]) {
        if (path.length === 1) result = { start: s, end: e };
        else result = find(view, s, e, path.slice(1));
      }
    });
    return result;
  }

  /** 从 esds 里抠出 AudioSpecificConfig（WebCodecs 配置 AAC 时必须给）*/
  function parseEsds(view, start, end) {
    let p = start + 4; // FullBox version+flags
    function tag() {
      const t = view.getUint8(p++);
      let len = 0, b;
      do { b = view.getUint8(p++); len = (len << 7) | (b & 0x7f); } while (b & 0x80);
      return { t, len };
    }
    let d = tag();
    if (d.t !== 0x03) return null;
    p += 2;                                   // ES_ID
    const flags = view.getUint8(p++);
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + view.getUint8(p);
    if (flags & 0x20) p += 2;
    d = tag();
    if (d.t !== 0x04) return null;
    const objectType = view.getUint8(p);
    p += 13;
    d = tag();
    if (d.t !== 0x05) return null;
    const asc = new Uint8Array(view.buffer, view.byteOffset + p,
                               Math.min(d.len, end - p));
    return { objectType, asc: asc.slice() };
  }

  /**
   * 解析 init segment。返回 {timescale, codec, description, sampleRate, channels}
   * codec 形如 'mp4a.40.2' 或 'opus'
   */
  function parseInit(buf) {
    const view = new DataView(buf);
    const moov = find(view, 0, buf.byteLength, ['moov']);
    if (!moov) return null;

    let out = null;
    walk(view, moov.start, moov.end, (type, s, e) => {
      if (type !== 'trak' || out) return;
      const mdhd = find(view, s, e, ['mdia', 'mdhd']);
      const stsd = find(view, s, e, ['mdia', 'minf', 'stbl', 'stsd']);
      if (!mdhd || !stsd) return;

      const ver = view.getUint8(mdhd.start);
      const timescale = ver === 1 ? u32(view, mdhd.start + 20)
                                  : u32(view, mdhd.start + 12);

      // stsd: version/flags(4) + entryCount(4) 之后才是 sample entry
      let entry = null;
      walk(view, stsd.start + 8, stsd.end, (t, es, ee) => {
        if (!entry) entry = { t, es, ee };
      });
      if (!entry) return;
      const isAudio = /^(mp4a|Opus|opus|fLaC|ac-3|ec-3)$/.test(entry.t);
      if (!isAudio) return;

      // AudioSampleEntry: 6 保留 + 2 dataRefIdx + 8 保留 + 2 channels
      //                 + 2 sampleSize + 4 保留 + 4 sampleRate(16.16)
      const base = entry.es;
      const channels = view.getUint16(base + 16);
      const sampleRate = view.getUint32(base + 24) >>> 16;

      let codec = null, description = null;
      if (entry.t === 'mp4a') {
        const esds = find(view, base + 28, entry.ee, ['esds']);
        const info = esds && parseEsds(view, esds.start, esds.end);
        // AAC-LC 在 fMP4 里是裸 AAC，必须给 description，否则被当 ADTS 解
        codec = 'mp4a.40.' + ((info && info.asc && info.asc.length)
          ? (info.asc[0] >> 3) || 2 : 2);
        description = info ? info.asc : null;
      } else if (/^[Oo]pus$/.test(entry.t)) {
        // Opus 相反：fMP4/WebM 里是裸 Opus 包，给了 description 会被当 ogg
        codec = 'opus';
        description = null;
      } else if (entry.t === 'fLaC') {
        codec = 'flac';
        const dfla = find(view, base + 28, entry.ee, ['dfLa']);
        if (dfla) description = new Uint8Array(
          buf, dfla.start + 4, dfla.end - dfla.start - 4).slice();
      } else {
        codec = entry.t.toLowerCase();      // ac-3 / ec-3：多半解不了，交给上层探测
      }
      out = { timescale, codec, description, sampleRate, channels };
    });
    return out;
  }

  /**
   * 解析 media segment，返回 [{data, timestampUs, durationUs}]
   * init 为 parseInit 的结果（需要 timescale）
   */
  function parseSegment(buf, init) {
    const view = new DataView(buf);
    const ts = (init && init.timescale) || 90000;
    const frames = [];

    let moofStart = -1;
    walk(view, 0, buf.byteLength, (type, s, e, hdr) => {
      if (type === 'moof') moofStart = s - hdr;
      if (type !== 'mdat' || moofStart < 0) return;

      const mdatStart = s;
      const moofEnd = s - hdr;
      // traf
      walk(view, find(view, moofStart + 8, moofEnd, ['mfhd'])
             ? moofStart + 8 : moofStart + 8, moofEnd, (t2, s2, e2) => {
        if (t2 !== 'traf') return;

        let defaultDuration = 0, defaultSize = 0, dataOffsetPresent = false;
        let baseTime = 0, trunEntries = null, trunDataOffset = 0;

        walk(view, s2, e2, (t3, s3, e3) => {
          if (t3 === 'tfhd') {
            const fl = u32(view, s3) & 0xffffff;
            let p = s3 + 4 + 4;                       // flags + trackID
            if (fl & 0x01) p += 8;                    // base-data-offset
            if (fl & 0x02) p += 4;                    // sample-description-index
            if (fl & 0x08) { defaultDuration = u32(view, p); p += 4; }
            if (fl & 0x10) { defaultSize = u32(view, p); p += 4; }
          } else if (t3 === 'tfdt') {
            const ver = view.getUint8(s3);
            baseTime = ver === 1 ? u64(view, s3 + 4) : u32(view, s3 + 4);
          } else if (t3 === 'trun') {
            const fl = u32(view, s3) & 0xffffff;
            const count = u32(view, s3 + 4);
            let p = s3 + 8;
            if (fl & 0x001) { trunDataOffset = view.getInt32(p); p += 4; dataOffsetPresent = true; }
            if (fl & 0x004) p += 4;                   // first-sample-flags
            const list = [];
            for (let i = 0; i < count; i++) {
              let dur = defaultDuration, sz = defaultSize;
              if (fl & 0x100) { dur = u32(view, p); p += 4; }
              if (fl & 0x200) { sz = u32(view, p); p += 4; }
              if (fl & 0x400) p += 4;                 // sample-flags
              if (fl & 0x800) p += 4;                 // composition-time-offset
              list.push({ dur, sz });
            }
            trunEntries = list;
          }
        });

        if (!trunEntries) return;
        // data offset 相对 moof 起点；没给就退回 mdat 起点
        let off = dataOffsetPresent ? moofStart + trunDataOffset : mdatStart;
        let t = baseTime;
        for (const s4 of trunEntries) {
          if (off + s4.sz > buf.byteLength) break;
          frames.push({
            data: new Uint8Array(buf, off, s4.sz).slice(),
            timestampUs: Math.round(t / ts * 1e6),
            durationUs: Math.round(s4.dur / ts * 1e6),
          });
          off += s4.sz;
          t += s4.dur;
        }
      });
      moofStart = -1;
    });
    return frames;
  }

  function isInitSegment(buf) {
    const view = new DataView(buf);
    let has = false;
    walk(view, 0, buf.byteLength, (t) => { if (t === 'moov') has = true; });
    return has;
  }

  const api = { parseInit, parseSegment, isInitSegment, _walk: walk, _find: find };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWMp4 = api;
})(typeof self !== 'undefined' ? self : this);
