'use strict';

const fetch      = require('node-fetch');
const { getConfig } = require('./config');
const gpuHistory = require('./gpuHistory');

let _gpuCache = null;
let _tempCache = null;

function getGpuDisplayName(index, rawName) {
  const cfg = getConfig();
  const entry = (cfg.gpus || []).find(g => g.index === index);
  if (entry && entry.display_name) return entry.display_name;
  if (rawName) return rawName.slice(0, 16);
  return `GPU ${index}`;
}

function _buildGpuCache() {
  const { gpus } = gpuHistory.getCurrentGpuStats();
  return gpus.map(gpu => ({
    id:           `gpu${gpu.index}`,
    index:        gpu.index,
    display_name: getGpuDisplayName(gpu.index, gpu.name),
    gpu_util:     gpu.gpu_util,
    temp:         gpu.temp,
    mem_util:     gpu.mem_util,
    power_w:      gpu.power_draw,
    power_limit:  gpu.power_limit,
    fan_pct:      gpu.fan_pct,
  }));
}

async function _poll() {
  const cfg = getConfig();
  const url = cfg.host_exporter_url;

  _gpuCache = _buildGpuCache();

  if (!url) {
    _tempCache = null;
    return;
  }

  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _tempCache = data.temps || null;
  } catch (err) {
    console.warn(`[host] Exporter unreachable: ${err.message}`);
  }
}

function startPolling() {
  const cfg = getConfig();
  _poll();
  setInterval(_poll, cfg.host_exporter_poll_ms || 5000);
}

function getGpuCache() {
  return _gpuCache || [];
}

function getTempCache() {
  return _tempCache;
}

module.exports = { startPolling, getGpuCache, getTempCache };
