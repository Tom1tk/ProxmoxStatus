import { h, render } from 'https://esm.sh/preact@10';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10/hooks';
import htm from 'https://esm.sh/htm@3';

const html = htm.bind(h);

// ─── Colour palettes ─────────────────────────────────────────────────────────
const DARK = {
  bg:        '#000000',
  panel:     '#000000',
  border:    '#3a3530',
  borderDim: '#1e1c18',
  white:     '#d8d0c0',
  dim:       '#7a7570',
  dimmer:    '#252220',
  red:       '#cc1a1a',
  amber:     '#c87010',
  amberHi:   '#e8a030',
  green:     '#30a050',
  greenHi:   '#40cc60',
  blueHi:    '#40a0e0',
  purpleHi:  '#a060f0',
  tealHi:    '#30d0b8',
  shadow:    '#000c',
};

const LIGHT = {
  bg:        '#dedad2',
  panel:     '#f0ece4',
  border:    '#9a9080',
  borderDim: '#c8c4b8',
  white:     '#1a1610',
  dim:       '#706858',
  dimmer:    '#b8b4a8',
  red:       '#c01818',
  amber:     '#a85000',
  amberHi:   '#c06800',
  green:     '#186832',
  greenHi:   '#1a8040',
  blueHi:    '#1868b0',
  purpleHi:  '#5828a0',
  tealHi:    '#1880a0',
  shadow:    '#0003',
};

// Mutable reference — updated at the top of App's render from lightMode state,
// so all child components read the correct palette on every re-render.
let C = DARK;

// xterm.js terminal themes — dark stays true-black; light matches the panel palette.
const DARK_TERM_THEME = {
  background:          '#000000',
  foreground:          '#d8d0c0',
  cursor:              '#e8a030',
  cursorAccent:        '#000000',
  selectionBackground: '#e8a03030',
  black:   '#1e1c18', brightBlack:   '#3a3530',
  red:     '#cc1a1a', brightRed:     '#dd3030',
  green:   '#30a050', brightGreen:   '#40cc60',
  yellow:  '#c87010', brightYellow:  '#e8a030',
  blue:    '#40a0e0', brightBlue:    '#60b8f0',
  magenta: '#a060f0', brightMagenta: '#c080ff',
  cyan:    '#30d0b8', brightCyan:    '#40eedd',
  white:   '#d8d0c0', brightWhite:   '#f0e8d8',
};

const LIGHT_TERM_THEME = {
  background:          '#f0ece4',
  foreground:          '#1a1610',
  cursor:              '#c06800',
  cursorAccent:        '#f0ece4',
  selectionBackground: '#c0680030',
  black:   '#1a1610', brightBlack:   '#706858',
  red:     '#c01818', brightRed:     '#dd2020',
  green:   '#186832', brightGreen:   '#1a8040',
  yellow:  '#a85000', brightYellow:  '#c06800',
  blue:    '#1868b0', brightBlue:    '#2080c8',
  magenta: '#5828a0', brightMagenta: '#7040c0',
  cyan:    '#1880a0', brightCyan:    '#20a0c0',
  white:   '#706858', brightWhite:   '#1a1610',
};

// Terminal font — the scanline "Glass TTY VT220" font reads poorly, so both
// themes use JetBrains Mono (lazy-loaded from Google Fonts).
const TERM_FONT      = "'JetBrains Mono', 'Courier New', monospace";
const TERM_FONT_SIZE = 12;
// Mirrors style.css's html/body default — used to opt specific elements back
// out of TERM_FONT where it's applied to a whole section.
const DEFAULT_FONT = "'Glass TTY VT220', 'Courier New', monospace";

