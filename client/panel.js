import { h, render } from 'https://esm.sh/preact@10';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10/hooks';
import htm from 'https://esm.sh/htm@3';

const html = htm.bind(h);

// ─── Colour palette ──────────────────────────────────────────────────────────
const C = {
  bg:        '#050504',
  panel:     '#0c0b09',
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
function LedBar({ value, segments = 20, warn = 0.7, crit = 0.9, width = 80, height = 10, color }) {
  const filled = Math.round((value || 0) * segments);
  const segs = [];
  const segW = Math.floor((width - segments + 1) / segments);
  const gap = 1;

  for (let i = 0; i < segments; i++) {
    const on = i < filled;
    let fill = C.dimmer;
    if (on) {
      if (color) fill = color;
      else if (i / segments >= crit) fill = C.red;
      else if (i / segments >= warn) fill = C.amberHi;
      else fill = C.greenHi;
    }
    segs.push(h('rect', {
      key: i,
      x: i * (segW + gap),
      y: 0,
      width: segW,
      height,
      fill,
    }));
  }

  return html`
    <svg width=${width} height=${height} style="display:block;flex-shrink:0">
      ${segs}
    </svg>
  `;
}

// ─── NetTicker ───────────────────────────────────────────────────────────────
function NetTicker({ mbps, maxMbps, label }) {
  const dotsRef = useRef([]);
  const containerRef = useRef(null);
  const mbpsRef = useRef(mbps);
  const maxRef = useRef(maxMbps);

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
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: C.greenHi,
        opacity: 0.12,
        margin: '0 1px',
        verticalAlign: 'middle',
      },
    })
  );

  return html`
    <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:${C.dim}">
      <span style="color:${C.dim}">${label}</span>
      <span ref=${containerRef} style="display:inline-flex;align-items:center">${dots}</span>
      <span style="color:${C.white};min-width:40px;text-align:right">${fmt(mbps, 2)}<span style="color:${C.dim}">MB/s</span></span>
    </span>
  `;
}

// ─── HeaderBar ───────────────────────────────────────────────────────────────
function HeaderBar({ node, lxcs, config }) {
  if (!node) return html`<div style="height:36px;border-bottom:1px solid ${C.borderDim}"></div>`;

  const cpuPct = node.cpu || 0;
  const memPct = node.mem_total ? node.mem_used / node.mem_total : 0;
  const netInMbps = bytesToMbps(node.net_in);
  const netOutMbps = bytesToMbps(node.net_out);
  const maxMbps = config ? config.max_net_mbps : 1000;
  const activeCount = lxcs.filter(l => l.status === 'running').length;

  const tempColor = node.cpu_temp == null ? C.dim
    : node.cpu_temp >= 80 ? C.red
    : node.cpu_temp >= 65 ? C.amberHi
    : C.white;

  return html`
    <div style="
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      border-bottom: 1px solid ${C.border};
      background: ${C.panel};
      font-size: 11px;
      flex-wrap: nowrap;
      overflow: hidden;
    ">
      <!-- Hostname -->
      <span style="color:${C.amberHi};font-weight:bold;flex-shrink:0;letter-spacing:1px">
        ${config ? config.panel_title : 'HOST'}
      </span>

      <span style="color:${C.borderDim}">│</span>

      <!-- CPU -->
      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim}">CPU</span>
        ${h(LedBar, { value: cpuPct, width: 60, height: 8 })}
        <span style="color:${C.white};min-width:28px">${pct(cpuPct)}%</span>
      </span>

      <!-- MEM -->
      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim}">MEM</span>
        ${h(LedBar, { value: memPct, width: 60, height: 8, color: C.blueHi })}
        <span style="color:${C.white};min-width:28px">${pct(memPct)}%</span>
      </span>

      <span style="color:${C.borderDim}">│</span>

      <!-- TEMP -->
      ${node.cpu_temp != null ? html`
        <span style="flex-shrink:0">
          <span style="color:${C.dim}">TEMP </span>
          <span style="color:${tempColor}">${Math.round(node.cpu_temp)}°C</span>
        </span>
        <span style="color:${C.borderDim}">│</span>
      ` : null}

      <!-- Network -->
      ${h(NetTicker, { mbps: netInMbps, maxMbps, label: '↓' })}
      ${h(NetTicker, { mbps: netOutMbps, maxMbps, label: '↑' })}

      <span style="color:${C.borderDim}">│</span>

      <!-- Uptime -->
      <span style="flex-shrink:0;color:${C.dim}">
        UP <span style="color:${C.white}">${formatUptime(node.uptime)}</span>
      </span>

      <!-- Active count -->
      <span style="flex-shrink:0;color:${C.dim}">
        <span style="color:${C.greenHi}">${activeCount}</span>/<span style="color:${C.white}">${lxcs.length}</span>
        <span> LXC</span>
      </span>
    </div>
  `;
}

