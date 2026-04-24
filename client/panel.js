import { h, render } from 'https://esm.sh/preact@10';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10/hooks';
import htm from 'https://esm.sh/htm@3';

const html = htm.bind(h);

// ─── Colour palette ──────────────────────────────────────────────────────────
const C = {
  bg:        '#000000',
  panel:     '#000000',
  border:    '#3a3530',
  borderDim: '#1e1c18',
  white:     '#d8d0c0',
  dim:       '#4a4540',
  dimmer:    '#252220',
  red:       '#cc1a1a',
  amber:     '#c87010',
  amberHi:   '#e8a030',
  green:     '#30a050',
  greenHi:   '#40cc60',
  blueHi:    '#40a0e0',
  purpleHi:  '#a060f0',
  tealHi:    '#30d0b8',
};

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
function NetTicker({ mbps, maxMbps, label }) {
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
    <span style="display:inline-flex;align-items:center;gap:4px;font-size:clamp(11px,1.1vw,15px);color:${C.dim}">
      <span>${label}</span>
      <span style="display:inline-flex;align-items:center">${dots}</span>
      <span style="color:${C.white};min-width:38px;text-align:right">${fmt(mbps, 2)}<span style="color:${C.dim}">MB/s</span></span>
    </span>
  `;
}

// ─── HeaderBar ───────────────────────────────────────────────────────────────
function HeaderBar({ node, lxcs, config }) {
  if (!node) return html`<div style="height:2.4em;border-bottom:1px solid ${C.borderDim}"></div>`;

  const cpuPct    = node.cpu || 0;
  const memPct    = node.mem_total ? node.mem_used / node.mem_total : 0;
  const netInMbps = bytesToMbps(node.net_in);
  const netOutMbps= bytesToMbps(node.net_out);
  const maxMbps   = config ? config.max_net_mbps : 1000;
  const activeCount = lxcs.filter(l => l.status === 'running').length;

  const tempColor = node.cpu_temp == null ? C.dim
    : node.cpu_temp >= 80 ? C.red
    : node.cpu_temp >= 65 ? C.amberHi
    : C.white;

  const fs = 'clamp(11px,1.15vw,16px)';

  return html`
    <div style="
      display: flex;
      align-items: center;
      gap: clamp(6px,0.8vw,14px);
      padding: clamp(8px,1vh,16px) clamp(6px,0.8vw,12px);
      border-bottom: 1px solid ${C.border};
      background: ${C.panel};
      font-size: ${fs};
      flex-wrap: nowrap;
      overflow: hidden;
      flex-shrink: 0;
    ">
      <span style="color:${C.amberHi};font-weight:bold;flex-shrink:0;letter-spacing:1px">
        ${config ? config.panel_title : 'HOST'}
      </span>

      <span style="color:${C.borderDim}">│</span>

      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim}">CPU</span>
        ${h(LedBar, { value: cpuPct, width: 60, height: 8 })}
        <span style="color:${C.white};min-width:26px">${pct(cpuPct)}%</span>
      </span>

      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim}">MEM</span>
        ${h(LedBar, { value: memPct, width: 60, height: 8, color: C.blueHi })}
        <span style="color:${C.white};min-width:26px">${pct(memPct)}%</span>
      </span>

      <span style="color:${C.borderDim}">│</span>

      ${node.cpu_temp != null ? html`
        <span style="flex-shrink:0">
          <span style="color:${C.dim}">TEMP </span>
          <span style="color:${tempColor}">${Math.round(node.cpu_temp)}°C</span>
        </span>
        <span style="color:${C.borderDim}">│</span>
      ` : null}

      ${h(NetTicker, { mbps: netInMbps, maxMbps, label: '↓' })}
      ${h(NetTicker, { mbps: netOutMbps, maxMbps, label: '↑' })}

      <span style="color:${C.borderDim}">│</span>

      <span style="flex-shrink:0;color:${C.dim}">
        UP <span style="color:${C.white}">${formatUptime(node.uptime)}</span>
      </span>

      <span style="flex-shrink:0;color:${C.dim}">
        <span style="color:${C.greenHi}">${activeCount}</span>/<span style="color:${C.white}">${lxcs.length}</span> LXC
      </span>
    </div>
  `;
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
          background: #00000090;
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
                    background: isActive ? col + '28' : 'transparent',
                    border: `1px solid ${isActive ? col : col + '66'}`,
                    color: isActive ? col : col + 'bb',
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
function GpuRow({ gpu }) {
  const hasData = gpu.gpu_util != null;
  const vramPct = (gpu.vram_total_gb && gpu.vram_used_gb != null)
    ? gpu.vram_used_gb / gpu.vram_total_gb : 0;
  const utilPct = (gpu.gpu_util || 0) / 100;
  const labelW  = 'clamp(28px,3vw,44px)';
  const valW    = 'clamp(32px,4vw,56px)';
  const barH    = 'clamp(6px,0.8vh,11px)';

  return html`
    <div style="
      padding: clamp(4px,0.5vh,8px) clamp(6px,0.8vw,12px);
      border-top: 1px solid ${C.borderDim};
      font-size: clamp(11px,1.1vw,15px);
    ">
      <!-- Top row: name OLED + live stats -->
      <div style="display:flex;align-items:center;gap:clamp(6px,0.8vw,12px);margin-bottom:clamp(3px,0.4vh,6px)">
        <div style="
          background:#000;border:1px solid ${C.borderDim};
          padding:2px clamp(4px,0.5vw,8px);
          color:${C.purpleHi};font-size:clamp(10px,1.05vw,14px);
          letter-spacing:1px;flex-shrink:0;white-space:nowrap;
        ">${gpu.display_name}</div>

        ${hasData ? html`
          <span style="color:${C.white}">${gpu.gpu_util}%</span>
          <span style="color:${C.dim}">util ·</span>
          <span style="color:${gpu.temp >= 80 ? C.red : gpu.temp >= 65 ? C.amberHi : C.white}">${gpu.temp}°C</span>
          ${gpu.process ? html`<span style="color:${C.dim}">·</span><span style="color:${C.tealHi}">${gpu.process}</span>` : null}
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

      <!-- VRAM bar — full width -->
      <div style="display:flex;align-items:center;gap:6px">
        <span style="width:${labelW};flex-shrink:0;color:${C.dim};font-size:clamp(10px,1vw,13px)">VRAM</span>
        ${h(LedBar, { value: vramPct, fluid: true, height: parseInt(barH) || 8, color: C.purpleHi, warn: 0.8, crit: 0.95, segments: 30 })}
        <span style="width:${valW};flex-shrink:0;text-align:right;color:${C.white};font-size:clamp(10px,1vw,13px)">
          ${hasData && gpu.vram_used_gb != null ? fmt(gpu.vram_used_gb, 1) : '--'}/${gpu.vram_total_gb || '--'}G
        </span>
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
  { label: '24h', seconds: 86400 },
  { label: '7d',  seconds: 604800 },
];

function tempColorForValue(v) {
  if (v <= 50) return C.greenHi;
  if (v <= 70) return C.amberHi;
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
function drawGpuHistory(canvas, gpuData, powerLimit) {
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  const ts = gpuData && gpuData.ts;
  if (!ts || ts.length < 2) {
    ctx.fillStyle = C.dim;
    ctx.font      = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('NO HISTORY', W / 2, H / 2);
    return;
  }

  const maxPwr = powerLimit || 200;
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
    ctx.strokeStyle = '#1e1c18';
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
    ctx.fillStyle = '#4a4540';
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
  ctx.fillStyle = '#252220';
  ctx.textAlign = 'left';
  ctx.fillText(relTime(ageMs) + ' ago', 3, H - 2);
  ctx.textAlign = 'right';
  ctx.fillText('now', W - 3, H - 2);
}

// ─── GpuDetailPanel ──────────────────────────────────────────────────────────
function GpuDetailPanel() {
  const [current,   setCurrent]   = useState({ gpus: [], autofan: null });
  const [history,   setHistory]   = useState({});
  const [windowSec, setWindowSec] = useState(300);
  const canvasRefs = useRef({});

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
        const gpu = (current.gpus || []).find(g => String(g.index) === idx);
        drawGpuHistory(canvas, gpuData, gpu ? gpu.power_limit : 200);
      });
    });
    return () => cancelAnimationFrame(rafId);
  }, [history, current]);

  const { gpus, autofan } = current;
  const fs2 = 'clamp(10px,1vw,14px)';
  const fs3 = 'clamp(9px,0.9vw,13px)';
  const afCol = autofan
    ? (autofan.status === 'OK' ? C.greenHi : autofan.status === 'WARN' ? C.amberHi : C.red)
    : C.dimmer;
  const afBorder = autofan
    ? (autofan.status === 'OK' ? C.green : autofan.status === 'WARN' ? C.amber : C.red)
    : C.dimmer;

  return html`
    <div style="padding:clamp(4px,0.5vh,8px) clamp(6px,0.8vw,10px);display:flex;flex-direction:column;gap:clamp(3px,0.4vh,5px)">

      <!-- Autofan status line -->
      <div style="font-size:${fs2};display:flex;gap:6px;align-items:center;padding-bottom:clamp(2px,0.3vh,4px);border-bottom:1px solid ${C.borderDim};flex-wrap:nowrap;overflow:hidden">
        <span style="color:${C.dim};flex-shrink:0">AUTOFAN</span>
        ${autofan ? html`
          <span style="color:${C.dim}">·</span>
          <span style="color:${C.dim};flex-shrink:0">hottest:</span>
          <span style="color:${autofan.hottest != null ? tempColorForValue(autofan.hottest) : C.dim};flex-shrink:0">
            ${autofan.hottest != null ? autofan.hottest + '°C' : '--'}
          </span>
          <span style="color:${C.dim}">fan:</span>
          <span style="color:${C.amberHi};flex-shrink:0">${autofan.fan != null ? autofan.fan + '%' : '--'}</span>
          <span style="
            padding:0 5px;
            border:1px solid ${afBorder};
            color:${afCol};
            font-size:clamp(8px,0.8vw,11px);
            letter-spacing:1px;
            flex-shrink:0;
          ">${autofan.status}</span>
        ` : html`<span style="color:${C.dimmer}">— NO DATA</span>`}
      </div>

      <!-- Live table -->
      <div style="font-size:${fs3}">
        <div style="display:grid;grid-template-columns:2.5em 1fr 3.5em 6.5em 3em 3em 3em;gap:3px 6px;color:${C.dim};padding-bottom:2px;border-bottom:1px solid ${C.borderDim};letter-spacing:0.3px">
          <span>IDX</span><span>NAME</span><span>TEMP</span><span>POWER</span><span>GPU%</span><span>MEM%</span><span>FAN%</span>
        </div>
        ${!gpus || gpus.length === 0 ? html`
          <div style="color:${C.dimmer};padding:4px 0">NO GPU DATA</div>
        ` : gpus.map(gpu => html`
          <div key=${gpu.index} style="display:grid;grid-template-columns:2.5em 1fr 3.5em 6.5em 3em 3em 3em;gap:3px 6px;padding:2px 0;align-items:center;color:${C.white}">
            <span style="color:${C.dim}">${gpu.index}</span>
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${C.purpleHi}">${gpu.name || '--'}</span>
            <span style="color:${tempColorForValue(gpu.temp || 0)}">${gpu.temp != null ? gpu.temp + '°C' : '--'}</span>
            <span style="color:${C.tealHi}">${gpu.power_draw != null ? fmt(gpu.power_draw, 0) : '--'}/${gpu.power_limit != null ? fmt(gpu.power_limit, 0) : '--'}W</span>
            <span>${gpu.gpu_util != null ? gpu.gpu_util + '%' : '--'}</span>
            <span>${gpu.mem_util != null ? gpu.mem_util + '%' : '--'}</span>
            <span style="color:${C.amberHi}">${gpu.fan_pct != null ? gpu.fan_pct + '%' : '--'}</span>
          </div>
        `)}
      </div>

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

      <!-- History graphs, one per GPU -->
      ${Object.entries(history).sort(([a],[b]) => Number(a) - Number(b)).map(([idx, gpuData]) => html`
        <div key=${idx} style="border:1px solid ${C.borderDim};overflow:hidden;flex-shrink:0">
          <div style="padding:2px 4px;font-size:clamp(8px,0.8vw,11px);color:${C.purpleHi};border-bottom:1px solid ${C.borderDim};background:#00000040;letter-spacing:0.5px">
            ${gpuData.name || 'GPU ' + idx}
          </div>
          <canvas
            ref=${el => { if (el) canvasRefs.current[idx] = el; }}
            style="display:block;width:100%;height:140px"
            width="1200"
            height="140"
          />
        </div>
      `)}
    </div>
  `;
}

// ─── GpuSection ───────────────────────────────────────────────────────────────
function GpuSection({ gpus, show }) {
  if (!show) return null;
  return html`
    <div style="border-top:1px solid ${C.border};flex-shrink:0;display:flex;min-height:0">
      <!-- Left 30%: existing compact GPU summary rows -->
      <div style="width:30%;min-width:0;border-right:1px solid ${C.borderDim};flex-shrink:0">
        ${gpus && gpus.length > 0
          ? gpus.map(g => h(GpuRow, { key: g.id || g.index, gpu: g }))
          : html`<div style="padding:8px;color:${C.dimmer};font-size:clamp(10px,1vw,13px)">NO GPU</div>`
        }
      </div>
      <!-- Right 70%: GPU detail panel with live table + history graphs -->
      <div style="flex:1;min-width:0;overflow-y:auto">
        ${h(GpuDetailPanel, {})}
      </div>
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
function Footer({ config }) {
  return html`
    <div style="
      padding: clamp(5px,0.7vh,10px) clamp(6px,0.8vw,12px);
      border-top:1px solid ${C.borderDim};
      font-size:clamp(9px,0.95vw,13px);
      color:${C.dimmer};
      display:flex;justify-content:space-between;
      flex-shrink:0;
    ">
      <span>PROXMOX STATUS PANEL</span>
      <span>${config ? config.panel_subtitle : 'PROXMOX'}</span>
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

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
  const [status,     setStatus]     = useState(null);
  const [config,     setConfig]     = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [failCount,  setFailCount]  = useState(0);
  const [winW,       setWinW]       = useState(window.innerWidth);
  const [winH,       setWinH]       = useState(window.innerHeight);
  const [openVmid,   setOpenVmid]   = useState(null);
  const flickerRef = useRef({});
  const lxcsRef    = useRef([]);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const onResize = () => { setWinW(window.innerWidth); setWinH(window.innerHeight); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close open cell when clicking anywhere outside a cell
  useEffect(() => {
    const close = () => setOpenVmid(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

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

  const disconnected = failCount >= 3;
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
        box-shadow:0 0 40px #000c;
        overflow:hidden;
        position:relative;
        min-height:0;
      ">
        ${disconnected ? h(ConnectionOverlay, { lastUpdate }) : null}
        ${h(HeaderBar, { node: status ? status.node : null, lxcs, config })}
        ${h(LxcGrid, { lxcs, cols, flickerRef, openVmid, setOpenVmid })}
        ${h(GpuSection, { gpus, show: showGpus })}
        ${h(Footer, { config })}
      </div>
    </div>
  `;
}

// ─── Mount ───────────────────────────────────────────────────────────────────
render(h(App, null), document.getElementById('app'));