let _termFontInjected = false;
function injectTermFont() {
  if (_termFontInjected) return;
  _termFontInjected = true;
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap';
  document.head.appendChild(link);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatUptime(seconds) {
  if (!seconds) return '0d 00:00';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmt(n, dec = 1) {
  if (n == null) return '--';
  return Number(n).toFixed(dec);
}

function bytesToMbps(bytesPerSec) {
  return (bytesPerSec || 0) / 1048576;
}

function pct(val) {
  return Math.round((val || 0) * 100);
}

// Floors to 2 significant figures and renders as GiB (≥1024 MiB) or MiB.
// "Floor" per-spec so the displayed usage never reads higher than actual.
function fmtSize2(bytes) {
  const mb = (bytes || 0) / 1048576;
  const floorSig2 = v => (v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10);
  if (mb >= 1024) return floorSig2(mb / 1024) + 'gb';
  return floorSig2(mb) + 'mb';
}

// Threshold colour bands matching LedBar's default green/amber/red logic.
function barColor(frac) {
  if (frac >= 0.9) return C.red;
  if (frac >= 0.7) return C.amberHi;
  return C.greenHi;
}

function timeSince(ts) {
  if (!ts) return '--';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ─── LedBar ──────────────────────────────────────────────────────────────────
// fluid=true: bar fills container width via SVG viewBox scaling
function LedBar({ value, segments = 20, warn = 0.7, crit = 0.9, width = 80, height = 10, color, fluid = false }) {
  const filled = Math.round((value || 0) * segments);
  // Logical coordinates for viewBox (4px seg + 1px gap)
  const segW = 4, gap = 1, unit = segW + gap;
  const vbW = segments * unit - gap;
  const segs = [];

  for (let i = 0; i < segments; i++) {
    const on = i < filled;
    let fill = C.dimmer;
    if (on) {
      if (color) fill = color;
      else if (i / segments >= crit) fill = C.red;
      else if (i / segments >= warn) fill = C.amberHi;
      else fill = C.greenHi;
    }
    segs.push(h('rect', { key: i, x: i * unit, y: 0, width: segW, height, fill }));
  }

  if (fluid) {
    return html`
      <svg
        width="100%"
        height=${height}
        viewBox="0 0 ${vbW} ${height}"
        preserveAspectRatio="none"
        style="display:block;flex:1;min-width:0"
      >${segs}</svg>
    `;
  }

  const pixW = Math.floor((width - segments + 1) / segments);
  const fixedSegs = segs.map((_, i) => {
    const on = i < filled;
    let fill = C.dimmer;
    if (on) {
      if (color) fill = color;
      else if (i / segments >= crit) fill = C.red;
      else if (i / segments >= warn) fill = C.amberHi;
      else fill = C.greenHi;
    }
    return h('rect', { key: i, x: i * (pixW + 1), y: 0, width: pixW, height, fill });
  });
  return html`
    <svg width=${width} height=${height} style="display:block;flex-shrink:0">${fixedSegs}</svg>
  `;
}

// ─── NetTicker ───────────────────────────────────────────────────────────────
function NetTicker({ mbps, maxMbps, label, compact }) {
  const dotsRef = useRef([]);
  const mbpsRef = useRef(mbps);
  const maxRef  = useRef(maxMbps);

  useEffect(() => { mbpsRef.current = mbps; }, [mbps]);
  useEffect(() => { maxRef.current = maxMbps; }, [maxMbps]);

  useEffect(() => {
    const id = setInterval(() => {
      const prob = Math.min(1, (mbpsRef.current / (maxRef.current || 1000)) * 0.8);
      dotsRef.current.forEach(dot => {
        if (dot) dot.style.opacity = Math.random() < prob ? '1' : '0.12';
      });
    }, 130);
    return () => clearInterval(id);
  }, []);

  const dots = [0, 1, 2, 3, 4, 5].map(i =>
    h('span', {
      key: i,
      ref: el => { dotsRef.current[i] = el; },
      style: {
        display: 'inline-block',
        width: 5, height: 5,
        borderRadius: '50%',
        background: C.greenHi,
        opacity: 0.12,
        margin: '0 1px',
        verticalAlign: 'middle',
      },
    })
  );

  return html`
    <span style="display:inline-flex;align-items:center;gap:${compact ? '2px' : '4px'};font-size:${compact ? '10px' : 'clamp(11px,1.1vw,15px)'};color:${C.dim}">
      <span>${label}</span>
      <span style="display:inline-flex;align-items:center">${compact ? dots.slice(0,4) : dots}</span>
      <span style="color:${C.white};min-width:${compact ? '28px' : '38px'};text-align:right">${fmt(mbps, 2)}<span style="color:${C.dim}">${compact ? 'M' : 'MB/s'}</span></span>
    </span>
  `;
}

// Measured height of the dashboard bar — applied to panes bar to guarantee identical height.
let _dashBarH = 0;

// ─── HeaderBar ───────────────────────────────────────────────────────────────
// Dual-mode: dashboard metrics row OR panes tab strip, toggled by the ⊞ PANES button.
function HeaderBar({ node, lxcs, config, view, setView, paneStates, onTabClick, onTabClose, keyRowOpen, setKeyRowOpen }) {
  const vw     = window.innerWidth;
  const narrow = vw < 480;   // phone portrait
  const tiny   = vw < 360;   // very small phone
  const fs     = narrow ? '11px' : 'clamp(11px,1.15vw,16px)';

  // Ref lives on the dashboard bar; after every dashboard render we record its height
  // so the panes bar can match it exactly.
  const barRef = useRef(null);
  useEffect(() => {
    if (view !== 'panes' && barRef.current) {
      const h = barRef.current.offsetHeight;
      if (h > 0) _dashBarH = h;
    }
  });

  const [prefixFlash, setPrefixFlash] = useState(false);
  function sendTmuxPrefix() {
    if (_activeTerm.send) {
      _activeTerm.send('\x02');  // Ctrl+B
      setPrefixFlash(true);
      setTimeout(() => setPrefixFlash(false), 500);
    }
  }

  // Toggle button — identical styles in both modes; only marginLeft differs per context
  const toggleBtnStyle = {
    flexShrink:    0,
    background:    view === 'panes' ? C.amber + '30' : 'transparent',
    border:        `1px solid ${view === 'panes' ? C.amber : C.borderDim}`,
    color:         view === 'panes' ? C.amberHi : C.dim,
    fontFamily:    'inherit',
    fontSize:      narrow ? '10px' : 'clamp(9px,0.9vw,12px)',
    padding:       narrow ? '3px 5px' : '2px 8px',
    cursor:        'pointer',
    letterSpacing: narrow ? 0 : '0.5px',
    lineHeight:    1,
  };
  const mkToggle = (ml) => h('button', {
    onClick: () => setView && setView(view === 'panes' ? 'dashboard' : 'panes'),
    title:   view === 'panes' ? 'Switch to dashboard' : 'Open console panes',
    style:   { ...toggleBtnStyle, marginLeft: ml },
  }, view === 'panes' ? '◼' : '⊞');

  // Shared bar padding — dashboard uses both axes; panes bar uses only horizontal
  // (vertical is 0 so tabs can fill the full measured height edge-to-edge)
  const barPadH = narrow ? 'clamp(4px,0.6vw,10px)' : 'clamp(6px,0.8vw,12px)';
  const barPad  = narrow
    ? `6px ${barPadH}`
    : `clamp(8px,1vh,16px) ${barPadH}`;

  // ─── Panes mode: scrollable tab strip ────────────────────────────────────
  if (view === 'panes') {
    // ROOT shell entry is pinned at position 0; real LXCs sorted by vmid after it
    const sorted = [NODE_ENTRY, ...[...lxcs].sort((a, b) => Number(a.vmid) - Number(b.vmid))];
    const tabMinW = narrow ? 42 : 50;
    // Panes bar: exact same height as dashboard (measured), zero vertical padding
    // so tabs run edge-to-edge. PANES button stretches to full height like a sidebar.
    // Only horizontal padding matches the dashboard bar's left/right inset.
    return h('div', {
      style: {
        display:       'flex',
        alignItems:    'center',
        height:        _dashBarH > 0 ? `${_dashBarH}px` : undefined,
        paddingLeft:   barPadH,
        paddingRight:  barPadH,
        paddingTop:    0,
        paddingBottom: 0,
        boxSizing:     'border-box',
        borderBottom:  `1px solid ${C.border}`,
        background:    C.panel,
        fontSize:      fs,
        flexWrap:      'nowrap',
        flexShrink:    0,
      },
    },
      // PANES button — on mobile toggles the on-screen key row (which now holds the
      // tmux-prefix button); on desktop it still sends the tmux prefix directly,
      // since a real keyboard already has Ctrl/arrows/Esc.
      h('button', {
        onClick: narrow ? () => setKeyRowOpen(o => !o) : sendTmuxPrefix,
        title:   narrow ? 'Show/hide terminal key row' : 'Send tmux prefix (Ctrl+B)',
        style: {
          alignSelf:    'stretch',
          display:      'flex',
          alignItems:   'center',
          color:        (narrow ? keyRowOpen : prefixFlash) ? C.white : C.amberHi,
          background:   (narrow ? keyRowOpen : prefixFlash) ? C.amber + '55' : 'transparent',
          fontWeight:   'bold',
          flexShrink:   0,
          letterSpacing: narrow ? 0 : '1px',
          fontSize:     fs,                          // matches dashboard title font
          paddingRight: narrow ? '6px' : '8px',
          paddingLeft:  0,
          borderTop:    'none',
          borderLeft:   'none',
          borderBottom: 'none',
          borderRight:  `1px solid ${C.borderDim}`,
          marginRight:  narrow ? '4px' : '6px',
          cursor:       'pointer',
          fontFamily:   'inherit',
          transition:   'color 0.15s, background 0.15s',
        },
      }, 'PANES'),

      // Scrollable tab row — height:100% fills the full bar edge-to-edge.
      // Touch-draggable, scrollbar hidden.
      h('div', {
        className: 'panes-tabs',
        style: {
          flex:              1,
          height:            '100%',
          display:           'flex',
          overflowX:         'auto',
          overflowY:         'hidden',
          minWidth:          0,
          gap:               '1px',
          scrollbarWidth:    'none',
          WebkitOverflowScrolling: 'touch',
        },
      },
        ...sorted.map(lxc => {
          const state       = (paneStates && paneStates[lxc.vmid]) || 'closed';
          const isRunning   = lxc.status === 'running';
          const connected   = state === 'visible' || state === 'minimized';
          const bg          = state === 'visible'   ? C.amber + '44'
                            : state === 'minimized' ? C.amber + '20'
                            : 'transparent';
          const nameColor   = state === 'visible'   ? C.white : C.dim;
          // ROOT shell: show "000" as id and skip vowel-removal formatting
          const displayId   = lxc._isNode ? '000' : lxc.vmid;
          const displayName = lxc._isNode
            ? 'ROOT'
            : fmtTabName(lxc.display_name || lxc.name || lxc.vmid);

          return h('button', {
            key:     lxc.vmid,
            onClick: () => onTabClick && onTabClick(lxc.vmid),
            style: {
              flex:           `0 0 ${tabMinW}px`,
              minWidth:       `${tabMinW}px`,
              position:       'relative',
              display:        'flex',
              flexDirection:  'column',
              alignItems:     'center',
              justifyContent: 'center',
              background:     bg,
              border:         'none',
              borderRight:    `1px solid ${C.borderDim}`,
              borderBottom:   `3px solid ${isRunning ? C.green : C.dimmer}`,
              padding:        connected ? '0 18px 0 2px' : '0 2px',
              cursor:         'pointer',
              fontFamily:     'inherit',
              overflow:       'hidden',
              color:          nameColor,
              height:         '100%',
              boxSizing:      'border-box',
            },
          },
            h('span', {
              style: {
                fontSize: narrow ? '9px' : 'clamp(9px,0.8vw,11px)',
                color: C.dim, lineHeight: 1, marginBottom: '2px', flexShrink: 0,
              },
            }, displayId),
            h('span', {
              style: {
                width: '100%', overflow: 'hidden', textOverflow: 'clip',
                whiteSpace: 'nowrap', textAlign: 'center',
                fontSize: narrow ? '10px' : 'clamp(10px,1vw,13px)',
                lineHeight: 1, color: nameColor,
              },
            }, displayName),
            connected ? h('span', {
              onClick: e => { e.stopPropagation(); onTabClose && onTabClose(lxc.vmid); },
              style: {
                position: 'absolute', top: '2px', right: '4px',
                fontSize: narrow ? '13px' : 'clamp(13px,1.3vw,17px)',
                color: C.dim, cursor: 'pointer', lineHeight: 1, padding: '1px 2px',
              },
            }, '×') : null,
          );
        }),
      ),

      mkToggle(barPadH),  // gap matches bar horizontal inset
    );
  }

  // ─── Dashboard mode: metrics row ─────────────────────────────────────────
  if (!node) {
    return h('div', {
      ref: barRef,
      style: {
        height: '2.4em', borderBottom: `1px solid ${C.borderDim}`,
        display: 'flex', alignItems: 'center', padding: `0 clamp(6px,0.8vw,12px)`,
      },
    }, mkToggle('auto'));
  }

  const cpuPct      = node.cpu || 0;
  const memPct      = node.mem_total ? node.mem_used / node.mem_total : 0;
  const netInMbps   = bytesToMbps(node.net_in);
  const netOutMbps  = bytesToMbps(node.net_out);
  const maxMbps     = config ? config.max_net_mbps : 1000;
  const activeCount = lxcs.filter(l => l.status === 'running').length;
  const barW        = narrow ? (tiny ? 22 : 28) : 55;
  const gap         = narrow ? '3px' : 'clamp(5px,0.7vw,12px)';

  const tempColor = node.cpu_temp == null ? C.dim
    : node.cpu_temp >= 80 ? C.red
    : node.cpu_temp >= 65 ? C.amberHi
    : C.white;

  const sep = narrow ? null : h('span', { style: { color: C.borderDim } }, '│');

  return h('div', {
    ref: barRef,
    style: {
      display:      'flex',
      alignItems:   'center',
      gap,
      padding:      barPad,
      borderBottom: `1px solid ${C.border}`,
      background:   C.panel,
      fontSize:     fs,
      flexWrap:     'nowrap',
      overflow:     'hidden',
      flexShrink:   0,
      boxSizing:    'border-box',
    },
  },
    h('span', { style: { color: C.amberHi, fontWeight: 'bold', flexShrink: 0, letterSpacing: narrow ? 0 : '1px' } },
      config ? config.panel_title : 'HOST'),

    sep,

    h('span', { style: { display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 } },
      h('span', { style: { color: C.dim } }, 'CPU'),
      h(LedBar, { value: cpuPct, width: barW, height: 7, segments: narrow ? 12 : 20 }),
      h('span', { style: { color: C.white, minWidth: narrow ? '22px' : '26px' } }, pct(cpuPct) + '%'),
    ),

    h('span', { style: { display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 } },
      h('span', { style: { color: C.dim } }, 'MEM'),
      h(LedBar, { value: memPct, width: barW, height: 7, color: C.blueHi, segments: narrow ? 12 : 20 }),
      h('span', { style: { color: C.white, minWidth: narrow ? '22px' : '26px' } }, pct(memPct) + '%'),
    ),

    sep,

    // Temp — hidden on very narrow screens to save space
    !narrow && node.cpu_temp != null ? h('span', { style: { flexShrink: 0 } },
      h('span', { style: { color: C.dim } }, 'TEMP '),
      h('span', { style: { color: tempColor } }, Math.round(node.cpu_temp) + '°C'),
    ) : null,
    !narrow && node.cpu_temp != null ? sep : null,

    h(NetTicker, { mbps: netInMbps, maxMbps, label: '↓', compact: narrow }),
    h(NetTicker, { mbps: netOutMbps, maxMbps, label: '↑', compact: narrow }),

    sep,

    // Uptime — hidden on narrow screens
    !narrow ? h('span', { style: { flexShrink: 0, color: C.dim } },
      'UP ', h('span', { style: { color: C.white } }, formatUptime(node.uptime)),
    ) : null,

    h('span', { style: { flexShrink: 0, color: C.dim } },
      h('span', { style: { color: C.greenHi } }, activeCount),
      '/',
      h('span', { style: { color: C.white } }, lxcs.length),
      ' LXC',
    ),

    mkToggle('auto'),
  );
}

// ─── LxcCell ─────────────────────────────────────────────────────────────────
const ACTIONS = [
  { id: 'start',    label: 'START', color: C => C.greenHi },
  { id: 'reboot',   label: 'REBOOT', color: C => C.amberHi },
  { id: 'shutdown', label: 'SHUT',  color: C => C.red },
];

function LxcCell({ lxc, flickerRef, openVmid, setOpenVmid }) {
  const cellRef = useRef(null);
  const vmid    = lxc.vmid;
  const open    = openVmid === vmid;

  const [pending,  setPending]  = useState(null);
  const [feedback, setFeedback] = useState(null);

  // Reset local state when this cell is closed from outside
  useEffect(() => {
    if (!open) { setPending(null); setFeedback(null); }
  }, [open]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!cellRef.current) return;
      cellRef.current.style.opacity = open ? '1' : String(flickerRef.current[vmid] ?? 1);
    }, 80);
    return () => clearInterval(id);
  }, [vmid, open]);

  async function doAction(action) {
    if (pending) return;
    setPending(action);
    setFeedback(null);
    try {
      const res = await fetch(`/api/lxc/${vmid}/${action}`, { method: 'POST' });
      const data = await res.json();
      setFeedback({ ok: data.success, msg: data.success ? action.toUpperCase() + ' SENT' : (data.error || 'FAILED') });
    } catch {
      setFeedback({ ok: false, msg: 'NET ERR' });
    }
    setPending(null);
    setTimeout(() => setOpenVmid(null), 1800);
  }

  function handleCellClick(e) {
    e.stopPropagation();
    // If anything is open, close it — requires a fresh tap to open another
    if (openVmid !== null) { setOpenVmid(null); return; }
    setOpenVmid(vmid);
  }

  function closeCell(e) {
    e.stopPropagation();
    setOpenVmid(null);
  }

  const isRunning   = lxc.status === 'running';
  const ioTotal     = (lxc.disk_read || 0) + (lxc.disk_write || 0);
  const ioActive    = isRunning && ioTotal > 0;
  const lampColor   = !isRunning ? C.dimmer : ioActive ? C.amberHi : C.greenHi;
  const borderColor = !isRunning
    ? (open ? C.border : C.borderDim)
    : ioActive ? C.amber : C.green;
  const glowColor   = !isRunning ? 'none' : ioActive ? `0 0 8px ${C.amber}88` : `0 0 8px ${C.green}88`;

  const btnSize = 'clamp(32px,4.5vw,56px)';

  return html`
    <div style="
      position: relative;
      display: flex;
      flex-direction: column;
      border: 1px solid ${borderColor};
      background: ${C.panel};
      box-shadow: ${glowColor};
      overflow: hidden;
      min-height: 0;
      cursor: pointer;
    " onClick=${handleCellClick}>

      <!-- IO pip (hidden when open) -->
      ${ioActive && !open ? html`
        <div style="
          position:absolute;top:3px;right:3px;
          width:5px;height:5px;border-radius:50%;
          background:${C.amberHi};box-shadow:0 0 4px ${C.amberHi};z-index:2;
        "></div>
      ` : null}

      <!-- Lamp body -->
      <div ref=${cellRef} style="
        flex: 1;
        background: ${lampColor}18;
        border-bottom: 1px solid ${borderColor};
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 0;
        position: relative;
      ">
        <!-- VMID (fades out when open) -->
        <div style="
          width: 60%; height: 60%;
          border-radius: 4px;
          background: ${lampColor}${isRunning ? '30' : '10'};
          border: 1px solid ${lampColor}${isRunning ? '80' : '20'};
          display: flex; align-items: center; justify-content: center;
          transition: opacity 0.15s ease;
          opacity: ${open ? 0 : 1};
          pointer-events: none;
        ">
          <span style="
            font-size: clamp(9px,1.2vw,16px);
            color: ${isRunning ? lampColor : C.dimmer};
            opacity: 0.85;
            user-select: none;
          ">${lxc.vmid}</span>
        </div>

        <!-- Action overlay (always in DOM, transitions in/out) -->
        <div style="
          position: absolute; inset: 0;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          gap: clamp(4px,0.6vh,8px);
          background: ${C.bg}e6;
          backdrop-filter: blur(${open ? 4 : 0}px);
          opacity: ${open ? 1 : 0};
          pointer-events: ${open ? 'auto' : 'none'};
          transition: opacity 0.18s ease, backdrop-filter 0.18s ease;
        " onClick=${open ? closeCell : null}>

          <!-- X close -->
          <div style="
            position:absolute;top:3px;right:5px;
            color:${C.dim};cursor:pointer;
            font-size:clamp(8px,0.9vw,12px);
            line-height:1;user-select:none;
          ">✕</div>

          ${feedback ? html`
            <span style="
              color:${feedback.ok ? C.greenHi : C.red};
              font-size:clamp(8px,0.9vw,12px);
              letter-spacing:1px;
              text-align:center;
            ">${feedback.msg}</span>
          ` : html`
            <div style="display:flex;gap:clamp(5px,0.8vw,12px);align-items:center;justify-content:center">
              ${ACTIONS.map(({ id, label, color }) => {
                const col = color(C);
                const isActive = pending === id;
                return h('button', {
                  key: id,
                  onClick: (e) => { e.stopPropagation(); doAction(id); },
                  disabled: !!pending,
                  style: {
                    width: btnSize,
                    height: btnSize,
                    background: isActive ? col + 'aa' : 'transparent',
                    border: `1px solid ${col}`,
                    color: col,
                    fontFamily: 'inherit',
                    fontSize: 'clamp(6px,0.7vw,9px)',
                    cursor: pending ? 'default' : 'pointer',
                    letterSpacing: '0.5px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: '0',
                    transition: 'background 0.1s, border-color 0.1s, color 0.1s',
                  },
                }, isActive ? '...' : label);
              })}
            </div>
          `}
        </div>
      </div>

      <!-- Name strip -->
      <div style="
        padding: clamp(1px,0.3vh,3px) 0;
        text-align: center;
        font-size: clamp(9px,0.95vw,14px);
        letter-spacing: 0.4px;
        color: ${isRunning ? C.white : C.dim};
        background: ${C.bg};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 0;
      ">
        ${lxc.display_name || lxc.name || lxc.vmid}
      </div>
    </div>
  `;
}