// ─── LxcCell ─────────────────────────────────────────────────────────────────
function LxcCell({ lxc, flickerRef }) {
  const cellRef = useRef(null);
  const vmid = lxc.vmid;

  // Apply flicker on 80ms interval via direct DOM
  useEffect(() => {
    const id = setInterval(() => {
      if (!cellRef.current) return;
      const brightness = flickerRef.current[vmid] ?? 1;
      cellRef.current.style.opacity = String(brightness);
    }, 80);
    return () => clearInterval(id);
  }, [vmid]);

  const isRunning = lxc.status === 'running';
  const ioTotal = (lxc.disk_read || 0) + (lxc.disk_write || 0);
  const ioActive = isRunning && ioTotal > 0;

  const lampColor  = !isRunning ? C.dimmer : ioActive ? C.amberHi : C.greenHi;
  const borderColor = !isRunning ? C.borderDim : ioActive ? C.amber : C.green;
  const glowColor  = !isRunning ? 'none' : ioActive
    ? `0 0 8px ${C.amber}88`
    : `0 0 8px ${C.green}88`;

  return html`
    <div style="
      position: relative;
      display: flex;
      flex-direction: column;
      border: 1px solid ${borderColor};
      background: ${C.panel};
      box-shadow: ${glowColor};
      aspect-ratio: 0.75;
      overflow: hidden;
    ">
      <!-- IO pip -->
      ${ioActive ? html`
        <div style="
          position: absolute;
          top: 3px;
          right: 3px;
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: ${C.amberHi};
          box-shadow: 0 0 4px ${C.amberHi};
          z-index: 2;
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
        position: relative;
      ">
        <div style="
          width: 60%;
          height: 60%;
          border-radius: 4px;
          background: ${lampColor}${isRunning ? '30' : '10'};
          border: 1px solid ${lampColor}${isRunning ? '80' : '20'};
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <span style="
            font-size: 8px;
            color: ${isRunning ? lampColor : C.dimmer};
            opacity: 0.85;
            letter-spacing: 0;
            user-select: none;
          ">${lxc.vmid}</span>
        </div>
      </div>

      <!-- Name strip -->
      <div style="
        padding: 2px 0;
        text-align: center;
        font-size: 9px;
        letter-spacing: 0.5px;
        color: ${isRunning ? C.white : C.dim};
        background: ${C.bg};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">
        ${lxc.display_name || lxc.name || lxc.vmid}
      </div>
    </div>
  `;
}

// ─── LxcGrid ─────────────────────────────────────────────────────────────────
function LxcGrid({ lxcs, cols, flickerRef }) {
  return html`
    <div style="
      display: grid;
      grid-template-columns: repeat(${cols}, 1fr);
      gap: 6px;
      padding: 10px;
    ">
      ${lxcs.map(lxc => h(LxcCell, { key: lxc.vmid, lxc, flickerRef }))}
    </div>
  `;
}

// ─── GpuRow ──────────────────────────────────────────────────────────────────
function GpuRow({ gpu }) {
  const hasData = gpu.gpu_util != null;
  const vramPct = (gpu.vram_total_gb && gpu.vram_used_gb != null)
    ? gpu.vram_used_gb / gpu.vram_total_gb : 0;
  const utilPct = (gpu.gpu_util || 0) / 100;

  return html`
    <div style="
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border-top: 1px solid ${C.borderDim};
      font-size: 11px;
    ">
      <!-- Name OLED -->
      <div style="
        background: #000;
        border: 1px solid ${C.borderDim};
        padding: 2px 6px;
        min-width: 90px;
        color: ${C.purpleHi};
        font-size: 10px;
        letter-spacing: 1px;
        flex-shrink: 0;
      ">${gpu.display_name}</div>

      <!-- Stats -->
      <span style="color:${C.dim};flex-shrink:0">
        ${hasData ? html`
          <span style="color:${C.white}">${gpu.gpu_util}%</span>
          <span> util · </span>
          <span style="color:${gpu.temp >= 80 ? C.red : gpu.temp >= 65 ? C.amberHi : C.white}">${gpu.temp}°C</span>
          <span> · </span>
          <span style="color:${C.tealHi}">${gpu.process || '—'}</span>
        ` : html`<span style="color:${C.dimmer}">NO DATA</span>`}
      </span>

      <span style="flex:1"></span>

      <!-- VRAM bar -->
      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim};font-size:10px">VRAM</span>
        ${h(LedBar, { value: vramPct, width: 70, height: 8, color: C.purpleHi, warn: 0.8, crit: 0.95 })}
        <span style="color:${C.white};min-width:36px;font-size:10px">
          ${hasData && gpu.vram_used_gb != null ? fmt(gpu.vram_used_gb, 1) : '--'}/${gpu.vram_total_gb || '--'}G
        </span>
      </span>

      <!-- UTIL bar -->
      <span style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="color:${C.dim};font-size:10px">UTIL</span>
        ${h(LedBar, { value: utilPct, width: 50, height: 8, color: C.tealHi, warn: 0.8, crit: 0.95 })}
      </span>
    </div>
  `;
}

function GpuSection({ gpus, show }) {
  if (!show || !gpus || gpus.length === 0) return null;
  return html`
    <div style="border-top:1px solid ${C.border}">
      ${gpus.map(g => h(GpuRow, { key: g.id, gpu: g }))}
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
      position: absolute;
      inset: 0;
      background: ${C.bg}cc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 100;
      border: 2px solid ${flash ? C.red : C.borderDim};
    ">
      <div style="color:${C.red};font-size:18px;letter-spacing:3px;font-weight:bold">CONNECTION LOST</div>
      <div style="color:${C.dim};font-size:11px;margin-top:8px">last update: ${timeSince(lastUpdate)} ago</div>
      <div style="color:${C.dim};font-size:11px;margin-top:4px">retrying...</div>
    </div>
  `;
}

// ─── Footer ──────────────────────────────────────────────────────────────────
function Footer({ config }) {
  return html`
    <div style="
      padding: 4px 10px;
      border-top: 1px solid ${C.borderDim};
      font-size: 9px;
      color: ${C.dimmer};
      display: flex;
      justify-content: space-between;
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
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [failCount, setFailCount] = useState(0);
  const flickerRef = useRef({});   // vmid → brightness 0–1
  const lxcsRef = useRef([]);

  // Fetch config once
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setConfig)
      .catch(() => {});
  }, []);

  // Poll status
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

  // Flicker engine — 80ms, uses ref to avoid re-renders
  useEffect(() => {
    const id = setInterval(() => {
      flickerRef.current = computeFlicker(lxcsRef.current, flickerRef.current);
    }, 80);
    return () => clearInterval(id);
  }, []);

  const disconnected = failCount >= 3;
  const lxcs = status ? (status.lxcs || []) : [];
  const gpus = status ? (status.gpus || []) : [];
  const cols = config ? (config.lxc_grid_cols || 6) : 6;
  const showGpus = config ? config.show_gpus : false;

  return html`
    <div style="width:100%;max-width:900px;position:relative">
      <!-- Connection overlay -->
      ${disconnected ? h(ConnectionOverlay, { lastUpdate }) : null}

      <!-- Panel -->
      <div style="
        background: ${C.panel};
        border: 1px solid ${C.border};
        box-shadow: 0 0 30px #000a;
      ">
        ${h(HeaderBar, { node: status ? status.node : null, lxcs, config })}
        ${h(LxcGrid, { lxcs, cols, flickerRef })}
        ${h(GpuSection, { gpus, show: showGpus })}
        ${h(Footer, { config })}
      </div>
    </div>
  `;
}

// ─── Mount ───────────────────────────────────────────────────────────────────
render(h(App, null), document.getElementById('app'));
