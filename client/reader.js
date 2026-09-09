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

// Font sizes for the S/M/L toggle in the Footer. Line height is generous
// (1.45) since the whole point of reader mode is easy reading, not density.
export const READER_SIZES = {
  s: { fontSize: 13, lineHeight: 1.45, label: 'S' },
  m: { fontSize: 16, lineHeight: 1.45, label: 'M' },
  l: { fontSize: 20, lineHeight: 1.45, label: 'L' },
};

// Placeholder — replaced by the real extraction/render pipeline in a later
// step. Establishes the prop contract the rest of ConsolePane's reader wiring
// is built against: `term` (live xterm Terminal instance, may be null until
// termReady), `size` (one of 's'|'m'|'l'), `theme` (DARK_TERM_THEME or
// LIGHT_TERM_THEME), `lightMode`.
export function ReaderView({ term, size, theme, lightMode }) {
  const cfg = READER_SIZES[size] || READER_SIZES.m;
  return h('div', {
    style: {
      position: 'absolute', inset: 0,
      background: theme.background,
      color: theme.foreground,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      fontSize: cfg.fontSize + 'px',
      lineHeight: String(cfg.lineHeight),
      padding: '12px 16px',
      overflowY: 'auto',
      overflowX: 'auto',
      whiteSpace: 'pre',
    },
  }, term ? '' : 'connecting…');
}
