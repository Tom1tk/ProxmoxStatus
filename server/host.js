'use strict';

const fetch = require('node-fetch');
const { getConfig } = require('./config');

let _gpuCache = null;
let _tempCache = null;

function buildStaticGpus(stale = false) {
  const cfg = getConfig();
  return (cfg.gpus || []).map(g => ({
    id:            `gpu${g.index}`,
    index:         g.index,
    display_name:  g.display_name,
    vram_used_gb:  null,
    vram_total_gb: g.vram_total_gb,
    vram_pct:      null,
    gpu_util:      null,
    temp:          null,
    process:       null,
    power_w:       null,
    stale,
  }));
}

function getGpuDisplayName(index, rawName) {
  const cfg = getConfig();
  const entry = (cfg.gpus || []).find(g => g.index === index);
  if (entry && entry.display_name) return entry.display_name;
  if (rawName) return rawName.slice(0, 14);
  return `GPU ${index}`;
}

async function _poll() {
  const cfg = getConfig();
  const url = cfg.host_exporter_url;
  if (!url) {
    _gpuCache = buildStaticGpus();
    _tempCache = null;
    return;
  }

  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    _gpuCache = data.gpus && data.gpus.length > 0
      ? data.gpus.map(gpu => ({
          id:            `gpu${gpu.index}`,
          index:         gpu.index,
          display_name:  getGpuDisplayName(gpu.index, gpu.name),
          vram_used_gb:  gpu.vram_used_gb,
          vram_total_gb: gpu.vram_total_gb,
          vram_pct:      gpu.vram_pct,
          gpu_util:      gpu.gpu_util,
          temp:          gpu.temp_c,
          process:       gpu.process,
          power_w:       gpu.power_draw_w,
          stale:         data.stale || false,
        }))
      : buildStaticGpus(true);

    _tempCache = data.temps || null;

  } catch (err) {
    console.warn(`[host] Exporter unreachable: ${err.message}`);
    if (_gpuCache) {
      _gpuCache = _gpuCache.map(g => ({ ...g, stale: true }));
    } else {
      _gpuCache = buildStaticGpus(true);
    }
    // retain last known temp on error
  }
}

function startPolling() {
  const cfg = getConfig();
  _poll();
  setInterval(_poll, cfg.host_exporter_poll_ms || 5000);
}

function getGpuCache() {
  return _gpuCache || buildStaticGpus(true);
}

function getTempCache() {
  return _tempCache;
}

module.exports = { startPolling, getGpuCache, getTempCache };