// ─── LxcGrid ─────────────────────────────────────────────────────────────────
function LxcGrid({ lxcs, cols, flickerRef, openVmid, setOpenVmid }) {
  const rows = Math.ceil(lxcs.length / cols);
  return html`
    <div style="flex:1;overflow:hidden;padding:clamp(5px,0.7vh,10px);min-height:0">
      <div style="
        height: 100%;
        display: grid;
        grid-template-columns: repeat(${cols}, 1fr);
        grid-template-rows: repeat(${rows}, 1fr);
        gap: clamp(3px,0.5vw,8px);
      ">
        ${lxcs.map(lxc => h(LxcCell, { key: lxc.vmid, lxc, flickerRef, openVmid, setOpenVmid }))}
      </div>
    </div>
  `;
}

// ─── GpuRow ──────────────────────────────────────────────────────────────────
function GpuRow({ gpu, selected, onSelect }) {
  const hasData = gpu.gpu_util != null;
  const memPct  = (gpu.mem_util || 0) / 100;
  const utilPct = (gpu.gpu_util || 0) / 100;
  const labelW  = 'clamp(28px,3vw,44px)';
  const valW    = 'clamp(32px,4vw,56px)';
  const barH    = 'clamp(6px,0.8vh,11px)';

  return html`
    <div
      onClick=${() => onSelect(gpu.index)}
      style="
      padding: clamp(4px,0.5vh,8px) clamp(6px,0.8vw,12px);
      border-top: 1px solid ${C.borderDim};
      border-left: 3px solid ${selected ? C.blueHi : 'transparent'};
      background: ${selected ? C.blueHi + '14' : 'transparent'};
      font-size: clamp(11px,1.1vw,15px);
      cursor: pointer;
    ">
      <!-- Top row: idx + name OLED + live stats -->
      <div style="display:flex;align-items:center;gap:clamp(6px,0.8vw,12px);margin-bottom:clamp(3px,0.4vh,6px)">
        <span style="color:${C.dim};font-size:clamp(10px,1vw,13px);flex-shrink:0">${gpu.index}</span>
        <div style="
          background:${C.bg};border:1px solid ${C.borderDim};
          padding:2px clamp(4px,0.5vw,8px);
          color:${C.purpleHi};font-size:clamp(10px,1.05vw,14px);
          letter-spacing:1px;flex-shrink:0;white-space:nowrap;
        ">${gpu.display_name}</div>

        ${hasData ? html`
          <span style="color:${C.white}">${gpu.gpu_util}%</span>
          <span style="color:${C.dim}">util ·</span>
          <span style="color:${gpu.temp >= 80 ? C.red : gpu.temp >= 65 ? C.amberHi : C.white}">${gpu.temp}°C</span>
        ` : html`<span style="color:${C.dimmer}">NO DATA</span>`}
      </div>

      <!-- UTIL bar — full width -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:clamp(2px,0.3vh,4px)">
        <span style="width:${labelW};flex-shrink:0;color:${C.dim};font-size:clamp(10px,1vw,13px)">UTIL</span>
        ${h(LedBar, { value: utilPct, fluid: true, height: parseInt(barH) || 8, color: C.tealHi, warn: 0.8, crit: 0.95, segments: 30 })}
        <span style="width:${valW};flex-shrink:0;text-align:right;color:${C.white};font-size:clamp(10px,1vw,13px)">
          ${hasData ? `${gpu.gpu_util}%` : '--'}
        </span>
      </div>

      <!-- MEM bar — full width -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:clamp(2px,0.3vh,4px)">
        <span style="width:${labelW};flex-shrink:0;color:${C.dim};font-size:clamp(10px,1vw,13px)">MEM</span>
        ${h(LedBar, { value: memPct, fluid: true, height: parseInt(barH) || 8, color: C.purpleHi, warn: 0.8, crit: 0.95, segments: 30 })}
        <span style="width:${valW};flex-shrink:0;text-align:right;color:${C.white};font-size:clamp(10px,1vw,13px)">
          ${hasData ? `${gpu.mem_util}%` : '--'}
        </span>
      </div>

      <!-- PWR / FAN — compact text line -->
      <div style="display:flex;align-items:center;gap:6px;font-size:clamp(10px,1vw,13px)">
        <span style="color:${C.dim}">PWR</span>
        <span style="color:${C.tealHi}">${gpu.power_w != null ? fmt(gpu.power_w, 0) : '--'}/${gpu.power_limit != null ? fmt(gpu.power_limit, 0) : '--'}W</span>
        <span style="color:${C.dim};margin-left:auto">FAN</span>
        <span style="color:${C.amberHi}">${gpu.fan_pct != null ? gpu.fan_pct + '%' : '--'}</span>
      </div>
    </div>
  `;
}

