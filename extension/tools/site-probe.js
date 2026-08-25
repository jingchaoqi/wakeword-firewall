/**
 * 站点兼容性探针
 * ==============
 * 回答一个问题：**在这个站点上，主线程 hook `SourceBuffer.prototype.appendBuffer`
 * 到底抓不抓得到音频字节。**
 *
 * 这是唯一可能推翻整个架构的未知数（见 CONTRIBUTING.md）。常见的三行检查
 * （`video.src` / `video.srcObject` / `canConstructInDedicatedWorker`）只能告诉你
 * MediaSource 在哪，不能告诉你 hook 是否真的拿到了数据——所以这个探针真的去 hook，
 * 真的数字节，真的解析轨道类型。
 *
 * 用法
 * ----
 * 1. 打开一个正在播放的视频页（B 站 / YouTube 都行）
 * 2. F12 打开控制台，整个文件粘进去回车
 * 3. 等 15 秒，看报告
 *
 * 它只读不写：复制一份数据用于统计，原样放行给播放器，播放行为完全不受影响。
 * 探针会在报告打印后自动卸载，把 appendBuffer 还原。
 */
(() => {
  'use strict';

  const WINDOW_SEC = 15;
  const log = (...a) => console.log('%c[探针]', 'color:#1C6A66;font-weight:bold', ...a);

  // ---------------------------------------------------------------- 环境检查

  if (typeof MediaSource === 'undefined') {
    log('❌ 这个浏览器没有 MediaSource，方案不适用。');
    return;
  }

  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) {
    log('❌ 页面上没有 <video> 元素。');
    log('   如果播放器在 iframe 里，请在 DevTools 控制台左上角的 context 下拉框中',
        '切到那个 iframe，再粘一次。');
    return;
  }

  const v = videos.find(x => !x.paused) || videos[0];
  if (v.paused) log('⚠️ 视频没在播放。请点播放，否则播放器不会继续 append，探针会空转。');

  // ------------------------------------------------- 第一层：MediaSource 在哪

  const srcObject = v.srcObject;
  const inWorker = srcObject != null &&
    (typeof MediaSourceHandle !== 'undefined'
      ? srcObject instanceof MediaSourceHandle
      : String(srcObject) === '[object MediaSourceHandle]');

  const where = {
    'video.src': v.src ? v.src.slice(0, 60) + (v.src.length > 60 ? '…' : '') : '(空)',
    'video.srcObject': srcObject ? String(srcObject) : '(空)',
    'MediaSource.canConstructInDedicatedWorker':
      MediaSource.canConstructInDedicatedWorker ?? '(该浏览器无此属性)',
  };
  log('MediaSource 在哪：');
  console.table(where);

  if (inWorker) {
    log('❌ 中招了：MediaSource 在 Dedicated Worker 里（srcObject 是 MediaSourceHandle）。');
    log('   主线程 patch SourceBuffer.prototype 一个字节也抓不到。');
    log('   补救方向：在 MAIN world 覆盖 window.Worker，用 importScripts 把补丁');
    log('   前置注入 worker。复杂度会明显上升。');
    log('   —— 后面的字节统计就不用跑了，直接把这段输出发回去。');
    return;
  }
  if (!v.src.startsWith('blob:') && !srcObject) {
    log('⚠️ video.src 不是 blob: 开头，这个播放器可能压根没用 MSE');
    log('   （渐进式下载 / HLS 原生播放）。预扫描方案对它不适用，但也不是本方案的失败。');
  }

  // ------------------------------------------- 第二层：真的 hook，真的数字节

  const orig = SourceBuffer.prototype.appendBuffer;
  if (orig.__probePatched) { log('⚠️ 探针已经在跑了，别重复粘。'); return; }

  const tracks = new Map();          // SourceBuffer -> 统计
  let nextId = 1;

  // 顺带 hook addSourceBuffer：它的参数直接就是 mime，比嗅探字节可靠得多。
  // 贴探针时播放器多半已经建好 SourceBuffer 了，所以这条只在之后重建时才生效
  // ——B 站切视频、换清晰度都会重建，值多等一会儿。
  const mimeOf = new WeakMap();
  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    try { mimeOf.set(sb, String(mime)); } catch (e) {}
    return sb;
  };

  // fMP4 的 hdlr box 里 handler type 紧跟其后：'soun' = 音轨, 'vide' = 视频轨。
  // WebM 走 EBML，这里只做粗筛，够探针用。
  const ascii = (u8, i, s) => {
    for (let k = 0; k < s.length; k++) if (u8[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  const findAll = (u8, s, limit) => {
    const out = [];
    // +1：最后一个合法起点是 u8.length - s.length，少这个 1 就会漏掉正好落在
    // 缓冲区末尾的匹配。limit 也要一起夹，否则 ascii() 会越界读到 undefined。
    const end = Math.min(u8.length - s.length + 1, limit ?? Infinity);
    for (let i = 0; i < end; i++) if (ascii(u8, i, s)) out.push(i);
    return out;
  };

  // fMP4 是 fourCC，WebM 是 EBML 里的 CodecID 字符串（"A_OPUS" 这种）——两种都要认
  const CODECS = [
    // fMP4
    ['mp4a', 'audio'], ['Opus', 'audio'], ['ec-3', 'audio'], ['ac-3', 'audio'],
    ['fLaC', 'audio'], ['avc1', 'video'], ['hvc1', 'video'], ['hev1', 'video'],
    ['av01', 'video'], ['vp09', 'video'],
    // WebM / Matroska CodecID
    ['A_OPUS', 'audio'], ['A_VORBIS', 'audio'], ['A_AAC', 'audio'], ['A_FLAC', 'audio'],
    ['V_VP8', 'video'], ['V_VP9', 'video'], ['V_AV1', 'video'],
  ];

  function sniff(u8) {
    const r = { kind: null, codec: null, drm: false, init: false };
    // 初始化段：fMP4 看 moov，WebM 看 DocType "webm"
    if (findAll(u8, 'moov', 4096).length || findAll(u8, 'webm', 4096).length) r.init = true;
    // DRM：这里只认 fMP4 的 pssh box。WebM 的加密标记是 EBML 元素 ID（0x5035），
    // 不是 ASCII 字符串，扫不出来——那条路靠下面的 encrypted 事件 / mediaKeys 兜底。
    if (findAll(u8, 'pssh', 65536).length) r.drm = true;

    // fMP4 的 hdlr box：size(4) type(4) version+flags(4) pre_defined(4) handler_type(4)
    for (const i of findAll(u8, 'hdlr', 65536)) {
      const h = i + 12;
      if (ascii(u8, h, 'soun')) { r.kind = 'audio'; break; }
      if (ascii(u8, h, 'vide')) { r.kind = 'video'; break; }
    }
    // WebM 没有 hdlr，靠 CodecID 定轨道类型
    for (const [cc, kind] of CODECS) {
      if (findAll(u8, cc, 65536).length) {
        r.codec = cc;
        if (!r.kind) r.kind = kind;
        break;
      }
    }
    return r;
  }

  SourceBuffer.prototype.appendBuffer = function (buf) {
    try {
      let t = tracks.get(this);
      if (!t) {
        t = { id: nextId++, appends: 0, bytes: 0, kind: null, codec: null,
              drm: false, sawInit: false, sniffs: 0 };
        tracks.set(this, t);
      }
      // 必须在调用原函数之前同步取——播放器可能复用同一块 ArrayBuffer
      const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf)
               : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
               : null;
      if (u8) {
        t.appends++;
        t.bytes += u8.length;
        // 判出来就不再扫。判不出来也最多再试 8 次——否则每个 append（视频轨
        // 动辄 1MB）都要跑二十来次 64KB 扫描，纯属白烧 CPU。
        if ((!t.sawInit || !t.kind) && t.sniffs < 8) {
          t.sniffs++;
          const s = sniff(u8);
          if (s.init) t.sawInit = true;
          if (s.kind && !t.kind) t.kind = s.kind;
          if (s.codec && !t.codec) t.codec = s.codec;
          if (s.drm) t.drm = true;
        }
      }
    } catch (e) { /* 探针绝不能影响播放 */ }
    return orig.call(this, buf);
  };
  SourceBuffer.prototype.appendBuffer.__probePatched = true;

  // DRM：EME 一旦介入，appendBuffer 拿到的就是密文
  let encrypted = false;
  const onEnc = () => { encrypted = true; };
  v.addEventListener('encrypted', onEnc);

  log(`已挂上 hook，观察 ${WINDOW_SEC} 秒…（这期间正常看视频就行）`);

  // ---------------------------------------------------------------- 出报告

  setTimeout(() => {
    SourceBuffer.prototype.appendBuffer = orig;
    v.removeEventListener('encrypted', onEnc);

    // 字节量启发式：音视频分离时视频轨通常是音频轨的几倍到十几倍。
    // 只在嗅探不出类型时兜底，且会在报告里标明是「推断」。
    const sizes = [...tracks.values()].map(t => t.bytes).sort((a, b) => a - b);
    const ratio = sizes.length === 2 && sizes[0] > 0 ? sizes[1] / sizes[0] : 0;
    const guessable = tracks.size === 2 && ratio >= 3;
    let guessed = 0;

    const rows = [];
    let audio = null;
    for (const [sb, t] of tracks) {
      let buffered = '(读不到)', lookahead = '—';
      try {
        // 关键：必须用这个 SourceBuffer 自己的 buffered。
        // video.buffered 是所有 active SourceBuffer 的**交集**，音视频分离时
        // 会系统性低估音频前瞻。
        const b = sb.buffered;
        if (b.length) {
          buffered = `${b.start(0).toFixed(1)}–${b.end(b.length - 1).toFixed(1)}s`;
          lookahead = (b.end(b.length - 1) - v.currentTime).toFixed(1) + 's';
        } else buffered = '(空)';
      } catch (e) { /* SourceBuffer 可能已被 remove */ }

      // mime 最可靠（来自 addSourceBuffer 的参数），其次是字节嗅探，最后才是猜
      const mime = mimeOf.get(sb);
      if (mime && !t.kind) {
        if (/^audio\//.test(mime)) t.kind = 'audio';
        else if (/^video\//.test(mime)) t.kind = 'video';
        const cm = /codecs="?([^";]+)/.exec(mime);
        if (cm && !t.codec) t.codec = cm[1];
      }
      let inferred = false;
      if (!t.kind && guessable) {
        t.kind = t.bytes === sizes[0] ? 'audio' : 'video';
        inferred = true; guessed++;
      }

      const row = {
        轨: t.id,
        类型: (t.kind ?? '未识别') + (inferred ? '(推断)' : ''),
        编码: t.codec ?? '—',
        append次数: t.appends,
        抓到字节: (t.bytes / 1024).toFixed(0) + ' KB',
        已缓冲: buffered,
        前瞻: lookahead,
      };
      rows.push(row);
      // 多语言视频会有多条音轨。挑字节数最多的那条报，同时在下面说明还有几条。
      if (t.kind === 'audio' && (!audio || t.bytes > audio.t.bytes)) audio = { t, row };
    }

    log('=========== 探测报告 ===========');
    if (!rows.length) {
      log('❌ 15 秒内一次 appendBuffer 都没抓到。');
      log('   可能原因：视频没在播 / 已经全部缓冲完 / 播放器不用 MSE /');
      log('   MediaSource 在 Worker 里但没走 srcObject。');
      log('   请确认视频正在播放（最好拖到未缓冲的位置）后重试。');
      return;
    }
    console.table(rows);

    // v.mediaKeys 也要查：贴探针的时候 EME 可能早就协商完了，encrypted 事件
    // 是过去式，再也不会触发一次。
    const drm = encrypted || v.mediaKeys != null ||
                [...tracks.values()].some(t => t.drm);
    if (drm) {
      log('❌ 检测到 DRM（encrypted 事件或 pssh box）。');
      log('   EME 下 appendBuffer 拿到的是密文，解密在 CDM 内部完成，JS 永远看不到');
      log('   明文样本。**这个内容结构性无解**——抓到多少字节都没用。');
      log('   注意：同一个站点上非 DRM 的内容仍然可能是好的，换个视频再测一次。');
    }

    if (audio && !drm) {
      log(`✅ 抓到了独立音轨：${audio.t.bytes} 字节 / ${audio.t.appends} 次 append，`
          + `编码 ${audio.t.codec ?? '未识别'}`);
      if (audio.row.前瞻 !== '—') {
        log(`   音轨前瞻 ${audio.row.前瞻}——预扫描要的就是这个。10 秒以上就完全够用`
            + `（4.7x 实时意味着扫 30 秒缓冲只要 6 秒）。`);
      } else {
        log('   读不到该音轨的 buffered 区间（SourceBuffer 可能已被 remove）。');
      }
      const nAudio = rows.filter(r => r.类型 === 'audio').length;
      if (nAudio > 1) {
        log(`   注意：一共 ${nAudio} 条音轨（多半是多语言），上面报的是字节数最多的那条。`
            + `真做的时候每条都要扫，或者跟着播放器当前选中的那条走。`);
      }
      log('   结论：**方案在这个站点成立。**');
    } else if (audio && drm) {
      log(`   （音轨确实抓到了 ${audio.t.bytes} 字节，但都是密文，用不了。）`);
    } else if (guessed) {
      log('⚠️ 没能从字节里嗅出轨道类型，上面的「(推断)」是按字节量猜的。');
      log('   原因是时机：init segment（带 moov/hdlr/stsd 的那段）在你贴探针之前');
      log('   就已经 append 完了，后续的 media segment 只有 moof+mdat，没有类型信息。');
      log('   想拿准确类型：刷新页面后**立刻**贴探针，或者贴完再切一次清晰度');
      log('   （会重建 SourceBuffer，探针 hook 得到 addSourceBuffer 的 mime）。');
      log('   不过对「方案成不成立」这个问题，推断已经够了：抓到了独立音轨、');
      log('   前瞻充足，就是成立。');
    } else if (rows.length === 1) {
      log('⚠️ 只有一个 SourceBuffer，且没识别出音轨类型。');
      log('   可能是音视频混流（muxed）——那样也能做，但解封装要多一步分离音轨。');
      log('   把上面这张表发回去。');
    } else {
      log('⚠️ 抓到数据了，但没识别出哪条是音轨。把上面这张表发回去。');
    }

    log('探针已卸载，appendBuffer 已还原。');
    log('================================');

    // 方便整段复制回传
    window.__probeResult = { where, encrypted, tracks: rows };
    log('完整结果也存在 window.__probeResult 里，可以 copy(__probeResult) 复制。');
  }, WINDOW_SEC * 1000);
})();
