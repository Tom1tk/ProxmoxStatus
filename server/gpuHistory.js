'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const GPU_STATS_FILE = '/mnt/gpu-stats/gpu_stats.txt';
const AUTOFAN_FILE   = '/mnt/gpu-stats/autofan_stats.txt';
const PERSIST_PATH   = '/var/lib/dashboard/gpu_history.json';
const POLL_MS        = 2000;
const PERSIST_MS     = 5 * 60 * 1000;
const MAX_SAMPLES    = 302400;   // 7 days at 2s resolution

// GPU indices to suppress from the panel (Quadro M2000 = display card only)
const HIDDEN_GPU_INDICES = [0];

// ─── Ring buffer state ────────────────────────────────────────────────────────
// Keyed by String(gpu.index)
const _bufs = {};
let _snapshot = [];   // last parsed rows from gpu_stats.txt (visible GPUs only)
let _autofan  = null;

// ─── Buffer helpers ───────────────────────────────────────────────────────────

function _makeBuffer(name) {
  return {
    name,
    head:  0,
    count: 0,
    ts:    new Float64Array(MAX_SAMPLES),
    temp:  new Float32Array(MAX_SAMPLES),
    power: new Float32Array(MAX_SAMPLES),
    util:  new Float32Array(MAX_SAMPLES),
    mem:   new Float32Array(MAX_SAMPLES),
    fan:   new Float32Array(MAX_SAMPLES),
  };
}

function _push(buf, ts, temp, power, util, mem, fan) {
  buf.ts[buf.head]    = ts;
  buf.temp[buf.head]  = temp;
  buf.power[buf.head] = power;
  buf.util[buf.head]  = util;
  buf.mem[buf.head]   = mem;
  buf.fan[buf.head]   = fan;
  buf.head = (buf.head + 1) % MAX_SAMPLES;
  if (buf.count < MAX_SAMPLES) buf.count++;
}

// Extract last `n` samples in chronological order (oldest first)
function _extract(buf, n) {
  n = Math.min(n, buf.count);
  if (n === 0) return { ts: [], temp: [], power: [], util: [], mem: [], fan: [] };

  const start = ((buf.head - n) % MAX_SAMPLES + MAX_SAMPLES) % MAX_SAMPLES;
  const ts    = new Array(n);
  const temp  = new Array(n);
  const power = new Array(n);
  const util  = new Array(n);
  const mem   = new Array(n);
  const fan   = new Array(n);

  for (let i = 0; i < n; i++) {
    const pos = (start + i) % MAX_SAMPLES;
    ts[i]    = buf.ts[pos];
    temp[i]  = buf.temp[pos];
    power[i] = buf.power[pos];
    util[i]  = buf.util[pos];
    mem[i]   = buf.mem[pos];
    fan[i]   = buf.fan[pos];
  }
  return { ts, temp, power, util, mem, fan };
}

// ─── File parsers ─────────────────────────────────────────────────────────────

function _parseGpuStats() {
  try {
    const text = fs.readFileSync(GPU_STATS_FILE, 'utf8');
    return text.trim().split('\n').map(line => {
      const p = line.split(',').map(s => s.trim());
      if (p.length < 7) return null;
      const index = parseInt(p[0]);
      if (isNaN(index) || HIDDEN_GPU_INDICES.includes(index)) return null;
      return {
        index,
        name:        p[1],
        temp:        parseFloat(p[2]) || 0,
        power_draw:  parseFloat(p[3]) || 0,
        power_limit: parseFloat(p[4]) || 0,
        gpu_util:    parseFloat(p[5]) || 0,
        mem_util:    parseFloat(p[6]) || 0,
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function _parseAutofan() {
  try {
    const line = fs.readFileSync(AUTOFAN_FILE, 'utf8').trim();
    const hm   = line.match(/hottest=(\d+)C/);
    const fm   = line.match(/fan=(\d+)%/);
    const sm   = line.match(/\d{2}:\d{2}:\d{2}\s+(\w+)/);
    return {
      raw:     line,
      hottest: hm ? parseInt(hm[1]) : null,
      fan:     fm ? parseInt(fm[1]) : null,
      status:  sm ? sm[1].toUpperCase() : 'UNKNOWN',
    };
  } catch {
    return null;
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────

function _poll() {
  const now  = Date.now();
  const gpus = _parseGpuStats();
  _autofan   = _parseAutofan();
  _snapshot  = gpus;

  const fanPct = (_autofan && _autofan.fan != null) ? _autofan.fan : 0;

  for (const gpu of gpus) {
    const key = String(gpu.index);
    if (!_bufs[key]) _bufs[key] = _makeBuffer(gpu.name);
    _push(_bufs[key], now, gpu.temp, gpu.power_draw, gpu.gpu_util, gpu.mem_util, fanPct);
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function _persist() {
  try {
    const dir = path.dirname(PERSIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const out = {};
    for (const [key, buf] of Object.entries(_bufs)) {
      const d    = _extract(buf, buf.count);
      out[key] = {
        name:  buf.name,
        count: buf.count,
        ts:    Array.from(d.ts),
        temp:  Array.from(d.temp),
        power: Array.from(d.power),
        util:  Array.from(d.util),
        mem:   Array.from(d.mem),
        fan:   Array.from(d.fan),
      };
    }
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(out));
  } catch (err) {
    console.warn('[gpuHistory] persist failed:', err.message);
  }
}

function _load() {
  try {
    const raw   = fs.readFileSync(PERSIST_PATH, 'utf8');
    const saved = JSON.parse(raw);
    for (const [key, d] of Object.entries(saved)) {
      const count = Math.min(d.count || 0, MAX_SAMPLES);
      const buf   = _makeBuffer(d.name);
      for (let i = 0; i < count; i++) {
        buf.ts[i]    = d.ts[i]    || 0;
        buf.temp[i]  = d.temp[i]  || 0;
        buf.power[i] = d.power[i] || 0;
        buf.util[i]  = d.util[i]  || 0;
        buf.mem[i]   = d.mem[i]   || 0;
        buf.fan[i]   = d.fan[i]   || 0;
      }
      buf.head  = count % MAX_SAMPLES;
      buf.count = count;
      _bufs[key] = buf;
    }
    console.log('[gpuHistory] restored', Object.keys(saved).length, 'GPU(s) from disk');
  } catch {
    console.log('[gpuHistory] no saved history, starting fresh');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getCurrentGpuStats() {
  return {
    gpus: _snapshot.map(gpu => ({
      index:       gpu.index,
      name:        gpu.name,
      temp:        gpu.temp,
      power_draw:  gpu.power_draw,
      power_limit: gpu.power_limit,
      gpu_util:    gpu.gpu_util,
      mem_util:    gpu.mem_util,
      fan_pct:     (_autofan && _autofan.fan != null) ? _autofan.fan : null,
    })),
    autofan: _autofan,
  };
}

function getHistory(windowSeconds) {
  const n      = Math.ceil((windowSeconds * 1000) / POLL_MS);
  const result = {};
  for (const [key, buf] of Object.entries(_bufs)) {
    const d     = _extract(buf, n);
    result[key] = { name: buf.name, ...d };
  }
  return result;
}

function startPolling() {
  _load();
  _poll();
  setInterval(_poll, POLL_MS);
  setInterval(_persist, PERSIST_MS);
  console.log('[gpuHistory] polling started (hidden indices:', HIDDEN_GPU_INDICES.join(', '), ')');
}

module.exports = { startPolling, getCurrentGpuStats, getHistory };