// ─── GPU detail helpers ───────────────────────────────────────────────────────

const WINDOWS = [
  { label: '5m',  seconds: 300 },
  { label: '30m', seconds: 1800 },
  { label: '1h',  seconds: 3600 },
  { label: '6h',  seconds: 21600 },
  { label: '12h', seconds: 43200 },
  { label: '1d',  seconds: 86400 },
  { label: '7d',  seconds: 604800 },
];

function tempColorForValue(v) {
  if (v <= 60) return C.greenHi;
  if (v <= 89) return C.amberHi;
  return C.red;
}

function relTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24)  return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// Draw 4-band stacked history chart onto a canvas element
// hoverIdx: data index to draw crosshair at (optional)
function drawGpuHistory(canvas, gpuData, powerLimit, hoverIdx) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  ctx.fillStyle = C.panel;
  ctx.fillRect(0, 0, W, H);

  const ts = gpuData && gpuData.ts;
  if (!ts || ts.length < 2) {
    ctx.fillStyle = C.dim;
    ctx.font      = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('NO HISTORY', W / 2, H / 2);
    return;
  }

  const maxPwr = powerLimit || 375;
  const metrics = [
    { key: 'temp',  label: 'TEMP',  min: 0, max: 100,   color: null,     unit: '°C', dynColor: v => tempColorForValue(v) },
    { key: 'power', label: 'PWR',   min: 0, max: maxPwr, color: C.tealHi, unit: 'W'  },
    { key: 'util',  label: 'GPU%',  min: 0, max: 100,   color: C.greenHi, unit: '%'  },
    { key: 'fan',   label: 'FAN',   min: 0, max: 100,   color: C.amberHi, unit: '%'  },
  ];

  const rowH = Math.floor(H / metrics.length);
  const n    = ts.length;

  metrics.forEach((m, mi) => {
    const y0   = mi * rowH;
    const data = gpuData[m.key];
    if (!data || data.length === 0) return;

    const lastVal = data[data.length - 1] || 0;
    const col     = m.dynColor ? m.dynColor(lastVal) : m.color;
    const range   = Math.max(m.max - m.min, 1);

    // Mid grid line
    ctx.strokeStyle = C.borderDim;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y0 + rowH / 2);
    ctx.lineTo(W, y0 + rowH / 2);
    ctx.stroke();

    // Band separator
    if (mi < metrics.length - 1) {
      ctx.beginPath();
      ctx.moveTo(0, y0 + rowH - 0.5);
      ctx.lineTo(W, y0 + rowH - 0.5);
      ctx.stroke();
    }

    // Area fill
    ctx.fillStyle = col + '18';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const v = Math.max(m.min, Math.min(m.max, data[i] || 0));
      const y = y0 + rowH - 2 - ((v - m.min) / range) * (rowH - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(W, y0 + rowH);
    ctx.lineTo(0, y0 + rowH);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = col;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const v = Math.max(m.min, Math.min(m.max, data[i] || 0));
      const y = y0 + rowH - 2 - ((v - m.min) / range) * (rowH - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Label (left)
    ctx.font      = '9px monospace';
    ctx.fillStyle = C.dim;
    ctx.textAlign = 'left';
    ctx.fillText(m.label, 3, y0 + 10);

    // Value (right)
    ctx.fillStyle = col;
    ctx.textAlign = 'right';
    const valStr  = m.key === 'power'
      ? `${Math.round(lastVal)}/${Math.round(maxPwr)}W`
      : `${Math.round(lastVal)}${m.unit}`;
    ctx.fillText(valStr, W - 3, y0 + 10);
  });

  // X-axis time labels
  const ageMs = ts[ts.length - 1] - ts[0];
  ctx.font      = '7px monospace';
  ctx.fillStyle = C.dimmer;
  ctx.textAlign = 'left';
  ctx.fillText(relTime(ageMs) + ' ago', 3, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText('now', W - 3, H - 2);

  // Crosshair on hover
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
    const hx = n === 1 ? 0 : (hoverIdx / (n - 1)) * W;

    ctx.save();
    ctx.strokeStyle = C.dim;
    ctx.lineWidth   = 0.8;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, 0);
    ctx.lineTo(hx, H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Dot marker per metric band
    metrics.forEach((m, mi) => {
      const y0   = mi * rowH;
      const data = gpuData[m.key];
      if (!data || data.length === 0) return;
      const val = data[Math.min(hoverIdx, data.length - 1)] || 0;
      const col = m.dynColor ? m.dynColor(val) : m.color;
      const v   = Math.max(m.min, Math.min(m.max, val));
      const y   = y0 + rowH - 2 - ((v - m.min) / Math.max(m.max - m.min, 1)) * (rowH - 4);
      ctx.fillStyle   = col;
      ctx.strokeStyle = C.panel;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(hx, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }
}

// ─── GpuDetailPanel ──────────────────────────────────────────────────────────
function GpuDetailPanel({ lightMode, selectedIdx }) {
  const [current,   setCurrent]   = useState({ gpus: [] });
  const [history,   setHistory]   = useState({});
  const [windowSec, setWindowSec] = useState(300);
  const canvasRefs = useRef({});
  const dataRefs   = useRef({});   // idx → { gpuData, powerLimit } for hover handler
  const tooltipRef = useRef({});   // idx → tooltip DOM element

  // Live current data — 2s poll
  useEffect(() => {
    async function pollCurrent() {
      try {
        const r = await fetch('/api/gpu/current');
        setCurrent(await r.json());
      } catch {}
    }
    pollCurrent();
    const id = setInterval(pollCurrent, 2000);
    return () => clearInterval(id);
  }, []);

  // History — fetch on window change, refresh every 10s
  useEffect(() => {
    async function fetchHistory() {
      try {
        const r = await fetch(`/api/gpu/history?window=${windowSec}`);
        setHistory(await r.json());
      } catch {}
    }
    fetchHistory();
    const id = setInterval(fetchHistory, 10000);
    return () => clearInterval(id);
  }, [windowSec]);

  // Draw canvases via rAF whenever data changes
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      Object.entries(history).forEach(([idx, gpuData]) => {
        const canvas = canvasRefs.current[idx];
        if (!canvas) return;
        const gpu        = (current.gpus || []).find(g => String(g.index) === idx);
        const powerLimit = gpu ? gpu.power_limit : 375;
        dataRefs.current[idx] = { gpuData, powerLimit };
        drawGpuHistory(canvas, gpuData, powerLimit);
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [history, current, lightMode]);

  function handleCanvasMouseMove(e, idx) {
    const canvas = canvasRefs.current[idx];
    const data   = dataRefs.current[idx];
    if (!canvas || !data || !data.gpuData || !data.gpuData.ts) return;
    const n = data.gpuData.ts.length;
    if (n < 2) return;

    const rect     = canvas.getBoundingClientRect();
    const cssX     = e.clientX - rect.left;
    const frac     = Math.max(0, Math.min(1, cssX / rect.width));
    const hoverIdx = Math.round(frac * (n - 1));

    drawGpuHistory(canvas, data.gpuData, data.powerLimit, hoverIdx);

    const tooltip = tooltipRef.current[idx];
    if (!tooltip) return;

    const i       = Math.min(hoverIdx, n - 1);
    const timeStr = new Date(data.gpuData.ts[i]).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
    const maxPwr  = data.powerLimit || 375;
    const tmpVal  = Math.round(data.gpuData.temp[i]  || 0);
    const pwrVal  = Math.round(data.gpuData.power[i] || 0);
    const utilVal = Math.round(data.gpuData.util[i]  || 0);
    const fanVal  = Math.round(data.gpuData.fan[i]   || 0);
    const tmpCol  = tempColorForValue(tmpVal);

    tooltip.innerHTML = [
      `<div style="color:${C.dim};margin-bottom:2px">${timeStr}</div>`,
      `<div><span style="color:${C.dim}">TEMP  </span><span style="color:${tmpCol}">${tmpVal}°C</span></div>`,
      `<div><span style="color:${C.dim}">PWR   </span><span style="color:${C.tealHi}">${pwrVal}/${Math.round(maxPwr)}W</span></div>`,
      `<div><span style="color:${C.dim}">GPU%  </span><span style="color:${C.greenHi}">${utilVal}%</span></div>`,
      `<div><span style="color:${C.dim}">FAN   </span><span style="color:${C.amberHi}">${fanVal}%</span></div>`,
    ].join('');

    const ttW    = 115;
    const ttH    = 94;
    const OFFSET = 10;
    let tx = cssX + OFFSET;
    let ty = (e.clientY - rect.top) - ttH / 2;
    if (tx + ttW > rect.width - 4) tx = cssX - ttW - OFFSET;
    tx = Math.max(4, tx);
    ty = Math.max(4, Math.min(ty, rect.height - ttH - 4));

    tooltip.style.left    = `${tx}px`;
    tooltip.style.top     = `${ty}px`;
    tooltip.style.display = 'block';
  }

  function handleCanvasMouseLeave(idx) {
    const tooltip = tooltipRef.current[idx];
    if (tooltip) tooltip.style.display = 'none';
    const canvas = canvasRefs.current[idx];
    const data   = dataRefs.current[idx];
    if (canvas && data && data.gpuData) {
      drawGpuHistory(canvas, data.gpuData, data.powerLimit);
    }
  }

  return html`
    <div style="padding:clamp(4px,0.5vh,8px) clamp(6px,0.8vw,10px);display:flex;flex-direction:column;gap:clamp(3px,0.4vh,5px)">

      <!-- Time window selector -->
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:nowrap">
        <span style="color:${C.dim};font-size:clamp(8px,0.8vw,11px);flex-shrink:0">WINDOW</span>
        ${WINDOWS.map(w => h('button', {
          key: w.seconds,
          onClick: () => setWindowSec(w.seconds),
          style: {
            background:  windowSec === w.seconds ? C.blueHi + '20' : 'transparent',
            border:      `1px solid ${windowSec === w.seconds ? C.blueHi : C.borderDim}`,
            color:       windowSec === w.seconds ? C.blueHi : C.dim,
            fontFamily:  'inherit',
            fontSize:    'clamp(8px,0.8vw,11px)',
            padding:     '1px 5px',
            cursor:      'pointer',
            letterSpacing: '0.3px',
          },
        }, w.label))}
      </div>

      <!-- History graph — selected GPU only -->
      ${Object.entries(history).filter(([idx]) => Number(idx) === selectedIdx).map(([idx, gpuData]) => html`
        <div key=${idx} style="border:1px solid ${C.borderDim};flex-shrink:0">
          <div style="padding:2px 4px;font-size:clamp(8px,0.8vw,11px);color:${C.purpleHi};border-bottom:1px solid ${C.borderDim};background:${C.bg}80;letter-spacing:0.5px">
            ${gpuData.name || 'GPU ' + idx}
          </div>
          <div style="position:relative">
            <canvas
              ref=${el => { if (el) canvasRefs.current[idx] = el; }}
              style="display:block;width:100%;height:140px;cursor:crosshair"
              width="1200"
              height="140"
              onMouseMove=${e => handleCanvasMouseMove(e, idx)}
              onMouseLeave=${() => handleCanvasMouseLeave(idx)}
            />
            <div
              ref=${el => { if (el) tooltipRef.current[idx] = el; }}
              style="
                display:none;position:absolute;pointer-events:none;z-index:10;
                background:${C.panel}ee;border:1px solid ${C.border};
                padding:4px 8px;font-size:clamp(8px,0.75vw,10px);
                line-height:1.7;white-space:nowrap;font-family:inherit;
              "
            />
          </div>
        </div>
      `)}
    </div>
  `;
}

// ─── GpuSection ───────────────────────────────────────────────────────────────
function GpuSection({ gpus, show, lightMode }) {
  const [selectedIdx, setSelectedIdx] = useState(1);
  if (!show) return null;
  return html`
    <div style="flex-shrink:0;display:flex;min-height:0">
      <!-- Left 30%: compact GPU summary rows (click to select graph on the right) -->
      <div style="width:30%;min-width:0;border-right:1px solid ${C.borderDim};flex-shrink:0">
        ${gpus && gpus.length > 0
          ? gpus.map(g => h(GpuRow, { key: g.id || g.index, gpu: g, selected: g.index === selectedIdx, onSelect: setSelectedIdx }))
          : html`<div style="padding:8px;color:${C.dimmer};font-size:clamp(10px,1vw,13px)">NO GPU</div>`
        }
      </div>
      <!-- Right 70%: GPU detail panel — history graph for the selected GPU -->
      <div style="flex:1;min-width:0;overflow-y:auto">
        ${h(GpuDetailPanel, { lightMode, selectedIdx })}
      </div>
    </div>
  `;
}

// ─── VBar ────────────────────────────────────────────────────────────────────
// A single vertical bar that rises from the bottom to `value` (0-1).
// `centerLabel` overlays a single-line label (e.g. "(2)" cores or "2gb").
// `centerFraction` overlays a stacked used/total pair with a divider line —
// used for DISK, whose "used/total" text is too wide for a single thin line.
function VBar({ value, centerLabel, centerFraction }) {
  const v = Math.max(0, Math.min(1, value || 0));
  const labelFs = 'font-size:clamp(7px,0.7vw,10px);color:' + C.white + ';text-shadow:0 0 3px ' + C.bg + ',0 0 3px ' + C.bg + ';white-space:nowrap';
  return html`
    <div style="position:relative;width:100%;flex:1;min-height:0;background:${C.bg};border:1px solid ${C.borderDim};overflow:hidden">
      <div style="
        position:absolute;left:0;right:0;bottom:0;height:${v * 100}%;
        background:${barColor(v)};opacity:0.8;
        transition:height 0.6s ease,background-color 0.6s ease;
      "></div>
      ${centerFraction ? html`
        <div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none">
          <span style="${labelFs}">${centerFraction.used}</span>
          <div style="width:6px;height:1px;background:${C.white};opacity:0.5;margin:2px 0"></div>
          <span style="${labelFs}">${centerFraction.total}</span>
        </div>
      ` : html`
        <span style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);text-align:center;pointer-events:none;${labelFs}">${centerLabel}</span>
      `}
    </div>
  `;
}

// ─── LxcStatGroup ────────────────────────────────────────────────────────────
// One LXC's CPU/RAM/DISK bar trio. Re-snaps its displayed numbers from the live
// `lxc` prop every 10s, on a per-vmid random phase fixed at launch (see
// _lxcStatOffsets) — so bars don't all visually snap in lockstep.
function LxcStatGroup({ lxc }) {
  const liveRef = useRef(lxc);
  liveRef.current = lxc;
  const [snap, setSnap] = useState(lxc);

  // Stagger: first paint shows live data; after this LXC's fixed random phase,
  // re-snap from the ref every 10s. Ref keeps the closure reading fresh data
  // without restarting the timer on every poll-driven re-render.
  useEffect(() => {
    const offset  = _lxcStatOffsets[lxc.vmid] || 0;
    const doSnap  = () => setSnap(liveRef.current);
    let interval;
    const timeout = setTimeout(() => { doSnap(); interval = setInterval(doSnap, 10000); }, offset);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [lxc.vmid]);

  const cpuFrac  = snap.cpu || 0;
  const ramFrac  = snap.mem || 0;
  const diskFrac = snap.maxdisk ? (snap.disk || 0) / snap.maxdisk : 0;

  const pctFs   = 'font-size:clamp(8px,0.85vw,11px);color:' + C.white + ';text-align:center;min-height:1.2em';
  const labelFs = 'font-size:clamp(7px,0.75vw,10px);color:' + C.dim + ';text-align:center;flex:1';

  return html`
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:64px;height:100%;min-height:0;gap:2px">
      <div style="display:flex;gap:3px;width:100%;justify-content:center;flex:1;min-height:0">
        <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">
          <span style="${pctFs}">${pct(cpuFrac)}%</span>
          ${h(VBar, { value: cpuFrac, centerLabel: `(${snap.maxcpu || 0})` })}
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">
          <span style="${pctFs}">${pct(ramFrac)}%</span>
          ${h(VBar, { value: ramFrac, centerFraction: { used: fmtSize2(snap.memused), total: fmtSize2(snap.maxmem) } })}
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">
          <span style="${pctFs}">${pct(diskFrac)}%</span>
          ${h(VBar, { value: diskFrac, centerFraction: { used: fmtSize2(snap.disk), total: fmtSize2(snap.maxdisk) } })}
        </div>
      </div>
      <div style="display:flex;gap:3px;width:100%;flex-shrink:0">
        <span style="${labelFs}">CPU</span>
        <span style="${labelFs}">RAM</span>
        <span style="${labelFs}">DISK</span>
      </div>
      <div style="
        font-family:${DEFAULT_FONT};
        font-size:clamp(10px,1.05vw,14px);color:${C.white};white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;max-width:100%;flex-shrink:0;
      ">${lxc.display_name || lxc.name || lxc.vmid}</div>
    </div>
  `;
}

// Random per-vmid phase (ms), assigned once the first time a running LXC is
// seen and kept for the page's lifetime — so the 10s display refresh is
// staggered across containers but stable across re-renders and tab swaps.
const _lxcStatOffsets = {};

// ─── LxcStatsPanel ───────────────────────────────────────────────────────────
// Groups are equal flex items that squeeze together as more LXCs come online,
// same as the squares grid adapting to container count — down to a per-group
// floor (LxcStatGroup's min-width) below which bars/labels stop being legible.
// Past that floor the row scrolls horizontally instead of squashing further,
// with the scrollbar hidden (same treatment as the panes tab strip).
function LxcStatsPanel({ lxcs }) {
  injectTermFont();
  const running = lxcs.filter(l => l.status === 'running').sort((a, b) => Number(a.vmid) - Number(b.vmid));
  running.forEach(l => {
    if (!(l.vmid in _lxcStatOffsets)) _lxcStatOffsets[l.vmid] = Math.random() * 10000;
  });

  if (running.length === 0) {
    return html`
      <div style="height:100%;min-height:clamp(140px,18vh,220px);display:flex;align-items:center;justify-content:center;color:${C.dimmer};font-size:clamp(10px,1vw,13px);font-family:${TERM_FONT}">
        NO RUNNING LXC
      </div>
    `;
  }

  return html`
    <div class="lxc-stats-row" style="
      display:flex;gap:clamp(3px,0.6vw,10px);align-items:stretch;
      padding:clamp(6px,0.8vh,12px) clamp(6px,0.8vw,12px);
      overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;
      height:100%;min-height:clamp(140px,18vh,220px);box-sizing:border-box;
      font-family:${TERM_FONT};
    ">
      ${running.map(lxc => h(LxcStatGroup, { key: lxc.vmid, lxc }))}
    </div>
  `;
}

// ─── BottomSection ───────────────────────────────────────────────────────────
// Tab strip swapping the GPU panel and the LXC resource panel in the
// dashboard's bottom slot. When both exist, the GPU panel (normal flow) sets
// the box height and the LXC panel overlays it absolutely-positioned — so
// both panels always share an identical height — and a fade+scale transition
// (identical to the dashboard↔panes swap in App) crossfades between them.
// Both stay mounted so GPU polling keeps running and LXC stagger phases
// survive tab swaps.
function BottomSection({ gpus, lxcs, showGpus, lightMode }) {
  const [tab, setTab] = useState('gpu');
  const hasLxcs = lxcs && lxcs.length > 0;
  if (!showGpus && !hasLxcs) return null;

  const showTabs  = showGpus && hasLxcs;
  const activeTab = showGpus ? tab : 'lxc';

  const tabBtnStyle = active => ({
    background:    active ? C.amber + '30' : 'transparent',
    border:        `1px solid ${active ? C.amber : C.borderDim}`,
    color:         active ? C.amberHi : C.dim,
    fontFamily:    'inherit',
    fontSize:      'clamp(9px,0.9vw,12px)',
    padding:       '2px 10px',
    cursor:        'pointer',
    letterSpacing: '0.5px',
    marginRight:   '4px',
  });

  // Only one of the two exists — render it directly, no tabs/crossfade needed.
  let body;
  if (!showTabs) {
    body = !showGpus
      ? h(LxcStatsPanel, { lxcs })
      : h(GpuSection, { gpus, show: true, lightMode });
  } else {
    const fade = active => ({
      transition:    'opacity 0.3s ease, transform 0.3s ease',
      opacity:       active ? 1 : 0,
      transform:     active ? 'scale(1)' : 'scale(0.96)',
      pointerEvents: active ? 'auto' : 'none',
    });
    body = html`
      <div style="position:relative">
        <div style=${fade(activeTab === 'gpu')}>
          ${h(GpuSection, { gpus, show: true, lightMode })}
        </div>
        <div style=${{ position: 'absolute', inset: 0, overflow: 'hidden', ...fade(activeTab === 'lxc') }}>
          ${h(LxcStatsPanel, { lxcs })}
        </div>
      </div>
    `;
  }

  return html`
    <div style="border-top:1px solid ${C.border};flex-shrink:0">
      ${showTabs ? html`
        <div style="display:flex;padding:4px clamp(6px,0.8vw,12px);border-bottom:1px solid ${C.borderDim}">
          <button style=${tabBtnStyle(activeTab === 'gpu')} onClick=${() => setTab('gpu')}>GPU</button>
          <button style=${tabBtnStyle(activeTab === 'lxc')} onClick=${() => setTab('lxc')}>LXC</button>
        </div>
      ` : null}
      ${body}
    </div>
  `;
}

// ─── ConnectionOverlay ───────────────────────────────────────────────────────
function ConnectionOverlay({ lastUpdate }) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setFlash(f => !f), 600);
    return () => clearInterval(id);
  }, []);

  return html`
    <div style="
      position:absolute;inset:0;
      background:${C.bg}cc;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      z-index:100;
      border:2px solid ${flash ? C.red : C.borderDim};
    ">
      <div style="color:${C.red};font-size:clamp(14px,2vw,22px);letter-spacing:3px;font-weight:bold">CONNECTION LOST</div>
      <div style="color:${C.dim};font-size:clamp(11px,1.2vw,16px);margin-top:8px">last update: ${timeSince(lastUpdate)} ago</div>
      <div style="color:${C.dim};font-size:clamp(11px,1.2vw,16px);margin-top:4px">retrying...</div>
    </div>
  `;
}

