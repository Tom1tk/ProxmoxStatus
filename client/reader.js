// ─── Reader mode ────────────────────────────────────────────────────────────
// Styled re-projection of a live xterm.js buffer as a large, colour-preserving,
// scrollable document — the terminal-pane equivalent of a "reader view". See
// the reader-mode plan for the full design rationale.
//
// This module receives its palette/theme as props rather than importing
// panel.js's mutable module-level `C`, so it stays a plain function of its
// inputs. It imports from the exact same esm.sh specifier panel.js uses so
// the two share one Preact module instance (h/Component identity matters for
// JSX-less vnode diffing).
'use strict';

import { h, Component } from 'https://esm.sh/preact@10';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10/hooks';

// Font sizes for the S/M/L toggle in the Footer. Line height is generous
// (1.45) since the whole point of reader mode is easy reading, not density.
export const READER_SIZES = {
  s: { fontSize: 13, lineHeight: 1.45, label: 'S' },
  m: { fontSize: 16, lineHeight: 1.45, label: 'M' },
  l: { fontSize: 20, lineHeight: 1.45, label: 'L' },
};

const INITIAL_MAX_LINES = 400;
const MAX_LINES_STEP    = 400;
const MAX_LINES_CAP     = 2000;
const RAF_MIN_INTERVAL_MS = 100;

// ─── Colour maths ───────────────────────────────────────────────────────────

const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function clamp8(n) { return Math.max(0, Math.min(255, n | 0)); }

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp8(v).toString(16).padStart(2, '0')).join('');
}

