/**
 * MAIN world 注入脚本 —— 扩展的心脏
 * ================================
 * 干四件事：
 *   1. hook SourceBuffer.appendBuffer，把播放器即将播放的音频段复制一份
 *   2. 就地解封装 + WebCodecs 解码 + 重采样到 16k 单声道
 *   3. 把 PCM 交给 ISOLATED world（再转给 Worker 里的唤醒词检测）
 *   4. 拿到时间戳表后，在 <video> 上挂 GainNode，播到那一刻把音量拉到 0
 *
 * 必须以 world:"MAIN" + run_at:"document_start" 注入，早于播放器脚本首次执行。
 */
(function () {
  'use strict';
  if (window.__wwInstalled) return;
  window.__wwInstalled = true;

  const TAG = '[唤醒词防火墙]';
  const TARGET_SR = 16000;
  const CHUNK = 1600;                 // 100ms @16k，与检测器帧长一致
  const FADE = 0.010;                 // 静音升降沿 10ms

  const log = (...a) => console.debug(TAG, ...a);

  // ------------------------------------------------------------ 探针
  // MSE-in-Workers 会让下面所有 hook 全部失效，必须能立刻自知
  (function installWorkerMseProbe() {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (!d || !d.set) return;
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(v) {
        try {
          if (typeof MediaSourceHandle !== 'undefined' && v instanceof MediaSourceHandle) {
            console.warn(TAG, '检测到 MSE-in-Workers：MediaSource 在 Worker 里创建，' +
              '主线程的 appendBuffer hook 抓不到数据。需要降级到实时路径。');
            post({ type: 'ww:blind', reason: 'worker-mse' });
          }
        } catch (e) { /* ignore */ }
        return d.set.call(this, v);
      },
    });
  })();

  // DRM 内容拿到的是密文，解不出 PCM，检测到就放弃
  const _setMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
  if (_setMediaKeys) {
    HTMLMediaElement.prototype.setMediaKeys = function (mk) {
      post({ type: 'ww:blind', reason: 'drm' });
      return _setMediaKeys.call(this, mk);
    };
  }

  // ------------------------------------------------------------ 与 ISOLATED 通信
  function post(msg) { window.postMessage(Object.assign({ __ww: 1 }, msg), '*'); }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__wwBack) return;
    if (d.type === 'ww:timeline') applyTimeline(d.sbId, d.spans);
  });

  // ------------------------------------------------------------ 每个音频 SourceBuffer 一套状态
  let nextId = 1;
  const tracks = new WeakMap();       // SourceBuffer -> state

  function stateOf(sb) {
    let st = tracks.get(sb);
    if (!st) {
      st = {
        id: nextId++, init: null, decoder: null, offset: 0,
        pending: [], carry: new Float32Array(0), carryTime: 0,
        unsupported: false,
      };
      tracks.set(sb, st);
    }
    return st;
  }

  // 记录哪些 SourceBuffer 是音频轨
  const _addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = _addSourceBuffer.call(this, mime);
    if (/^audio\//i.test(mime)) {
      const st = stateOf(sb);
      st.mime = mime;
      st.media = findMediaFor(this);
      log('音频 SourceBuffer #' + st.id, mime);
      post({ type: 'ww:track', sbId: st.id, mime });
    }
    return sb;
  };

  // timestampOffset 会平移时间轴，不跟着算就会和 currentTime 对不上
  const tsDesc = Object.getOwnPropertyDescriptor(
    SourceBuffer.prototype, 'timestampOffset');
  if (tsDesc && tsDesc.set) {
    Object.defineProperty(SourceBuffer.prototype, 'timestampOffset', {
      configurable: true, enumerable: tsDesc.enumerable, get: tsDesc.get,
      set(v) { const st = tracks.get(this); if (st) st.offset = v || 0; return tsDesc.set.call(this, v); },
    });
  }

  const _appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const st = tracks.get(this);
    if (st && !st.unsupported) {
      try {
        // 必须在放行之前同步复制：播放器可能复用同一块 ArrayBuffer
        const ab = data instanceof ArrayBuffer
          ? data.slice(0)
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        queueMicrotask(() => handleSegment(st, ab));
      } catch (e) { log('复制段失败', e); }
    }
    return _appendBuffer.call(this, data);
  };

  // ------------------------------------------------------------ 解封装 + 解码

  async function handleSegment(st, ab) {
    const M = self.WWMp4, W = self.WWWebm;
    if (!M || !W) return;
    try {
      // 容器嗅探：WebM/Opus（YouTube 常用）走 EBML，其余按 fMP4 处理
      if (st.container === 'webm' || (!st.container && W.looksLikeWebm(ab))) {
        st.container = 'webm';
        st.webm = st.webm || W.createDemuxer();
        const r = st.webm.push(ab);
        if (r.init && !st.init) { st.init = r.init; await setupDecoder(st, r.init); }
        if (!st.decoder) return;
        for (const f of r.frames) {
          if (st.decoder.state !== 'configured') break;
          st.decoder.decode(new EncodedAudioChunk({
            type: 'key', timestamp: f.timestampUs,
            duration: f.durationUs, data: f.data,
          }));
        }
        return;
      }
      st.container = 'mp4';
      if (M.isInitSegment(ab)) {
        const init = M.parseInit(ab);
        if (!init) return;
        st.init = init;
        await setupDecoder(st, init);
        return;
      }
      if (!st.init || !st.decoder) return;
      const frames = M.parseSegment(ab, st.init);
      for (const f of frames) {
        if (st.decoder.state !== 'configured') break;
        st.decoder.decode(new EncodedAudioChunk({
          type: 'key', timestamp: f.timestampUs,
          duration: f.durationUs, data: f.data,
        }));
      }
    } catch (e) { log('处理段出错', e); }
  }

  async function setupDecoder(st, init) {
    const cfg = {
      codec: init.codec,
      sampleRate: init.sampleRate,
      numberOfChannels: init.channels,
    };
    if (init.description && init.description.length) cfg.description = init.description;

    try {
      const sup = await AudioDecoder.isConfigSupported(cfg);
      if (!sup || !sup.supported) throw new Error('不支持 ' + init.codec);
    } catch (e) {
      st.unsupported = true;
      log('解码器不支持，放弃这条轨：', init.codec, e.message);
      post({ type: 'ww:blind', reason: 'codec:' + init.codec });
      return;
    }

    st.decoder = new AudioDecoder({
      output: (ad) => onDecoded(st, ad),
      error: (e) => { log('解码错误', e); },
    });
    st.decoder.configure(cfg);
    log('解码器就绪', init.codec, init.sampleRate + 'Hz', init.channels + 'ch');
  }

  function onDecoded(st, ad) {
    try {
      const n = ad.numberOfFrames, ch = ad.numberOfChannels;
      // 下混成单声道
      const mono = new Float32Array(n);
      const tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += tmp[i];
      }
      if (ch > 1) for (let i = 0; i < n; i++) mono[i] /= ch;

      const t0 = ad.timestamp / 1e6 + st.offset;
      const res = resample(mono, ad.sampleRate, TARGET_SR);
      pushPcm(st, res, t0);
    } catch (e) { log('取样出错', e); }
    finally { ad.close(); }
  }

  /** 4 抽头 Lanczos 重采样，够 KWS 用且比线性插值好得多 */
  function resample(x, srIn, srOut) {
    if (srIn === srOut) return x;
    const ratio = srIn / srOut;
    const n = Math.floor(x.length / ratio);
    const y = new Float32Array(n);
    const A = 2;
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const c = Math.floor(pos);
      let s = 0, wsum = 0;
      for (let k = c - A + 1; k <= c + A; k++) {
        if (k < 0 || k >= x.length) continue;
        const d = pos - k;
        let w;
        if (d === 0) w = 1;
        else if (Math.abs(d) >= A) w = 0;
        else {
          const pd = Math.PI * d;
          w = (Math.sin(pd) / pd) * (Math.sin(pd / A) / (pd / A));
        }
        s += x[k] * w; wsum += w;
      }
      y[i] = wsum ? s / wsum : 0;
    }
    return y;
  }

  /** 攒够 100ms 就发一帧，附带这一帧对应的媒体时间 */
  function pushPcm(st, pcm, tStart) {
    if (st.carry.length === 0) st.carryTime = tStart;
    const merged = new Float32Array(st.carry.length + pcm.length);
    merged.set(st.carry, 0); merged.set(pcm, st.carry.length);

    let off = 0;
    while (merged.length - off >= CHUNK) {
      const frame = merged.slice(off, off + CHUNK);
      const t = st.carryTime + off / TARGET_SR;
      // Int16 传输，体积只有 Float32 的一半
      const i16 = new Int16Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) {
        const v = Math.max(-1, Math.min(1, frame[i]));
        i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      if (window.__wwDebug) window.__wwDebug.pcmFrames++;
      post({ type: 'ww:pcm', sbId: st.id, t, pcm: i16.buffer });
      off += CHUNK;
    }
    st.carry = merged.slice(off);
    st.carryTime = st.carryTime + off / TARGET_SR;
  }

  // ------------------------------------------------------------ 播放侧：按时间戳静音

  function findMediaFor(ms) {
    // MediaSource 通过 blob URL 或 srcObject 绑到 <video>，这里做一次宽松查找
    const list = document.querySelectorAll('video, audio');
    for (const el of list) if (el.src && el.src.startsWith('blob:')) return el;
    return list[0] || null;
  }

  const gains = new WeakMap();
  let audioCtx = null;

  function attachGain(media) {
    if (!media) return null;
    let g = gains.get(media);
    if (g) return g;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(media);
      const gain = audioCtx.createGain();
      src.connect(gain).connect(audioCtx.destination);
      g = { ctx: audioCtx, gain };
      gains.set(media, g);
      if (window.__wwDebug) window.__wwDebug.attached = true;
      log('已接管音频输出');
    } catch (e) {
      log('接管音频输出失败（可能已被别的脚本接管）', e.message);
      return null;
    }
    return g;
  }

  const timelines = new Map();   // sbId -> spans

  function applyTimeline(sbId, spans) {
    timelines.set(sbId, spans);
    const media = document.querySelector('video, audio');
    if (!media) return;
    const g = attachGain(media);
    if (!g) return;
    if (!media.__wwTicking) {
      media.__wwTicking = true;
      const tick = () => {
        scheduleNear(media, g);
        media.__wwRaf = requestAnimationFrame(tick);
      };
      tick();
      media.addEventListener('seeking', () => { scheduled.clear(); });
    }
    post({ type: 'ww:marks', spans });
  }

  const scheduled = new Set();
  const dbg = { scheduled: [], attached: false, pcmFrames: 0 };
  window.__wwDebug = dbg;
  window.__wwForceHit = (span) => applyTimeline(999, [span]);

  function scheduleNear(media, g) {
    const now = media.currentTime;
    const ctxNow = g.ctx.currentTime;
    for (const spans of timelines.values()) {
      for (const sp of spans) {
        if (sp[1] < now - 0.2) continue;
        if (sp[0] > now + 1.0) continue;          // 只调度未来 1 秒内的
        const key = sp[0].toFixed(3);
        if (scheduled.has(key)) continue;
        scheduled.add(key);
        const lead = sp[0] - now;                  // 距离静音开始还有多久
        const t0 = ctxNow + Math.max(0, lead);
        const t1 = ctxNow + Math.max(0, sp[1] - now);
        g.gain.gain.setValueAtTime(g.gain.gain.value, Math.max(ctxNow, t0 - FADE));
        g.gain.gain.linearRampToValueAtTime(0.0001, t0);
        g.gain.gain.setValueAtTime(0.0001, t1);
        g.gain.gain.linearRampToValueAtTime(1.0, t1 + FADE);
        dbg.scheduled.push([sp[0], sp[1]]);
        log(`已排程静音 ${sp[0].toFixed(2)}–${sp[1].toFixed(2)}s`);
        post({ type: 'ww:muted', span: sp });
      }
    }
  }

  log('已注入');
  post({ type: 'ww:ready' });
})();