// ─── Footer ──────────────────────────────────────────────────────────────────
function Footer({ config, lightMode, setLightMode }) {
  function toggleTheme() {
    const next = !lightMode;
    localStorage.setItem('panelTheme', next ? 'light' : 'dark');
    setLightMode(next);
  }

  return html`
    <div style="
      padding: clamp(5px,0.7vh,10px) clamp(6px,0.8vw,12px);
      border-top:1px solid ${C.borderDim};
      font-size:clamp(9px,0.95vw,13px);
      color:${C.dimmer};
      display:flex;justify-content:space-between;align-items:center;
      flex-shrink:0;
    ">
      <span>PROXMOX STATUS PANEL</span>
      <span style="display:flex;align-items:center;gap:clamp(6px,0.8vw,10px)">
        ${h('button', {
          onClick: toggleTheme,
          title: lightMode ? 'Switch to dark mode' : 'Switch to light mode',
          style: {
            background:    lightMode ? C.amber + '20' : 'transparent',
            border:        `1px solid ${lightMode ? C.amber : C.borderDim}`,
            color:         lightMode ? C.amberHi : C.dim,
            fontFamily:    'inherit',
            fontSize:      'clamp(9px,0.9vw,12px)',
            padding:       '2px 6px',
            cursor:        'pointer',
            lineHeight:    1,
            letterSpacing: '0.5px',
          },
        }, lightMode ? '☾' : '☀')}
        <span>${config ? config.panel_subtitle : 'PROXMOX'}</span>
      </span>
    </div>
  `;
}