function packedRgbToHex(n) {
  return rgbToHex((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function paletteToHex(index, theme) {
  if (index < 16) return theme[ANSI_NAMES[index]] || theme.foreground;
  if (index < 232) {
    const i = index - 16;
    const r = CUBE_LEVELS[Math.floor(i / 36) % 6];
    const g = CUBE_LEVELS[Math.floor(i / 6) % 6];
    const b = CUBE_LEVELS[i % 6];
    return rgbToHex(r, g, b);
  }
  const v = 8 + (index - 232) * 10;
  return rgbToHex(v, v, v);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(hexA, hexB) {
  const a = relLuminance(hexA), b = relLuminance(hexB);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgbHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Push a colour's HSL lightness toward the legible end (dark bg → lighter,
// light bg → darker) until it clears a ~3.5:1 contrast ratio against `bgHex`,
// preserving hue/saturation. Bails out after 20 steps (5% each) rather than
// looping to a degenerate pure black/white.
function clampForContrast(hex, bgHex, lightMode) {
  if (contrastRatio(hex, bgHex) >= 3.5) return hex;
  const { r, g, b } = hexToRgb(hex);
  let { h, s, l } = rgbToHsl(r, g, b);
  let out = hex;
  for (let i = 0; i < 20; i++) {
    l = lightMode ? Math.max(0, l - 0.05) : Math.min(1, l + 0.05);
    out = hslToRgbHex(h, s, l);
    if (contrastRatio(out, bgHex) >= 3.5) break;
  }
  return out;
}

// Memoised per (theme, source spec, effective bg) — the clamp/hex maths above
// is pure but not free, and the same runs recur constantly across re-renders.
const _colorCache = new Map();

function resolveSpecHex(spec, role, theme) {
  if (spec.mode === 'default') return role === 'fg' ? theme.foreground : theme.background;
  if (spec.mode === 'rgb')     return packedRgbToHex(spec.value);
  return paletteToHex(spec.value, theme);
}

// Only cube/greyscale/truecolor values get contrast-clamped — indices 0-15
// are already theme-remapped (LIGHT_TERM_THEME hand-tunes white/brightWhite
// etc.), and clamping those would second-guess a palette tuned on purpose.
function shouldClamp(spec) {
  if (spec.mode === 'rgb') return true;
  if (spec.mode === 'palette') return spec.value >= 16;
  return false;
}

// Resolves one style-run's fg/bg specs (as captured at extraction time) into
// concrete CSS values. Order matters: resolve defaults to theme colours
// FIRST, then swap on isInverse() — swapping the abstract specs instead would
// let inverse-video (\e[7m) briefly resolve to "default bg" post-swap and
// vanish. Also see the plan's §3 for why.
export function resolveCellColor(seg, theme, lightMode) {
  let fg = { hex: resolveSpecHex(seg.fgSpec, 'fg', theme), spec: seg.fgSpec };
  let bg = { hex: resolveSpecHex(seg.bgSpec, 'bg', theme), spec: seg.bgSpec };
  if (seg.inverse) { const t = fg; fg = bg; bg = t; }

  const bgTransparent = bg.hex.toLowerCase() === theme.background.toLowerCase();

  let color;
  if (seg.invisible) {
    color = 'transparent';
  } else if (shouldClamp(fg.spec)) {
    const key = `${lightMode ? 1 : 0}|${theme.background}|${fg.hex}|${bg.hex}`;
    let cached = _colorCache.get(key);
    if (cached === undefined) {
      cached = clampForContrast(fg.hex, bg.hex, lightMode);
      _colorCache.set(key, cached);
    }
    color = cached;
  } else {
    color = fg.hex;
  }

  return {
    color,
    background: bgTransparent ? 'transparent' : bg.hex,
    fontWeight: seg.bold ? '700' : '400',
    fontStyle: seg.italic ? 'italic' : 'normal',
    opacity: seg.dim ? 0.7 : 1,
    textDecoration:
      [seg.underline ? 'underline' : '', seg.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
  };
}

// ─── Extraction ─────────────────────────────────────────────────────────────

function fgSpecFromCell(cell) {
  if (cell.isFgRGB())     return { mode: 'rgb', value: cell.getFgColor() };
  if (cell.isFgPalette()) return { mode: 'palette', value: cell.getFgColor() };
  return { mode: 'default' };
}
function bgSpecFromCell(cell) {
  if (cell.isBgRGB())     return { mode: 'rgb', value: cell.getBgColor() };
  if (cell.isBgPalette()) return { mode: 'palette', value: cell.getBgColor() };
  return { mode: 'default' };
}

// Cheap grouping key so adjacent cells with identical style collapse into one
// span instead of one-per-character. Must track exactly the attributes
// styleFromCell() below reads, or runs will be split/merged incorrectly.
function styleKey(cell) {
  const fgMode = cell.isFgRGB() ? 2 : cell.isFgPalette() ? 1 : 0;
  const bgMode = cell.isBgRGB() ? 2 : cell.isBgPalette() ? 1 : 0;
  const fg = fgMode ? cell.getFgColor() : 0;
  const bg = bgMode ? cell.getBgColor() : 0;
  const flags =
    (cell.isBold() ? 1 : 0) | (cell.isItalic() ? 2 : 0) | (cell.isDim() ? 4 : 0) |
    (cell.isUnderline() ? 8 : 0) | (cell.isStrikethrough() ? 16 : 0) |
    (cell.isInverse() ? 32 : 0) | (cell.isInvisible() ? 64 : 0);
  return `${fgMode}:${fg}:${bgMode}:${bg}:${flags}`;
}

// Snapshots a cell's style attributes into a plain object at read time — the
// caller reuses one mutable IBufferCell across the whole extraction loop, so
// nothing here may hold a reference to `cell` itself.
function styleFromCell(cell, key) {
  return {
    fgSpec: fgSpecFromCell(cell),
    bgSpec: bgSpecFromCell(cell),
    bold: !!cell.isBold(),
    italic: !!cell.isItalic(),
    dim: !!cell.isDim(),
    underline: !!cell.isUnderline(),
    strike: !!cell.isStrikethrough(),
    inverse: !!cell.isInverse(),
    invisible: !!cell.isInvisible(),
    key,
  };
}

function isBlankSegs(segs) {
  return segs.every(s => s.text.trim() === '');
}

// Coalesces adjacent same-style segments — needed after joining two rows
// together, since the last run of one row and the first run of the next may
// share a style but were grouped separately per-row.
function coalesce(segs) {
  const out = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.key === seg.key) prev.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}

// Walks term.buffer.active over the last `maxLines` rows and produces styled
// logical lines: { key, sig, segs }. No cache — see the plan's §2 for why
// (index-keyed caching goes stale under Claude Code's no-flicker in-place
// rewrites, scrollback trim, and reader-triggered resizes alike).
export function extractReaderLines(term, maxLines) {
  const buf = term.buffer.active;
  const isAlt = buf.type === 'alternate';
  const cols = term.cols;
  const total = buf.length;
  const start = Math.max(0, total - maxLines);
  const cell = buf.getNullCell();

  const rows = [];
  for (let y = start; y < total; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const segs = [];
    const lineLen = Math.min(line.length, cols);
    for (let x = 0; x < lineLen; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
      const ch = cell.getChars() || ' ';
      const key = styleKey(cell);
      const last = segs[segs.length - 1];
      if (last && last.key === key) {
        last.text += ch;
      } else {
        const style = styleFromCell(cell, key);
        style.text = ch;
        segs.push(style);
      }
    }
    rows.push({ isWrapped: !!line.isWrapped, segs });
  }

  const logical = [];
  if (isAlt) {
    for (const r of rows) logical.push(coalesce(r.segs));
  } else {
    let acc = null;
    for (const r of rows) {
      if (acc && r.isWrapped) acc.push(...r.segs);
      else {
        if (acc) logical.push(coalesce(acc));
        acc = r.segs.slice();
      }
    }
    if (acc) logical.push(coalesce(acc));
    while (logical.length && isBlankSegs(logical[logical.length - 1])) logical.pop();
  }

  return logical.map((segs, i) => ({
    key: i,
    sig: segs.map(s => s.key + ' ' + s.text).join(''),
    segs,
  }));
}

// ─── Rendering ──────────────────────────────────────────────────────────────

// One rendered line. shouldComponentUpdate on the content signature is what
// makes no-flicker in-place rewrites (Claude Code) cheap: most lines' text
// and style are unchanged frame to frame, only a few actually differ.
class ReaderLine extends Component {
  shouldComponentUpdate(next) {
    return next.sig !== this.props.sig || next.theme !== this.props.theme || next.lightMode !== this.props.lightMode;
  }
  render(props) {
    const { segs, theme, lightMode } = props;
    if (!segs.length) return h('div', { style: { whiteSpace: 'pre' } }, ' ');
    return h('div', { style: { whiteSpace: 'pre' } },
      segs.map((seg, i) => h('span', { key: i, style: resolveCellColor(seg, theme, lightMode) }, seg.text))
    );
  }
}

// Font family constant, shared between the reader's own text and the hidden
// measuring span geometry uses — must match exactly or measured char width
// won't correspond to what's actually rendered.
const READER_FONT_FAMILY = "'JetBrains Mono', 'Courier New', monospace";

// Live, colour-preserving re-projection of `term`'s buffer. Props:
// `term` (live xterm Terminal instance, null until termReady), `size`
// ('s'|'m'|'l'), `theme` (DARK_TERM_THEME or LIGHT_TERM_THEME), `lightMode`,
// `onGeometry(cols, rows)` (PTY auto-fit target, called whenever the
// available area or font size changes width-wise — see the geometry effect
// below), `onTap()` (fires on a tap/click that wasn't a scroll drag, so the
// caller can focus the underlying terminal's textarea for input).
export function ReaderView({ term, size, theme, lightMode, onGeometry, onTap }) {
  const scrollRef   = useRef(null);
  const pinnedRef   = useRef(true); // follow the tail unless the user scrolled up
  const lastRunRef  = useRef(0);
  const rafRef      = useRef(null);
  const timerRef    = useRef(null);
  const maxLinesRef = useRef(INITIAL_MAX_LINES);
  const [lines, setLines]       = useState([]);
  const [maxLines, setMaxLines] = useState(INITIAL_MAX_LINES);
  maxLinesRef.current = maxLines;

  // Reads maxLinesRef rather than closing over `maxLines` so growing the
  // window (see onScroll below) doesn't change this callback's identity —
  // that would otherwise tear down and re-subscribe the live listeners below
  // on every growth step.
  const reExtract = useCallback(() => {
    if (!term) return;
    setLines(extractReaderLines(term, maxLinesRef.current));
  }, [term]);

  // Subscribe to live buffer changes. Both views stay mounted in panel.js and
  // ConsolePane only renders ReaderView when readerMode is true (itself gated
  // on view === 'panes' at the PanesView call site) — so unmounting here,
  // which the effect cleanup does automatically on any of those flipping,
  // is exactly the "dispose when not in panes view" the plan calls for.
  useEffect(() => {
    if (!term) { setLines([]); return undefined; }
    reExtract();

    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const now = performance.now();
        const elapsed = now - lastRunRef.current;
        if (elapsed < RAF_MIN_INTERVAL_MS) {
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            lastRunRef.current = performance.now();
            reExtract();
          }, RAF_MIN_INTERVAL_MS - elapsed);
        } else {
          lastRunRef.current = now;
          reExtract();
        }
      });
    };

    const disposables = [];
    try { disposables.push(term.onWriteParsed(schedule)); } catch {}
    try { disposables.push(term.onResize(schedule)); } catch {}
    try { disposables.push(term.buffer.onBufferChange(schedule)); } catch {}

    return () => {
      disposables.forEach(d => { try { d.dispose(); } catch {} });
      // Null out, don't just cancel — these refs persist across effect runs,
      // and a stale non-null id would make every future schedule() bail via
      // its `if (rafRef.current) return` guard, freezing the reader for good.
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [term, reExtract]);

  // Pin to bottom after each update unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onScroll(e) {
    const el = e.currentTarget;
    pinnedRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) <= 40;
    // Gated on actual remaining history, not just scroll position — on a
    // short buffer (the common case right after activation) scrollTop < 200
    // is true on nearly every scroll event, including the one the pin-to-
    // bottom effect itself generates, which would otherwise ratchet maxLines
    // straight to the cap and thrash the live-subscription effect above.
    if (el.scrollTop < 200 && maxLines < MAX_LINES_CAP && term && term.buffer.active.length > maxLines) {
      setMaxLines(m => Math.min(MAX_LINES_CAP, m + MAX_LINES_STEP));
    }
  }

  // ─── PTY auto-fit ─────────────────────────────────────────────────────────
  // A persistent off-screen span, sized to the current reader font, used to
  // measure real character advance rather than assuming a fixed cell width —
  // nerd-font ligatures and fallback fonts can differ from JetBrains Mono's
  // own metrics.
  const measureSpanRef = useRef(null);
  useEffect(() => {
    const span = document.createElement('span');
    span.style.cssText =
      `position:fixed; left:-99999px; top:0; visibility:hidden; white-space:pre; font-family:${READER_FONT_FAMILY};`;
    span.textContent = 'M'.repeat(100);
    document.body.appendChild(span);
    measureSpanRef.current = span;
    return () => { span.remove(); measureSpanRef.current = null; };
  }, []);

  const cfg = READER_SIZES[size] || READER_SIZES.m;

  // Read through a ref rather than closed over directly: an inline lambda
  // prop (which is what ConsolePane's onGeometry/onTap were before being
  // stabilized there) would otherwise change identity on every parent
  // re-render, cascading into recomputeGeometry -> the ResizeObserver effect
  // below -> a forced re-measure/resize on every unrelated render.
  const onGeometryRef = useRef(onGeometry);
  onGeometryRef.current = onGeometry;

  const recomputeGeometry = useCallback(async () => {
    const el = scrollRef.current;
    const span = measureSpanRef.current;
    if (!el || !span || !onGeometryRef.current) return;
    if (el.clientWidth === 0 || el.clientHeight === 0) return; // hidden/collapsed pane
    // injectTermFont() loads the Google Fonts link asynchronously; measuring
    // before it lands gives fallback-font metrics and pushes bogus geometry
    // to a live PTY on the first activation after a cold page load.
    try { await document.fonts.load(`${cfg.fontSize}px 'JetBrains Mono'`); } catch {}
    if (!measureSpanRef.current) return; // unmounted while awaiting the font
    // Re-check after the await: the pane may have been hidden/torn down
    // while the font load was in flight, which would otherwise measure zero
    // and push a bogus small geometry (e.g. 20x10) to a live PTY.
    if (el.clientWidth === 0 || el.clientHeight === 0) return;
    span.style.fontSize = cfg.fontSize + 'px';
    const charW = span.getBoundingClientRect().width / 100;
    if (!charW) return;
    const style = getComputedStyle(el);
    const availW = el.clientWidth  - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight)  || 0);
    const availH = el.clientHeight - (parseFloat(style.paddingTop)  || 0) - (parseFloat(style.paddingBottom) || 0);
    const cols = Math.max(20, Math.floor(availW / charW));
    const rows = Math.max(10, Math.min(60, Math.floor(availH / (cfg.fontSize * cfg.lineHeight))));
    onGeometryRef.current(cols, rows);
  }, [cfg.fontSize, cfg.lineHeight]);

  // Reader width drives the PTY's column count so the remote app wraps its
  // own output to fit (see the plan's "key design consequence"). Deliberately
  // width-gated, not a plain ResizeObserver callback: height alone changes
  // constantly on mobile as the URL bar and soft keyboard show/hide, and
  // resizing the PTY on every one of those would reflow the running app each
  // time the keyboard opens. A live width change (rotation, pane re-tiling,
  // S/M/L font size) still recomputes both cols and rows together, since
  // term.resize() needs both anyway.
  const lastWidthRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !term) return;
    lastWidthRef.current = null; // force one recompute on (re)activation
    recomputeGeometry();
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0].contentRect.width);
      if (w === lastWidthRef.current) return;
      lastWidthRef.current = w;
      recomputeGeometry();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [term, recomputeGeometry]);

  // ─── Tap to type ────────────────────────────────────────────────────────
  // Focusing on pointerdown would fire at the start of every scroll drag —
  // on iOS that cancels the gesture and opens the soft keyboard mid-scroll.
  // Only treat it as a tap if the pointer barely moved before lifting.
  const pointerStartRef = useRef(null);
  function onPointerDown(e) { pointerStartRef.current = { x: e.clientX, y: e.clientY }; }
  function onPointerUp(e) {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || !onTap) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) onTap();
  }

  return h('div', {
    ref: scrollRef,
    onScroll,
    onPointerDown,
    onPointerUp,
    style: {
      position: 'absolute', inset: 0,
      background: theme.background,
      color: theme.foreground,
      fontFamily: READER_FONT_FAMILY,
      fontSize: cfg.fontSize + 'px',
      lineHeight: String(cfg.lineHeight),
      padding: '12px 16px',
      overflowY: 'auto',
      overflowX: 'auto',
      whiteSpace: 'pre',
    },
  }, term
    ? lines.map(line => h(ReaderLine, { key: line.key, sig: line.sig, segs: line.segs, theme, lightMode }))
    : h('div', { style: { opacity: 0.6 } }, 'connecting…')
  );
}
