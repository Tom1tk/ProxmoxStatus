// Terminal panes: xterm.js setup, the WebSocket to server/termProxy.js
// (reconnect + liveness), terminal-size ownership and reader-mode geometry.
// Imports the same esm.sh Preact specifiers as panel.js - a second Preact copy
// would break hooks.
import { h } from 'https://esm.sh/preact@10';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10/hooks';
import { ReaderView } from './reader.js';

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

// Many TUIs pick a dark or light palette once, at startup, and keep it. In
// light mode xterm lifts any text below this contrast ratio against its
// background (WCAG AA), so a dark-themed app stays readable on the light
// terminal without restarting. Dark mode leaves app colours untouched.
const LIGHT_MIN_CONTRAST = 4.5;
const termThemeOptions = light => ({
  theme:                light ? LIGHT_TERM_THEME : DARK_TERM_THEME,
  minimumContrastRatio: light ? LIGHT_MIN_CONTRAST : 1,
});

// Colour-scheme updates (DEC mode 2031, as in kitty/ghostty/contour): an app
// that enables the mode is told "dark"/"light" whenever the theme toggles, and
// can ask with CSI ? 996 n. Reports are never sent unless the app opted in -
// unsolicited, they'd arrive as stray keystrokes.
const COLOR_SCHEME_MODE = 2031;
const colorSchemeReport = light => `\x1b[?997;${light ? 2 : 1}n`;

// Terminal font — the scanline "Glass TTY VT220" font reads poorly at small
// sizes, so this is the page-wide default (mirrors style.css's html/body font),
// lazy-loaded from Google Fonts.
export const TERM_FONT      = "'JetBrains Mono', 'Courier New', monospace";
const TERM_FONT_SIZE = 12;
let _termFontInjected = false;
export function injectTermFont() {
  if (_termFontInjected) return;
  _termFontInjected = true;
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  // 700 (bold) is for reader mode — regular xterm rendering never requests it.
  link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap';
  document.head.appendChild(link);
}
// TERM_FONT is now the page-wide default (see style.css), so load it immediately
// rather than waiting for a specific panel to mount.
injectTermFont();