// ─── Flicker engine ──────────────────────────────────────────────────────────
function computeFlicker(lxcs, prev) {
  const next = Object.assign({}, prev);
  lxcs.forEach(lxc => {
    const ioTotal = (lxc.disk_read || 0) + (lxc.disk_write || 0);
    const activity = ioTotal === 0 ? 0
      : ioTotal < 50000 ? 0.2
      : ioTotal < 200000 ? 0.5
      : ioTotal < 500000 ? 0.8 : 1.0;
    if (activity === 0 || lxc.status !== 'running') {
      next[lxc.vmid] = 1.0;
      return;
    }
    if (Math.random() < activity * 0.6) {
      next[lxc.vmid] = activity * 0.05 + Math.random() * (1 - activity * 0.5);
    } else {
      next[lxc.vmid] = Math.min(1, (prev[lxc.vmid] ?? 1) + 0.3);
    }
  });
  return next;
}

// ─── Console pane layout utilities ───────────────────────────────────────────

const PANE_GAP = 2; // divider bar width in pixels (amber bleed-through)

// Find the column count that maximises the minimum cell dimension (squarest cells).
// Ties broken by fill efficiency (fewer empty slots).
function computeGrid(n, W, H) {
  if (n <= 1) return { cols: 1, rows: 1 };
  let bestCols  = 1;
  let bestScore = -1;
  for (let c = 1; c <= n; c++) {
    const r        = Math.ceil(n / c);
    const cellW    = W / c;
    const cellH    = H / r;
    const minDim   = Math.min(cellW, cellH);
    const fill     = n / (c * r);           // 0-1, penalises empty slots
    const score    = minDim * 1000 + fill * 10;
    if (score > bestScore) { bestScore = score; bestCols = c; }
  }
  return { cols: bestCols, rows: Math.ceil(n / bestCols) };
}

// Returns array of { x, y, w, h } pixel rects for n visible panes.
// Last row stretches to fill container width (tmux behaviour).
function computePaneRects(n, W, H) {
  if (n === 0) return [];
  const { cols, rows } = computeGrid(n, W, H);
  const cellH      = (H - (rows - 1) * PANE_GAP) / rows;
  const cellW      = (W - (cols - 1) * PANE_GAP) / cols;
  const lastRowN   = n - (rows - 1) * cols;
  const lastCellW  = lastRowN > 0 ? (W - (lastRowN - 1) * PANE_GAP) / lastRowN : cellW;

  return Array.from({ length: n }, (_, i) => {
    const row    = Math.floor(i / cols);
    const col    = i % cols;
    const isLast = row === rows - 1;
    const w      = isLast ? lastCellW : cellW;
    const x      = isLast ? col * (lastCellW + PANE_GAP) : col * (cellW + PANE_GAP);
    const y      = row * (cellH + PANE_GAP);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(cellH) };
  });
}

// ─── ConsolePane ──────────────────────────────────────────────────────────────
// Native xterm.js terminal proxied server-side to Proxmox via WebSocket.
// No Proxmox cookies in the browser — all auth is handled by the dashboard server.

// Hide scrollbars: panes tab strip + xterm.js internal viewport + LXC stats row
{ const s = document.createElement('style'); s.textContent = [
  '.panes-tabs::-webkit-scrollbar{display:none}',
  '.xterm-viewport::-webkit-scrollbar{display:none}',
  // touch-action:none — scrolling is handled in JS (ConsolePane's touch-to-wheel
  // translator) so it works for full-screen TUI apps too, not just shell scrollback.
  '.xterm-viewport{scrollbar-width:none;touch-action:none}',
  '.lxc-stats-row::-webkit-scrollbar{display:none}',
].join(''); document.head.appendChild(s); }

// Uppercase + remove vowels for compact tab labels, then CSS clips without ellipsis
function fmtTabName(raw) {
  return String(raw).toUpperCase().replace(/[AEIOU]/g, '');
}

let _xtermCssInjected = false;
function injectXtermCss() {
  if (_xtermCssInjected) return;
  _xtermCssInjected = true;
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css';
  document.head.appendChild(link);
}

// Tracks which terminal the user last typed into — used by the tmux prefix button
// and the mobile key row. `ctrl` arms a one-shot Ctrl modifier for the next typed
// char; `clearCtrl` lets the key row reset its highlight once that char is consumed.
const _activeTerm = { send: null, ctrl: false, clearCtrl: null };

// ─── MobileKeyRow ─────────────────────────────────────────────────────────────
// Mobile-only key row for the panes view: arrows, Esc, sticky Ctrl, tmux prefix.
// Soft keyboards expose none of these, so terminal history/interrupt/escape are
// otherwise unreachable on a phone. Floats just above the soft keyboard via the
// visualViewport API (falls back to the screen bottom when no keyboard is open).
function MobileKeyRow({ onClose }) {
  const [armed,  setArmed]  = useState(false);
  const [flash,  setFlash]  = useState(null); // key id briefly highlighted on tap
  const [kbInset, setKbInset] = useState(0);

  useEffect(() => {
    _activeTerm.clearCtrl = () => setArmed(false);
    return () => { if (_activeTerm.clearCtrl) _activeTerm.clearCtrl = null; };
  }, []);

  // Track the soft keyboard via visualViewport: inset = space the keyboard occupies
  // at the bottom of the layout viewport.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const inset = window.innerHeight - (vv.height + vv.offsetTop);
      setKbInset(Math.max(0, Math.round(inset)));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);

  // Buttons fire on pointerdown (not click) with preventDefault. Without this,
  // a tap's default focus-shift blurs the xterm <textarea>: the soft keyboard
  // closes, kbInset drops to 0, and the whole row jumps to bottom:0 mid-tap —
  // moving the button out from under the finger before "click" ever fires
  // (the classic mobile "first tap does nothing" bug). preventDefault on
  // pointerdown keeps the textarea focused, so the row never moves and the
  // press registers immediately, with or without the keyboard open.
  function press(e, fn) {
    e.preventDefault();
    fn();
  }

  function tap(id, seq) {
    if (_activeTerm.send) _activeTerm.send(seq);
    setFlash(id);
    setTimeout(() => setFlash(f => (f === id ? null : f)), 200);
  }

  function toggleCtrl() {
    const next = !armed;
    setArmed(next);
    _activeTerm.ctrl = next;
  }

  const btnBase = {
    flex:          1,
    minWidth:      0,
    height:        '40px',
    display:       'flex',
    alignItems:    'center',
    justifyContent:'center',
    background:    'transparent',
    border:        'none',
    borderRight:   `1px solid ${C.borderDim}`,
    color:         C.amberHi,
    fontFamily:    'inherit',
    fontWeight:    'bold',
    fontSize:      '15px',
    cursor:        'pointer',
    touchAction:   'manipulation',
    webkitUserSelect: 'none',
    userSelect:    'none',
    webkitTapHighlightColor: 'transparent',
    transition:    'color 0.12s, background 0.12s',
  };
  const litStyle = { color: C.white, background: C.amber + '55' };

  const keyBtn = (id, label, seq, opts) => h('button', {
    onPointerDown: e => press(e, () => tap(id, seq)),
    style: { ...btnBase, ...(opts || {}), ...(flash === id ? litStyle : {}) },
  }, label);

  return h('div', {
    style: {
      position:     'fixed',
      left: 0, right: 0,
      bottom:       `${kbInset}px`,
      zIndex:       50,
      display:      'flex',
      background:   C.panel,
      borderTop:    `1px solid ${C.border}`,
      boxShadow:    '0 -4px 16px #000a',
    },
  },
    keyBtn('esc', 'ESC', '\x1b'),
    keyBtn('tab', 'TAB', '\x09'),
    h('button', {
      onPointerDown: e => press(e, toggleCtrl),
      style: { ...btnBase, letterSpacing: '0.5px', ...(armed ? litStyle : {}) },
    }, 'CTRL'),
    keyBtn('left',  '◀', '\x1b[D'),
    keyBtn('up',    '▲', '\x1b[A'),
    keyBtn('down',  '▼', '\x1b[B'),
    keyBtn('right', '▶', '\x1b[C'),
    keyBtn('prefix', '⎈B', '\x02', { borderRight: 'none' }),
  );
}

