'use strict';

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  proxmox_host: 'https://192.168.68.10:8006',
  proxmox_node: 'pve',
  api_token: '',
  verify_ssl: false,
  panel_title: 'PROXMOX',
  panel_subtitle: 'STATUS PANEL',
  port: 3000,
  poll_interval_ms: 5000,
  lxc_names: {},
  lxc_order: [],
  gpus: [],
  show_gpus: false,
  max_net_mbps: 1000,
  lxc_grid_cols: 6,
};

let _config = null;

function loadConfig() {
  if (_config) return _config;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[config] Could not read config.json, using defaults:', e.message);
  }
  _config = Object.assign({}, DEFAULTS, raw);
  return _config;
}

function getConfig() {
  return loadConfig();
}

function getDisplayName(vmid, rawName) {
  const cfg = loadConfig();
  const name = (cfg.lxc_names && cfg.lxc_names[String(vmid)]) || rawName || String(vmid);
  return name.slice(0, 8);
}

function getPublicConfig() {
  const cfg = loadConfig();
  return {
    panel_title: cfg.panel_title,
    panel_subtitle: cfg.panel_subtitle,
    show_gpus: cfg.show_gpus,
    gpus: (cfg.gpus || []).map(g => ({
      id: g.id,
      display_name: g.display_name,
      vram_total_gb: g.vram_total_gb,
    })),
    lxc_grid_cols: cfg.lxc_grid_cols,
    max_net_mbps: cfg.max_net_mbps,
  };
}

module.exports = { getConfig, getDisplayName, getPublicConfig };
