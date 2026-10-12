'use strict';

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const ENV_PATH    = path.join(__dirname, '..', '.env');

// Load .env before anything else so env vars are available to loadConfig().
// Only sets variables that aren't already in the environment (process.env wins).
// No external dependency — parses KEY=value lines, strips " # inline comments"
// (a # with no space before it is part of the value, e.g. a password).
(function loadDotEnv() {
  try {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/\s+#.*$/, '').trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* .env is optional */ }
}());

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
  gpus: [],
  show_gpus: false,
  max_net_mbps: 1000,
  lxc_grid_cols: 6,
  // Terminal panes — PVE user the server logs in as (prefer .env)
  pve_username: '',      // e.g. dashboard@pve
  pve_password: '',      // PVE user password (not the API token)
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
  // Secrets override config.json values when set in the environment / .env
  if (process.env.PVE_PASSWORD)  _config.pve_password  = process.env.PVE_PASSWORD;
  if (process.env.PVE_USERNAME)  _config.pve_username  = process.env.PVE_USERNAME;
  if (process.env.PVE_API_TOKEN) _config.api_token     = process.env.PVE_API_TOKEN;
  return _config;
}

function getConfig() {
  return loadConfig();
}

function getDisplayName(vmid, rawName) {
  const cfg = loadConfig();
  const name = (cfg.lxc_names && cfg.lxc_names[String(vmid)]) || rawName || String(vmid);
  return name;
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
