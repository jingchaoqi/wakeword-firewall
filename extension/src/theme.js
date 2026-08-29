/**
 * 外观设置
 * ========
 * 悬浮提示条和设置面板共用一套：背景色 + 整体透明度。
 *
 * 为什么没有「文字色」这一项：只给背景色而不管前景，用户选个浅色背景就会
 * 让原本的浅色文字彻底看不见。所以文字色按背景亮度自动推——用户少调一个旋钮，
 * 也不可能调出读不了的配色。
 *
 * 同时给内容脚本和扩展页用，所以不依赖任何 chrome API。
 */
(function (root) {
  'use strict';

  const DEFAULTS = { uiBg: '#16181C', uiOpacity: 0.95 };

  // 再透也得看得见。低于这个值提示条等于没有，反而像是功能坏了。
  const MIN_OPACITY = 0.3;

  function clampOpacity(v) {
    const n = Number(v);
    if (!isFinite(n)) return DEFAULTS.uiOpacity;
    return Math.min(1, Math.max(MIN_OPACITY, n));
  }

  function normHex(v) {
    const s = String(v || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : DEFAULTS.uiBg.toLowerCase();
  }

  function rgb(hex) {
    const h = normHex(hex);
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  /** 相对亮度，WCAG 的算法 */
  function luminance(hex) {
    const [r, g, b] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 按背景亮度选一套前景色，保证读得出来。
   * 色值一律小写——normHex 会把用户选的背景色转小写，这里要是写大写字面量，
   * 同一个模块就吐出两种大小写，比较时很容易踩空。
   */
  function palette(bgHex) {
    const bg = normHex(bgHex);
    const dark = luminance(bg) < 0.35;      // 阈值偏向深色：深底浅字更常见
    return {
      bg,
      fg:     dark ? '#e9e7e2' : '#1a1c20',
      dim:    dark ? '#8e9199' : '#5a5e66',
      line:   dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.16)',
      // 强调色也要跟着换，青色在浅底上几乎看不清
      accent: dark ? '#5cbdb5' : '#0f6b65',
      warn:   dark ? '#e28762' : '#b4491f',
      btnBg:  dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)',
      btnBgHover: dark ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.14)',
      isDark: dark,
    };
  }

  /** 把一套变量写到某个元素上（提示条用元素本身，面板用 :root） */
  function applyTo(el, cfg) {
    if (!el) return;
    const p = palette(cfg && cfg.uiBg);
    const op = clampOpacity(cfg && cfg.uiOpacity);
    const s = el.style;
    s.setProperty('--ww-bg', p.bg);
    s.setProperty('--ww-fg', p.fg);
    s.setProperty('--ww-dim', p.dim);
    s.setProperty('--ww-line', p.line);
    s.setProperty('--ww-accent', p.accent);
    s.setProperty('--ww-warn', p.warn);
    s.setProperty('--ww-btn', p.btnBg);
    s.setProperty('--ww-btn-hover', p.btnBgHover);
    s.setProperty('--ww-op', String(op));
    return p;
  }

  const api = { DEFAULTS, MIN_OPACITY, clampOpacity, normHex, luminance, palette, applyTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWTheme = api;
})(typeof self !== 'undefined' ? self : this);