// ─── Helpers ─────────────────────────────────────────────────────────────────
let _xtermCssInjected = false;
export function injectXtermCss() {
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
export const _activeTerm = { send: null, ctrl: false, clearCtrl: null };

// Shared promise so all ConsolePanes reuse the same CDN fetch.
// PanesView triggers this early so the first tab open is instant.
let _xtermPromise = null;
export function warmXterm() {
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
// Liveness on flaky networks: a dropped connection often leaves the socket
// "open" with nothing behind it (no onclose, input vanishes). The server acks
// every keepalive ping, so silence past these limits means the socket is dead.
const PING_INTERVAL_MS   = 30000;
const PROBE_TIMEOUT_MS   = 5000;  // resume/online probe
const CONNECT_TIMEOUT_MS = 10000; // open + Proxmox "OK"
// Fired by App when /api/status recovers after failures: the network is back,
// so every terminal checks its socket rather than waiting out a backoff.
export const REVIVE_EVENT = 'panel:revive';
// Size ownership (server/sizeOwnership.js): stable per-browser id so a device
// that reconnects is still recognised as the one that owns a terminal's size.
const CLIENT_ID = (() => {
  const fresh = () => Math.random().toString(36).slice(2, 14).padEnd(8, '0');
  try {
    let id = localStorage.getItem('panelClientId');
    if (!/^[a-z0-9]{8,32}$/.test(id || '')) {
      id = fresh();
      localStorage.setItem('panelClientId', id);
    }
    return id;
  } catch { return fresh(); }
})();
const CTL_PREFIX = '\x00pp:';
// Device-level ownership. A real gesture on any pane makes this device the
// active one and claims every open terminal; while active, any pane that
// connects or becomes visible claims too. Cleared when another device claims.
const _device = { active: false, claimers: new Set() };
function claimAllTerminals() {
  _device.active = true;
  _device.claimers.forEach(claim => claim());
}
// Desktop mouse only: touch devices fire synthetic mouseenter on tap, which
// would raise the soft keyboard on every scroll drag.
export const HOVER_FOCUS = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;

// Watching: xterm is at the owner's cols/rows, which may not fit this pane.
// Shrink it to fit (never enlarge) using the rendered grid's own size, so no
// private xterm API or separate character measurement is needed.
function scaleToHost(term, host) {
  const el     = term.element;
  const screen = el?.querySelector('.xterm-screen');
  if (!el || !screen || !screen.offsetWidth || !screen.offsetHeight) return;
  const scale = Math.min(host.clientWidth / screen.offsetWidth, host.clientHeight / screen.offsetHeight, 1);
  el.style.transformOrigin = 'top left';
  el.style.transform = scale < 1 ? `scale(${scale})` : '';
}

export function ConsolePane({ vmid, visible, lightMode, readerMode, readerSize }) {
  const containerRef  = useRef(null); // outer layout box (sized by PaneGrid)
  const xtermHostRef  = useRef(null); // inner absolute-fill box xterm actually renders into;
                                       // split from containerRef so reader mode can hide just
                                       // this layer (opacity:0, never display:none/visibility:hidden -
                                       // see reader-mode plan §6 for why) while ReaderView overlays it
  const termRef       = useRef(null);
  const fitRef        = useRef(null);
  const wsRef         = useRef(null);
  const pingRef       = useRef(null);
  const reconnectRef  = useRef(null);  // pending reconnect setTimeout id
  const readyRef      = useRef(false); // true after Proxmox sends "OK"
  const sendStrRef    = useRef(null);  // current terminal's send function (for _activeTerm cleanup)
  const sendRawRef     = useRef(null);  // sends terminal-generated replies (no ownership claim)
  const schemeNotifyRef = useRef(false); // app enabled colour-scheme updates (mode 2031)
  const focusHandlerRef = useRef(null); // textarea 'focus' listener (for _activeTerm cleanup)
  const lightModeRef  = useRef(lightMode); // kept current so the async creation closure uses latest value
  const roRef          = useRef(null);  // ResizeObserver (torn down in the outer cleanup, see below)
  const touchCleanupRef = useRef(null); // removes the 4 capture-phase touch listeners
  // Single owner of PTY geometry (see reader-mode plan §4). geomRef holds the
  // current target — mode:'fit' (pane-driven, the historical behavior) or
  // mode:'reader' with explicit cols/rows computed from the reader's width.
  // applyGeometryRef holds the function that acts on it; every call site that
  // used to call fit.fit() directly now calls applyGeometryRef.current()
  // instead, so reader geometry can never be silently reverted by the
  // ResizeObserver, a reconnect, or the un-minimise effect running on its own.
  const geomRef          = useRef({ mode: 'fit', cols: null, rows: null });
  const applyGeometryRef = useRef(null);
  const connectNowRef    = useRef(null); // skips a pending reconnect backoff (tab resume)
  // What the server says the shared PTY is. watching = another device owns the
  // size: render at its cols/rows scaled to fit, and never send resizes.
  // Separate from geomRef, which stays "what this device wants".
  const watchRef         = useRef({ watching: false, cols: null, rows: null });
  const claimRef         = useRef(null); // sends a size claim if watching (see sizeOwnership.js)
  const claimPendingRef  = useRef(false); // one claim in flight at a time (mousemove can burst)
  // True once term.open() has run. The Terminal is created inside an async IIFE
  // (below) that awaits the xterm CDN import, so termRef.current is null for a
  // beat after mount - anything that needs to touch the live terminal (like
  // ReaderView) must wait for this rather than firing once on mount.
  const [termReady, setTermReady] = useState(false);

  useEffect(() => { lightModeRef.current = lightMode; }, [lightMode]);

  // Live-update terminal colours when the app theme toggles. Font is constant
  // across themes, so cell metrics don't change and no re-fit is needed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    Object.assign(term.options, termThemeOptions(lightMode));
    if (schemeNotifyRef.current) sendRawRef.current?.(colorSchemeReport(lightMode));
  }, [lightMode]);

  useEffect(() => {
    injectXtermCss();
    injectTermFont();
    let destroyed = false;
    let attempt   = 0; // consecutive failed (re)connection attempts, for backoff

    (async () => {
      const [{ Terminal }, { FitAddon }] = await warmXterm();
      if (destroyed || !xtermHostRef.current) return;

      const term = new Terminal({
        ...termThemeOptions(lightModeRef.current),
        fontFamily:  TERM_FONT,
        fontSize:    TERM_FONT_SIZE,
        cursorStyle: 'block',
        scrollback:   2000,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(xtermHostRef.current);
      // Our scrollbar is hidden, so xterm measures its width as 0 and then
      // substitutes a 15px fallback, which FitAddon reserves on the right:
      // a two-column dead strip on every pane. Only FitAddon reads it.
      const viewport = term._core?.viewport;
      if (viewport && 'scrollBarWidth' in viewport) viewport.scrollBarWidth = 0;

      termRef.current = term;
      fitRef.current  = fit;
      setTermReady(true);

      // The single place PTY geometry gets applied from. mode:'fit' reproduces
      // the historical behavior (fit to the pane, explicitly re-send cols/rows
      // since onResize only fires when they change but the PTY may have drifted
      // after a reconnect). mode:'reader' (set by reader mode before calling)
      // resizes to its own computed cols/rows instead; term.onResize already
      // sends 1:cols:rows: whenever resize() actually changes the dimensions,
      // so there's nothing further to push in that branch.
      const applyGeometry = () => {
        if (destroyed || !fitRef.current || !termRef.current) return;
        const host = xtermHostRef.current;
        if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
        const t = termRef.current;
        try {
          const watch = watchRef.current;
          if (watch.watching) {
            // Visible again / newly connected on the active device: take it
            // (no-op while hidden - claim needs a non-zero proposed size).
            if (_device.active) claimRef.current?.();
            t.resize(watch.cols, watch.rows);
            requestAnimationFrame(() => scaleToHost(t, host));
            return;
          }
          if (t.element) t.element.style.transform = '';
          const geom = geomRef.current;
          if (geom.mode === 'reader' && geom.cols && geom.rows) {
            t.resize(geom.cols, geom.rows);
          } else {
            fitRef.current.fit();
            const ws = wsRef.current;
            if (readyRef.current && ws?.readyState === WebSocket.OPEN) {
              ws.send(`1:${t.cols}:${t.rows}:`);
            }
          }
        } catch {}
      };
      applyGeometryRef.current = applyGeometry;

      // Re-apply whenever the host is resized (handles pane grid re-tiling).
      const ro = new ResizeObserver(() => applyGeometryRef.current?.());
      ro.observe(xtermHostRef.current);
      roRef.current = ro;

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
      const touchTarget = xtermHostRef.current;
      touchTarget.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      touchTarget.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      touchTarget.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
      touchTarget.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
      touchCleanupRef.current = () => {
        touchTarget.removeEventListener('touchstart', onTouchStart, { capture: true });
        touchTarget.removeEventListener('touchmove', onTouchMove, { capture: true });
        touchTarget.removeEventListener('touchend', onTouchEnd, { capture: true });
        touchTarget.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      };

      // Proxmox input protocol: "0:" + UTF-8 byte length + ":" + data
      // Register this terminal as active on every keystroke so the tmux prefix
      // button always targets whichever pane the user last interacted with.
      // Reads wsRef.current so it keeps working across reconnects.
      // Take over this terminal's size at the size this device wants. Only
      // sent while watching, so hover/focus churn on the owning device is free.
      const claim = () => {
        const ws = wsRef.current;
        if (!watchRef.current.watching || !readyRef.current || ws?.readyState !== WebSocket.OPEN) return;
        const geom = geomRef.current;
        const want = geom.mode === 'reader' && geom.cols
          ? geom
          : fitRef.current?.proposeDimensions();
        if (!want?.cols || !want?.rows || claimPendingRef.current) return;
        claimPendingRef.current = true; // cleared by the server's reply (onOwnership)
        ws.send(`9:${want.cols}:${want.rows}:`);
      };
      claimRef.current = claim;
      _device.claimers.add(claim);

      const sendStr = str => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && readyRef.current) {
          if (!_device.active || watchRef.current.watching) claimAllTerminals(); // e.g. MobileKeyRow after another device took over
          ws.send(`0:${new TextEncoder().encode(str).length}:${str}`);
        }
      };
      sendStrRef.current = sendStr;

      // Terminal-generated replies (not user input): no ownership claim, and
      // only from the device that owns the size - every connected device's
      // xterm sees the same query, and the app should get one answer.
      const sendRaw = str => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN && readyRef.current && !watchRef.current.watching) {
          ws.send(`0:${new TextEncoder().encode(str).length}:${str}`);
        }
      };
      sendRawRef.current = sendRaw;
      const onSchemeMode = enable => params => {
        if (params.includes(COLOR_SCHEME_MODE)) schemeNotifyRef.current = enable;
        return false; // let xterm handle any other modes in the same sequence
      };
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onSchemeMode(true));
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onSchemeMode(false));
      term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, params => {
        if (params.length !== 1 || params[0] !== 996) return false;
        sendRaw(colorSchemeReport(lightModeRef.current));
        return true;
      });
      // xterm also emits its automatic replies to the app's queries (device
      // attributes, cursor position, focus in/out) through onData. Those come
      // from every connected device, so they must not claim: only data that
      // follows a real input event here counts as typing.
      let lastInputAt = -Infinity;
      for (const t of ['keydown', 'paste', 'input', 'compositionend', 'mousedown', 'wheel']) {
        term.element.addEventListener(t, () => { lastInputAt = performance.now(); }, true);
      }
      term.onData(d => {
        if (performance.now() - lastInputAt > 250) { sendRaw(d); return; }
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
      // Deliberately NOT an ownership claim: focus also fires programmatically
      // (post-connect term.focus(), reader auto-focus), which would let a device
      // merely loading the page steal the size. Claims come from real gestures:
      // pointerdown, mouse movement, reader tap, typing.
      focusHandlerRef.current = () => { _activeTerm.send = sendStr; };
      term.textarea?.addEventListener('focus', focusHandlerRef.current);

      // Proxmox resize protocol: "1:cols:rows:"
      term.onResize(({ cols, rows }) => {
        if (watchRef.current.watching) return; // server would drop it anyway
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
      // Ownership control frame from the server: { owner, cols, rows }.
      function onOwnership(json) {
        let msg;
        try { msg = JSON.parse(json); } catch { return; }
        if (msg.ack) return; // keepalive ack: its arrival (lastRx) is all that matters
        // Another device claimed this terminal: it's now the active one.
        if (msg.claimed && !msg.owner) _device.active = false;
        const watching = !msg.owner && !!msg.cols && !!msg.rows;
        watchRef.current = { watching, cols: msg.cols, rows: msg.rows };
        claimPendingRef.current = false;
        applyGeometryRef.current?.();
      }

      let lastRx = 0;      // time of the last frame of any kind from the server
      let pingSentAt = 0;  // unanswered keepalive, 0 if answered
      let connectTimer = null;

      function scheduleReconnect(msg) {
        clearInterval(pingRef.current);
        clearTimeout(connectTimer);
        if (destroyed || !termRef.current) return;
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
        term.writeln(`\r\n\x1b[2m[${msg} — reconnecting in ${Math.round(delay / 1000)}s...]\x1b[0m`);
        clearTimeout(reconnectRef.current);
        reconnectRef.current = setTimeout(connect, delay);
      }

      // Abandon a socket that has gone silent. Its handlers check they still
      // own wsRef, so a late onclose/onmessage from it is ignored.
      function dropStale(msg) {
        const ws = wsRef.current;
        wsRef.current = null;
        readyRef.current = false;
        try { ws?.close(); } catch {}
        scheduleReconnect(msg);
      }

      function sendPing(ws) {
        pingSentAt = Date.now();
        ws.send('2');
      }

      function connect() {
        if (destroyed) return;
        clearInterval(pingRef.current);
        clearTimeout(connectTimer);
        readyRef.current = false;
        claimPendingRef.current = false; // a claim lost with the old socket

        const proto  = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = vmid === 'node' ? '/api/node/termproxy' : `/api/lxc/${vmid}/termproxy?cid=${CLIENT_ID}`;
        const ws     = new WebSocket(`${proto}//${location.host}${wsPath}`, ['binary']);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;
        lastRx = Date.now();
        pingSentAt = 0;
        connectTimer = setTimeout(() => {
          if (wsRef.current === ws && !readyRef.current) dropStale('connection stalled');
        }, CONNECT_TIMEOUT_MS);

        ws.onmessage = e => {
          if (wsRef.current !== ws) return;
          lastRx = Date.now();
          pingSentAt = 0;
          if (typeof e.data === 'string' && e.data.startsWith(CTL_PREFIX)) {
            onOwnership(e.data.slice(CTL_PREFIX.length));
            return;
          }
          const data = new Uint8Array(e.data instanceof ArrayBuffer ? e.data : new TextEncoder().encode(e.data));
          if (!readyRef.current) {
            // Proxmox sends "OK" (0x4F 0x4B) to confirm auth; anything after is terminal data
            if (data[0] === 79 && data[1] === 75) {
              readyRef.current = true;
              clearTimeout(connectTimer);
              const reconnected = attempt > 0;
              attempt = 0;
              // A node reconnect is a fresh login, so the old program's mouse
              // tracking must go, or mouse moves get typed into the prompt.
              if (reconnected && vmid === 'node') term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l');
              if (data.length > 2) term.write(data.slice(2));
              if (reconnected) term.writeln('\r\n\x1b[32m[reconnected]\x1b[0m');
              // Double-RAF: wait for pane layout to settle, then apply geometry.
              // Routed through applyGeometryRef (rather than fit.fit() directly)
              // so a reconnect while reader mode is active re-applies reader
              // geometry instead of reverting to pane-fit geometry.
              requestAnimationFrame(() => requestAnimationFrame(() => {
                applyGeometryRef.current?.();
                // Always restate the size on (re)connect: this is a brand-new
                // PTY whose attach just resized the container console, and
                // applyGeometry stays silent when the local geometry is
                // unchanged (notably reader mode).
                if (!watchRef.current.watching && readyRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(`1:${term.cols}:${term.rows}:`);
                }
                if (!reconnected) term.focus();
              }));
            }
            // else: still authenticating, ignore
          } else {
            term.write(data);
          }
        };

        // Keepalive ping (Proxmox closes idle connections otherwise). A ping
        // still unanswered a whole interval later means the socket is dead.
        pingRef.current = setInterval(() => {
          if (wsRef.current !== ws || !readyRef.current) return;
          if (pingSentAt) { dropStale('connection lost'); return; }
          if (ws.readyState === WebSocket.OPEN) sendPing(ws);
        }, PING_INTERVAL_MS);

        ws.onclose = () => {
          if (wsRef.current !== ws) return;
          scheduleReconnect('disconnected');
        };
        ws.onerror = () => {
          if (wsRef.current !== ws) return;
          if (!destroyed && termRef.current) term.writeln('\r\n\x1b[31m[connection error]\x1b[0m');
        };
      }

      connect();
      // Returning to the tab shouldn't mean sitting out the rest of a backoff
      // (up to 15s) that started while the socket was throttled in the background.
      // It also runs when the network or the status poll comes back: an open
      // socket gets a quick probe, since it may be dead without knowing it.
      connectNowRef.current = () => {
        if (destroyed) return;
        const ws = wsRef.current;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          clearTimeout(reconnectRef.current);
          connect();
          return;
        }
        if (ws.readyState !== WebSocket.OPEN || !readyRef.current) return; // connect timeout covers it
        const sentAt = Date.now();
        if (!pingSentAt) sendPing(ws);
        setTimeout(() => {
          if (wsRef.current === ws && lastRx < sentAt) dropStale('connection lost');
        }, PROBE_TIMEOUT_MS);
      };
      // Note: this async IIFE's own return value is just the resolved promise,
      // NOT an effect cleanup — Preact never sees it. All teardown for what's
      // set up in here (ro, touch listeners) happens via the refs below, in the
      // effect's real cleanup function.
    })();

    return () => {
      destroyed = true;
      if (_activeTerm.send === sendStrRef.current) _activeTerm.send = null;
      clearInterval(pingRef.current);
      clearTimeout(reconnectRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
      if (focusHandlerRef.current) termRef.current?.textarea?.removeEventListener('focus', focusHandlerRef.current);
      try { roRef.current?.disconnect(); } catch {}
      try { touchCleanupRef.current?.(); } catch {}
      roRef.current = null;
      touchCleanupRef.current = null;
      applyGeometryRef.current = null;
      connectNowRef.current = null;
      _device.claimers.delete(claimRef.current);
      claimRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current  = null;
      wsRef.current   = null;
      readyRef.current = false;
      setTermReady(false);
    };
  }, [vmid]);

  // Re-apply geometry when pane becomes visible after being minimised.
  // onResize alone is not enough — if grid dimensions are unchanged the event won't fire.
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    requestAnimationFrame(() => {
      applyGeometryRef.current?.();
    });
  }, [visible]);

  // Tab/desktop resume and monitor (devicePixelRatio) changes. The
  // ResizeObserver can't catch these: the container is the same size, but
  // xterm's cached cell metrics may be stale (a DPR change halves or doubles
  // them - the "terminal drawn at 1/4 size" symptom) and another client may
  // have resized the shared PTY meanwhile. A fontSize round-trip forces
  // xterm to re-measure; applyGeometry then refits and, in fit mode,
  // re-sends cols/rows even if unchanged.
  useEffect(() => {
    if (!termReady) return;
    const remeasure = () => {
      const t = termRef.current;
      if (!t) return;
      try {
        const fs = t.options.fontSize;
        t.options.fontSize = fs + 1;
        t.options.fontSize = fs;
        applyGeometryRef.current?.();
        t.refresh(0, t.rows - 1);
      } catch {}
    };
    const onResume = () => {
      if (document.hidden) return;
      connectNowRef.current?.();
      remeasure();
    };
    const onRevive = () => connectNowRef.current?.();
    let mq = null;
    const onDprChange = () => { remeasure(); armDpr(); };
    const armDpr = () => {
      mq?.removeEventListener('change', onDprChange);
      mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`) ?? null;
      mq?.addEventListener('change', onDprChange);
    };
    armDpr();
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('online', onRevive);
    window.addEventListener(REVIVE_EVENT, onRevive);
    return () => {
      mq?.removeEventListener('change', onDprChange);
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('online', onRevive);
      window.removeEventListener(REVIVE_EVENT, onRevive);
    };
  }, [termReady]);

  // ReaderView drives geomRef itself (via onGeometry below) while it's
  // mounted, but nothing reverts it when reader mode turns off — without
  // this the PTY would stay at reader width/height after switching back to
  // the tiled grid.
  useEffect(() => {
    if (readerMode) return;
    if (geomRef.current.mode === 'reader') {
      geomRef.current = { mode: 'fit', cols: null, rows: null };
      applyGeometryRef.current?.();
    }
  }, [readerMode]);

  // Tapping into a just-focused reader pane (or ReaderView activating on an
  // already-connected pane) should retarget input the same way clicking the
  // live terminal does — otherwise _activeTerm.send still points at whatever
  // pane was focused before and MobileKeyRow types into an invisible one.
  useEffect(() => {
    if (readerMode && termReady) termRef.current?.textarea?.focus();
  }, [readerMode, termReady]);

  // Stable identities: ReaderView's recomputeGeometry/ResizeObserver effect
  // deps include these callbacks. An inline lambda here would get a fresh
  // identity on every ConsolePane render (every poll tick, theme toggle,
  // etc.), forcing that effect to tear down and re-fire unconditionally on
  // every unrelated re-render — a self-sustaining resize/extract loop.
  const handleReaderGeometry = useCallback((cols, rows) => {
    geomRef.current = { mode: 'reader', cols, rows };
    applyGeometryRef.current?.();
  }, []);
  const handleReaderTap = useCallback(() => {
    // Reader activation (line ~1972) already focuses the textarea, so a tap
    // often lands on an already-focused element — iOS Safari only raises the
    // soft keyboard on a focus *transition*, not on re-focusing the same
    // element. Force the transition with an explicit blur first.
    const ta = termRef.current?.textarea;
    if (!ta) return;
    claimAllTerminals();
    ta.blur();
    ta.focus();
  }, []);

  const termBg = lightMode ? LIGHT_TERM_THEME.background : DARK_TERM_THEME.background;

  // containerRef is the layout box PaneGrid positions/sizes; xtermHostRef is the
  // actual xterm render target, absolutely filling it. Reader mode hides the host
  // with opacity:0 (NOT visibility:hidden - that would make it unfocusable and
  // break tap-to-type; NOT display:none - that collapses it to 0x0 and FitAddon
  // would then compute garbage cols/rows) and overlays ReaderView on top instead.
  return h('div', {
    ref:   containerRef,
    style: { width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: termBg },
  },
    h('div', {
      ref:   xtermHostRef,
      style: {
        position: 'absolute', inset: 0, background: termBg,
        opacity:       readerMode ? 0    : 1,
        // Never an explicit 'auto': a descendant's auto overrides the hidden
        // panes view's pointer-events:none, and since that view stacks above
        // the dashboard it would swallow every dashboard click.
        pointerEvents: readerMode ? 'none' : undefined,
      },
      // Focus-follows-mouse, Linux-DE style. DOM focus only; the textarea's
      // focus listener retargets _activeTerm.send. Skipped mid-drag so a
      // selection crossing panes doesn't jump focus.
      onMouseEnter: HOVER_FOCUS && !readerMode
        ? e => { if (!e.buttons) termRef.current?.focus(); }
        : undefined,
      // Mouse moving over a pane another device took over while this one kept
      // focus: no focus event fires then, so claim here. Only a flag check
      // unless actually watching.
      onPointerDown: claimAllTerminals,
      onMouseMove: HOVER_FOCUS && !readerMode
        ? () => { if (watchRef.current.watching || !_device.active) claimAllTerminals(); }
        : undefined,
    }),
    readerMode ? h(ReaderView, {
      term:  termReady ? termRef.current : null,
      size:  readerSize,
      theme: lightMode ? LIGHT_TERM_THEME : DARK_TERM_THEME,
      lightMode,
      onGeometry: handleReaderGeometry,
      onTap: handleReaderTap,
    }) : null,
  );
}