// Shared promise so all ConsolePanes reuse the same CDN fetch.
// PanesView triggers this early so the first tab open is instant.
let _xtermPromise = null;
function warmXterm() {
  if (!_xtermPromise) {
    _xtermPromise = Promise.all([
      import('https://esm.sh/@xterm/xterm@5.5.0'),
      import('https://esm.sh/@xterm/addon-fit@0.10.0'),
    ]);
  }
  return _xtermPromise;
}

// Reconnect backoff after an unexpected WebSocket close: starts fast (most
// disconnects are brief network blips) and caps so a stopped/unreachable
// container doesn't get hammered with connection attempts.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS  = 15000;

function ConsolePane({ vmid, visible, lightMode }) {
  const containerRef  = useRef(null);
  const termRef       = useRef(null);
  const fitRef        = useRef(null);
  const wsRef         = useRef(null);
  const pingRef       = useRef(null);
  const reconnectRef  = useRef(null);  // pending reconnect setTimeout id
  const readyRef      = useRef(false); // true after Proxmox sends "OK"
  const sendStrRef    = useRef(null);  // current terminal's send function (for _activeTerm cleanup)
  const focusHandlerRef = useRef(null); // textarea 'focus' listener (for _activeTerm cleanup)
  const lightModeRef  = useRef(lightMode); // kept current so the async creation closure uses latest value

  useEffect(() => { lightModeRef.current = lightMode; }, [lightMode]);

  // Live-update terminal colours when the app theme toggles. Font is constant
  // across themes, so cell metrics don't change and no re-fit is needed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = lightMode ? LIGHT_TERM_THEME : DARK_TERM_THEME;
  }, [lightMode]);

  useEffect(() => {
    injectXtermCss();
    injectTermFont();
    let destroyed = false;
    let attempt   = 0; // consecutive failed (re)connection attempts, for backoff

    (async () => {
      const [{ Terminal }, { FitAddon }] = await warmXterm();
      if (destroyed || !containerRef.current) return;

      const term = new Terminal({
        theme:       lightModeRef.current ? LIGHT_TERM_THEME : DARK_TERM_THEME,
        fontFamily:  TERM_FONT,
        fontSize:    TERM_FONT_SIZE,
        cursorStyle: 'block',
        scrollback:   2000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);

      termRef.current = term;
      fitRef.current  = fit;

      // Re-fit whenever the container is resized (handles pane grid re-tiling).
      // Always push the new size explicitly — onResize only fires when cols/rows change,
      // but after reconnect the PTY may have drifted from the terminal's current size.
      const ro = new ResizeObserver(() => {
        if (destroyed || !fitRef.current) return;
        try {
          fitRef.current.fit();
          const ws = wsRef.current;
          if (readyRef.current && ws?.readyState === WebSocket.OPEN) {
            ws.send(`1:${term.cols}:${term.rows}:`);
          }
        } catch {}
      });
      ro.observe(containerRef.current);

      // Touch scrolling: xterm.js only scrolls on real 'wheel' events, and only
      // when the buffer has scrollback (i.e. NOT the alternate screen full-screen
      // TUI apps like claude/opencode use — there's nothing to scroll back to,
      // xterm instead converts wheel deltas into Up/Down keys, or into mouse-wheel
      // reports if the app has enabled mouse tracking). Touch drags never fire
      // 'wheel' events, so none of that ever ran on mobile. Fix: translate touch
      // drags into synthetic WheelEvents dispatched on term.element and let
      // xterm's own handler do the right thing for whichever mode is active.
      //
      // xterm.js also registers its OWN touchstart/touchmove listeners directly
      // on term.element (a descendant of this container) and calls
      // stopPropagation() on them once it decides it "handled" the gesture —
      // which for the alt-screen case just means silently swallowing it. That
      // ran before our listener ever saw the event. So we listen in the CAPTURE
      // phase (fires on the way down, before term.element's bubble-phase
      // listener) and stopPropagation ourselves, fully taking over every touch
      // gesture inside the pane rather than racing xterm's internal handler.
      let touchY = null;
      const onTouchStart = e => {
        touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
        if (touchY !== null) e.stopPropagation();
      };
      const onTouchMove = e => {
        if (touchY === null || e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        const deltaY = touchY - t.clientY;
        touchY = t.clientY;
        if (!deltaY) return;
        term.element?.dispatchEvent(new WheelEvent('wheel', {
          deltaY, deltaMode: 0, clientX: t.clientX, clientY: t.clientY,
          bubbles: true, cancelable: true,
        }));
      };
      const onTouchEnd = e => { touchY = null; e.stopPropagation(); };
      const touchTarget = containerRef.current;
      touchTarget.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      touchTarget.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      touchTarget.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
      touchTarget.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });

      // Proxmox input protocol: "0:" + UTF-8 byte length + ":" + data
      // Register this terminal as active on every keystroke so the tmux prefix
      // button always targets whichever pane the user last interacted with.
      // Reads wsRef.current so it keeps working across reconnects.
      const sendStr = str => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && readyRef.current) {
          ws.send(`0:${new TextEncoder().encode(str).length}:${str}`);
        }
      };
      sendStrRef.current = sendStr;
      term.onData(d => {
        _activeTerm.send = sendStr;
        // Sticky Ctrl (armed by the mobile key row): map the next single
        // printable char to its control code (e.g. 'c' → 0x03 = Ctrl+C).
        if (_activeTerm.ctrl && d.length === 1 && d >= ' ' && d <= '~') {
          _activeTerm.ctrl = false;
          if (_activeTerm.clearCtrl) _activeTerm.clearCtrl();
          sendStr(String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f));
          return;
        }
        sendStr(d);
      });

      // Tapping into a pane (or it being auto-focused) should retarget the mobile
      // key row immediately — not just after the user's first keystroke. Without
      // this, switching tabs and pressing a key-row button before typing anything
      // sends to whichever pane was last typed into instead of the one on screen.
      focusHandlerRef.current = () => { _activeTerm.send = sendStr; };
      term.textarea?.addEventListener('focus', focusHandlerRef.current);

      // Proxmox resize protocol: "1:cols:rows:"
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && readyRef.current) {
          ws.send(`1:${cols}:${rows}:`);
        }
      });

      // Opens the WebSocket to our server-side proxy and wires up its lifecycle.
      // Re-invoked automatically on unexpected close (with capped backoff) so
      // a dropped connection recovers on its own — each (re)connect gets a
      // fresh PTY/shell from Proxmox, same as manually closing and reopening
      // the pane via its tab.
      function connect() {
        if (destroyed) return;
        readyRef.current = false;

        const proto  = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = vmid === 'node' ? '/api/node/termproxy' : `/api/lxc/${vmid}/termproxy`;
        const ws     = new WebSocket(`${proto}//${location.host}${wsPath}`, ['binary']);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onmessage = e => {
          const data = new Uint8Array(e.data instanceof ArrayBuffer ? e.data : new TextEncoder().encode(e.data));
          if (!readyRef.current) {
            // Proxmox sends "OK" (0x4F 0x4B) to confirm auth; anything after is terminal data
            if (data[0] === 79 && data[1] === 75) {
              readyRef.current = true;
              const reconnected = attempt > 0;
              attempt = 0;
              if (data.length > 2) term.write(data.slice(2));
              if (reconnected) term.writeln('\r\n\x1b[32m[reconnected]\x1b[0m');
              // Double-RAF: wait for pane layout to settle, then fit and push size.
              // We always send 1:cols:rows: explicitly — onResize won't fire if the
              // terminal was already fit to these dimensions during setup.
              requestAnimationFrame(() => requestAnimationFrame(() => {
                fit.fit();
                ws.send(`1:${term.cols}:${term.rows}:`);
                if (!reconnected) term.focus();
              }));
            }
            // else: still authenticating, ignore
          } else {
            term.write(data);
          }
        };

        // Keepalive ping every 30 s (Proxmox closes idle connections otherwise)
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('2');
        }, 30000);

        ws.onclose = () => {
          clearInterval(pingRef.current);
          if (destroyed || !termRef.current) return;
          attempt += 1;
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
          term.writeln(`\r\n\x1b[2m[disconnected — reconnecting in ${Math.round(delay / 1000)}s...]\x1b[0m`);
          reconnectRef.current = setTimeout(connect, delay);
        };
        ws.onerror = () => {
          if (!destroyed && termRef.current) term.writeln('\r\n\x1b[31m[connection error]\x1b[0m');
        };
      }

      connect();

      return () => {
        ro.disconnect();
        touchTarget.removeEventListener('touchstart', onTouchStart, { capture: true });
        touchTarget.removeEventListener('touchmove', onTouchMove, { capture: true });
        touchTarget.removeEventListener('touchend', onTouchEnd, { capture: true });
        touchTarget.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      };
    })();

    return () => {
      destroyed = true;
      if (_activeTerm.send === sendStrRef.current) _activeTerm.send = null;
      clearInterval(pingRef.current);
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
      if (focusHandlerRef.current) termRef.current?.textarea?.removeEventListener('focus', focusHandlerRef.current);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current  = null;
      wsRef.current   = null;
      readyRef.current = false;
    };
  }, [vmid]);

  // Fit and re-send terminal size when pane becomes visible after being minimised.
  // onResize alone is not enough — if grid dimensions are unchanged the event won't fire.
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current.fit();
        if (readyRef.current && wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
          wsRef.current.send(`1:${termRef.current.cols}:${termRef.current.rows}:`);
        }
      } catch {}
    });
  }, [visible]);

  return h('div', {
    ref:   containerRef,
    style: {
      width: '100%', height: '100%', overflow: 'hidden',
      background: lightMode ? LIGHT_TERM_THEME.background : DARK_TERM_THEME.background,
    },
  });
}

