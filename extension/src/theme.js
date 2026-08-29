/**
 * 外观
 * ====
 * 两项：底色（三档）+ 强调色（随便挑）。悬浮提示条和设置面板共用一套。
 *
 * 为什么是三档而不是连续调节：之前做过「透明度百分比」，中间那段会落在
 * 中性灰上——那是对比度最差的区域，浅色字深色字都够不到 WCAG AA。
 * 与其让用户自己踩进去，不如只给三个都调好了的档位。
 *
 * 每档的文字/次要文字/描边都是配好的，不是从底色现算——现算能保证对比度，
 * 但保证不了好看（暖米白配纯黑就很硬）。强调色是用户挑的，那个才需要现算：
 * 挑到跟底色撞的颜色时自动拉开，见 ensureContrast。
 *
 * 同时给内容脚本和扩展页用，所以不依赖任何 chrome API。
 */
(function (root) {
  'use strict';

  const THEMES = {
    // 传统色名。月白是泛青的白，烟霭是雾，玄墨是墨——由明到暗。
    cream: {
      key: 'cream', name: '月白', hint: '米白',
      bg: '#f5f1e8', fg: '#2a261e', dim: '#6e675a',
      line: 'rgba(0,0,0,.14)', btn: 'rgba(0,0,0,.06)', btnHover: 'rgba(0,0,0,.11)',
      warn: '#a8431a',
    },
    mist: {
      key: 'mist', name: '烟霭', hint: '浅灰',
      bg: '#d9dce0', fg: '#1e2126', dim: '#5c6169',
      line: 'rgba(0,0,0,.15)', btn: 'rgba(0,0,0,.06)', btnHover: 'rgba(0,0,0,.12)',
      warn: '#a0421d',
    },
    ink: {
      key: 'ink', name: '玄墨', hint: '深灰',
      bg: '#16181c', fg: '#e9e7e2', dim: '#8e9199',
      line: 'rgba(255,255,255,.14)', btn: 'rgba(255,255,255,.10)',
      btnHover: 'rgba(255,255,255,.18)',
      warn: '#e28762',
    },
  };

  const ORDER = ['cream', 'mist', 'ink'];      // 滑杆从明到暗
  const DEFAULTS = { uiTheme: 'cream', uiAccent: '#5cbdb5' };

  function normTheme(v) {
    return THEMES[v] ? v : DEFAULTS.uiTheme;
  }

  function normHex(v, fallback) {
    const s = String(v || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase()
                                       : (fallback || DEFAULTS.uiAccent).toLowerCase();
  }

  function rgb(hex) {
    const h = normHex(hex, '#000000');
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  const toHex = (arr) =>
    '#' + arr.map((v) => Math.round(Math.min(255, Math.max(0, v)))
      .toString(16).padStart(2, '0')).join('');

  /** 相对亮度，WCAG 的算法 */
  function luminance(h) {
    const [r, g, b] = rgb(h).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG 对比度，1（相同）到 21（黑白） */
  function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  /**
   * 强调色跟底色太近就往亮/暗推，直到读得出来。
   * 用户想挑什么颜色都行，但挑到「玄墨上的深藏青」这种不该让它直接消失。
   */
  function ensureContrast(colorHex, bgHex, target) {
    const want = target || 3.5;
    // 往哪边推不能按亮度阈值猜——看哪个极端能跟底色拉开更大对比就往哪边走
    const toward = contrast('#ffffff', bgHex) >= contrast('#000000', bgHex)
      ? [255, 255, 255] : [0, 0, 0];
    let c = normHex(colorHex);
    for (let i = 0; i < 24 && contrast(c, bgHex) < want; i++) {
      const cur = rgb(c);
      c = toHex([0, 1, 2].map((k) => cur[k] + (toward[k] - cur[k]) * 0.1));
    }
    return c;
  }

  function palette(cfg) {
    const t = THEMES[normTheme(cfg && cfg.uiTheme)];
    return Object.assign({}, t, {
      accent: ensureContrast(normHex(cfg && cfg.uiAccent), t.bg),
      warn: ensureContrast(t.warn, t.bg, 3),
    });
  }

  /** 把变量写到元素上（提示条用元素本身，面板用 :root） */
  function applyTo(el, cfg) {
    if (!el) return null;
    const p = palette(cfg);
    const s = el.style;
    s.setProperty('--ww-panel', p.bg);
    s.setProperty('--ww-fg', p.fg);
    s.setProperty('--ww-dim', p.dim);
    s.setProperty('--ww-line', p.line);
    s.setProperty('--ww-accent', p.accent);
    s.setProperty('--ww-warn', p.warn);
    s.setProperty('--ww-btn', p.btn);
    s.setProperty('--ww-btn-hover', p.btnHover);
    // 提示条压在任意画面上，深色主题才需要给文字加描边；浅底上那道描边很脏
    s.setProperty('--ww-shadow', p.key === 'ink' ? '0 1px 2px rgba(0,0,0,.35)' : 'none');
    return p;
  }

  const api = { THEMES, ORDER, DEFAULTS, normTheme, normHex,
                luminance, contrast, ensureContrast, palette, applyTo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WWTheme = api;
})(typeof self !== 'undefined' ? self : this);
