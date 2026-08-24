/**
 * 极简 WebM (EBML) 音频解封装器
 * =============================
 * YouTube 的音频轨大多是 WebM/Opus，这条路径和 fMP4 一样必须支持。
 *
 * 只认这些元素：
 *   Segment / Info→TimecodeScale / Tracks→TrackEntry(CodecID, CodecPrivate, Audio)
 *   Cluster→Timecode + SimpleBlock|BlockGroup→Block
 *
 * 有状态：appendBuffer 的分段边界会把元素劈开，所以内部攒一个缓冲区，
 * 只解析已经完整到达的顶层元素，剩下的留到下一段。
 */
(function (root) {
  'use strict';

  const ID = {
    Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1,
    Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83,
    CodecID: 0x86, CodecPrivate: 0x63a2, Audio: 0xe1,
    SamplingFrequency: 0xb5, Channels: 0x9f,
    Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
    BlockGroup: 0xa0, Block: 0xa1,
  };
  // 这些是「容器」元素，要往里钻而不是整块跳过
  const MASTER = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry,
                          ID.Audio, ID.Cluster, ID.BlockGroup]);

  function readVint(u8, p, keepMarker) {
    if (p >= u8.length) return null;
    const first = u8[p];
    if (first === 0) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { mask >>= 1; len++; if (len > 8) return null; }
    if (p + len > u8.length) return null;
    let v = keepMarker ? first : (first & (mask - 1));
    for (let i = 1; i < len; i++) v = v * 256 + u8[p + i];
    return { value: v, len };
  }

  function readUint(u8, p, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8[p + i];
    return v;
  }

  function readFloat(u8, p, n) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p, n);
    return n === 4 ? dv.getFloat32(0) : dv.getUint8 && n === 8 ? dv.getFloat64(0) : 0;
  }

  function createDemuxer() {
    let buf = new Uint8Array(0);
    let timecodeScale = 1000000;          // 纳秒，默认 1ms
    let track = null;                     // {number, codec, codecPrivate, sampleRate, channels}
    let clusterTime = 0;
    let initEmitted = false;

    function append(ab) {
      const inc = new Uint8Array(ab);
      const merged = new Uint8Array(buf.length + inc.length);
      merged.set(buf, 0); merged.set(inc, buf.length);
      buf = merged;
    }

    /** 解析当前缓冲区里所有完整元素，返回 {init, frames} */
    function drain() {
      const frames = [];
      let p = 0;

      while (p < buf.length) {
        const id = readVint(buf, p, true);
        if (!id) break;
        const sz = readVint(buf, p + id.len, false);
        if (!sz) break;
        const hdr = id.len + sz.len;
        const unknownSize = sz.value >= Math.pow(2, 7 * sz.len) - 1;
        const isMaster = MASTER.has(id.value);

        if (isMaster) {
          // 容器：只跳过头，内容留给下一轮循环逐个解析
          if (id.value === ID.Cluster) clusterTime = 0;
          p += hdr;
          continue;
        }

        if (unknownSize) break;
        const end = p + hdr + sz.value;
        if (end > buf.length) break;      // 这个元素还没到齐，等下一段

        const dstart = p + hdr, dlen = sz.value;
        switch (id.value) {
          case ID.TimecodeScale:
            timecodeScale = readUint(buf, dstart, dlen); break;
          case ID.Timecode:
            clusterTime = readUint(buf, dstart, dlen); break;
          case ID.TrackNumber:
            track = track || {}; track.number = readUint(buf, dstart, dlen); break;
          case ID.TrackType:
            track = track || {}; track.type = readUint(buf, dstart, dlen); break;
          case ID.CodecID: {
            track = track || {};
            track.codecId = String.fromCharCode.apply(null, buf.subarray(dstart, dstart + dlen));
            break;
          }
          case ID.CodecPrivate:
            track = track || {}; track.codecPrivate = buf.slice(dstart, dstart + dlen); break;
          case ID.SamplingFrequency:
            track = track || {}; track.sampleRate = Math.round(readFloat(buf, dstart, dlen)); break;
          case ID.Channels:
            track = track || {}; track.channels = readUint(buf, dstart, dlen); break;
          case ID.SimpleBlock:
          case ID.Block: {
            const tn = readVint(buf, dstart, false);
            if (tn) {
              const q = dstart + tn.len;
              const dv = new DataView(buf.buffer, buf.byteOffset + q, 2);
              const rel = dv.getInt16(0);
              const payload = buf.slice(q + 3, dstart + dlen);
              const tNs = (clusterTime + rel) * timecodeScale;
              frames.push({
                data: payload,
                timestampUs: Math.round(tNs / 1000),
                durationUs: 20000,        // Opus 常见帧长；上层只用起点，够了
              });
            }
            break;
          }
        }
        p = end;
      }

      if (p > 0) buf = buf.slice(p);

      let init = null;
      if (!initEmitted && track && track.codecId && track.sampleRate) {
        initEmitted = true;
        init = {
          codec: /OPUS/i.test(track.codecId) ? 'opus'
               : /VORBIS/i.test(track.codecId) ? 'vorbis'
               : track.codecId.toLowerCase(),
          sampleRate: track.sampleRate,
          channels: track.channels || 1,
          // WebM/fMP4 里的裸 Opus 包不能给 description，给了会被当 ogg 解
          description: null,
        };
      }
      return { init, frames };
    }

    return {
      push(ab) { append(ab); return drain(); },
      get track() { return track; },
    };
  }

  function looksLikeWebm(ab) {
    const u = new Uint8Array(ab, 0, Math.min(4, ab.byteLength));
    return u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3;
  }

  const api = { createDemuxer, looksLikeWebm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWWebm = api;
})(typeof self !== 'undefined' ? self : this);