// ─── PaneGrid ─────────────────────────────────────────────────────────────────
// Renders absolutely-positioned terminal panes. Connected panes (visible or minimised)
// are mounted once and NEVER reparented — hiding uses display:none so sessions persist.
function PaneGrid({ lxcs, paneStates, lightMode }) {
  const containerRef              = useRef(null);
  const [dim, setDim]             = useState({ w: 100, h: 100 });
  const [focusedVmid, setFocused] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDim({ w: Math.max(1, Math.floor(width)), h: Math.max(1, Math.floor(height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sort: ROOT entry (non-numeric vmid) always first, then by numeric vmid
  const allLxcs   = [...lxcs].sort((a, b) => {
    const na = Number(a.vmid), nb = Number(b.vmid);
    if (isNaN(na)) return -1;
    if (isNaN(nb)) return  1;
    return na - nb;
  });
  const connected = allLxcs.filter(l => { const s = (paneStates && paneStates[l.vmid]) || 'closed'; return s === 'visible' || s === 'minimized'; });
  const visible   = connected.filter(l => ((paneStates && paneStates[l.vmid]) || 'closed') === 'visible');

  const rects  = computePaneRects(visible.length, dim.w, dim.h);
  const rectMap = {};
  visible.forEach((l, i) => { rectMap[l.vmid] = rects[i]; });

  return h('div', {
    ref:   containerRef,
    style: { flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0, background: C.amber + '50' },
  },
    connected.map(lxc => {
      const rect      = rectMap[lxc.vmid];
      const isVisible = !!rect;
      const isFocused = focusedVmid === lxc.vmid;

      return h('div', {
        key:     lxc.vmid,
        onClick: () => setFocused(lxc.vmid),
        style: {
          position:  'absolute',
          left:      isVisible ? rect.x + 'px' : '0',
          top:       isVisible ? rect.y + 'px' : '0',
          width:     isVisible ? rect.w + 'px' : '0',
          height:    isVisible ? rect.h + 'px' : '0',
          display:   isVisible ? 'block' : 'none',
          boxSizing: 'border-box',
          border:    `2px solid ${isFocused ? C.amberHi : C.borderDim}`,
          overflow:  'hidden',
        },
      },
        h(ConsolePane, { key: 'term-' + lxc.vmid, vmid: lxc.vmid, visible: isVisible, lightMode }),
      );
    }),
  );
}

// ROOT shell sentinel — prepended to lxcs so PaneGrid mounts a ConsolePane for it
const NODE_ENTRY = { vmid: 'node', display_name: 'ROOT', status: 'running', _isNode: true };

// ─── PanesView ────────────────────────────────────────────────────────────────
// All auth is handled server-side; the browser only talks to the dashboard.
function PanesView({ lxcs, paneStates, lightMode }) {
  // Pre-warm the xterm.js CDN fetch the moment the user switches to panes view,
  // so the first tab click is instant rather than waiting for a cold CDN download.
  useEffect(() => { injectXtermCss(); warmXterm(); }, []);
  // Prepend the ROOT shell so PaneGrid knows to render a ConsolePane for it
  const allPanes = [NODE_ENTRY, ...lxcs];
  return h(PaneGrid, { lxcs: allPanes, paneStates, lightMode });
}

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
  const [status,      setStatus]     = useState(null);
  const [config,      setConfig]     = useState(null);
  const [lastUpdate,  setLastUpdate] = useState(null);
  const [failCount,   setFailCount]  = useState(0);
  const [winW,        setWinW]       = useState(window.innerWidth);
  const [winH,        setWinH]       = useState(window.innerHeight);
  const [openVmid,    setOpenVmid]   = useState(null);
  const [view,        setView]       = useState('dashboard'); // 'dashboard' | 'panes'
  const [paneStates,  setPaneStates] = useState({});          // vmid → 'closed'|'visible'|'minimized'
  const [keyRowOpen,  setKeyRowOpen] = useState(false);       // mobile-only on-screen key row
  const [lightMode,   setLightMode]  = useState(() => localStorage.getItem('panelTheme') === 'light');
  const flickerRef = useRef({});
  const lxcsRef    = useRef([]);

  // Update the module-level palette before any child reads it.
  C = lightMode ? LIGHT : DARK;

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const onResize = () => { setWinW(window.innerWidth); setWinH(window.innerHeight); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close open LXC cell when clicking anywhere outside — only active in dashboard mode
  useEffect(() => {
    if (view === 'panes') return;
    const close = () => setOpenVmid(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [view]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      setLastUpdate(Date.now());
      setFailCount(0);
      lxcsRef.current = data.lxcs || [];
    } catch {
      setFailCount(f => f + 1);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    const id = setInterval(() => {
      flickerRef.current = computeFlicker(lxcsRef.current, flickerRef.current);
    }, 80);
    return () => clearInterval(id);
  }, []);

  // Load persisted pane states on mount (shared across devices/refreshes)
  useEffect(() => {
    fetch('/api/panes')
      .then(r => r.json())
      .then(data => { if (data && data.states) setPaneStates(data.states); })
      .catch(() => {});
  }, []);

  function savePaneStates(states) {
    fetch('/api/panes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(states),
    }).catch(() => {});
  }

  // Tab click: closed → visible; visible → minimized; minimized → visible
  function handleTabClick(vmid) {
    setPaneStates(prev => {
      const cur     = prev[vmid] || 'closed';
      const next    = cur === 'closed' ? 'visible' : cur === 'visible' ? 'minimized' : 'visible';
      const updated = { ...prev, [vmid]: next };
      savePaneStates(updated);
      return updated;
    });
  }

  // Tab × close: disconnect iframe
  function handleTabClose(vmid) {
    setPaneStates(prev => {
      const updated = { ...prev, [vmid]: 'closed' };
      savePaneStates(updated);
      return updated;
    });
  }

  const disconnected = failCount >= 3;
  const narrow     = winW < 480; // phone portrait — same threshold HeaderBar uses
  const lxcs       = status ? (status.lxcs || []) : [];
  const gpus       = status ? (status.gpus || []) : [];
  const showGpus   = config ? config.show_gpus : false;

  // Responsive column count: scale config cols by aspect ratio relative to 16:9 baseline
  const ar       = winW / winH;
  const baseCols = config ? (config.lxc_grid_cols || 6) : 6;
  const cols     = Math.max(2, Math.floor(baseCols * Math.sqrt(ar / (16 / 9))));

  return html`
    <div style="
      width:100vw; height:100dvh;
      display:flex; flex-direction:column;
      background:${C.bg};
      padding:clamp(4px,0.5vw,10px);
      box-sizing:border-box;
    ">
      <div style="
        flex:1;
        display:flex;flex-direction:column;
        background:${C.panel};
        border:1px solid ${C.border};
        box-shadow:0 0 40px ${C.shadow};
        overflow:hidden;
        position:relative;
        min-height:0;
      ">
        ${disconnected ? h(ConnectionOverlay, { lastUpdate }) : null}
        ${h(HeaderBar, {
          node: status ? status.node : null,
          lxcs, config, view, setView,
          paneStates,
          onTabClick:  handleTabClick,
          onTabClose:  handleTabClose,
          keyRowOpen, setKeyRowOpen,
        })}

        <!-- Content: both views always mounted (overlaid grid) so GPU keeps polling
             and terminals survive. CSS opacity+scale cross-fade handles the transition. -->
        <div style="
          flex:1; min-height:0; overflow:hidden;
          display:grid; grid-template-rows:1fr; grid-template-columns:1fr;
        ">
          <!-- Dashboard view -->
          <div style="
            grid-row:1; grid-column:1;
            display:flex; flex-direction:column; min-height:0; overflow:hidden;
            transition: opacity 0.3s ease, transform 0.3s ease;
            opacity:    ${view === 'dashboard' ? 1 : 0};
            transform:  ${view === 'dashboard' ? 'scale(1)' : 'scale(0.96)'};
            pointer-events: ${view === 'dashboard' ? 'auto' : 'none'};
          ">
            ${h(LxcGrid,       { lxcs, cols, flickerRef, openVmid, setOpenVmid })}
            ${h(BottomSection, { gpus, lxcs, showGpus, lightMode })}
          </div>

          <!-- Panes view -->
          <div style="
            grid-row:1; grid-column:1;
            display:flex; flex-direction:column; min-height:0; overflow:hidden;
            transition: opacity 0.3s ease, transform 0.3s ease;
            opacity:    ${view === 'panes' ? 1 : 0};
            transform:  ${view === 'panes' ? 'scale(1)' : 'scale(0.96)'};
            pointer-events: ${view === 'panes' ? 'auto' : 'none'};
          ">
            ${h(PanesView, { lxcs, paneStates, lightMode })}
          </div>
        </div>

        ${h(Footer, { config, lightMode, setLightMode })}
      </div>
      ${view === 'panes' && narrow && keyRowOpen
        ? h(MobileKeyRow, { onClose: () => setKeyRowOpen(false) })
        : null}
    </div>
  `;
}

// ─── Mount ───────────────────────────────────────────────────────────────────
render(h(App, null), document.getElementById('app'));
