'use strict';

const path = require('path');
const express = require('express');
const { getConfig, getPublicConfig } = require('./config');
const ProxmoxClient = require('./proxmox');
const host = require('./host');
const gpuHistory = require('./gpuHistory');
const consoleAuth      = require('./console');
const paneStore        = require('./paneStore');
const { createTermProxyServer } = require('./termProxy');

const app = express();
app.use(express.json());
const client = new ProxmoxClient();

// Static files — no-cache so browser always gets fresh assets
app.use(express.static(path.join(__dirname, '..', 'client'), {
  setHeaders(res) {
    res.set('Cache-Control', 'no-store');
  },
}));

// API endpoints
app.get('/api/status', (req, res) => {
  const px = client.getCachedStatus();
  const temp = host.getTempCache();
  res.json({
    ...px,
    node: px.node ? {
      ...px.node,
      cpu_temp: temp ? temp.package_temp : null,
    } : null,
    gpus: host.getGpuCache(),
  });
});

app.get('/api/config', (req, res) => {
  res.json(getPublicConfig());
});

const ALLOWED_ACTIONS = new Set(['start', 'shutdown', 'reboot']);

app.post('/api/lxc/:vmid/:action', async (req, res) => {
  const { vmid, action } = req.params;
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ success: false, error: 'Invalid action' });
  }
  try {
    const result = await client.executeAction(vmid, action);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[panel] Action ${action} on LXC ${vmid} failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/gpu/current', (req, res) => {
  res.json(gpuHistory.getCurrentGpuStats());
});

app.get('/api/gpu/history', (req, res) => {
  const win = Math.min(604800, Math.max(60, parseInt(req.query.window) || 300));
  res.json(gpuHistory.getHistory(win));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Console session — verifies Proxmox credentials are working.
// NOTE: we deliberately do NOT set PVEAuthCookie here. Setting it with
// Domain=.endless777.online would affect prox.endless777.online too, overwriting
// the user's root@pam session with the limited dashboard@pve account → 403 everywhere.
// Console iframes instead rely on the browser's existing Proxmox session cookie.
app.get('/api/console/session', async (req, res) => {
  const cfg = getConfig();
  if (!cfg.console_base_url || !cfg.pve_username || !cfg.pve_password) {
    return res.status(503).json({
      ok: false,
      error: 'Console credentials not configured (pve_username / pve_password missing from .env)',
    });
  }
  try {
    const { expires } = await consoleAuth.getTicket();
    res.json({ ok: true, expires });
  } catch (err) {
    console.error('[panel] Console session error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Agent-facing convenience endpoints ────────────────────────────────────

// Manifest — call this first to discover all endpoints and their semantics
app.get('/api', (req, res) => {
  res.json({
    version: 1,
    description: 'Proxmox Status Panel — Agent API',
    note: 'All GET endpoints return cached data (staleness indicated by stale/stale_since fields). POST actions are live.',
    endpoints: [
      {
        method: 'GET', path: '/api',
        description: 'This manifest — lists all available endpoints',
      },
      {
        method: 'GET', path: '/api/status',
        description: 'Full snapshot: node metrics, all LXC containers, and GPU stats combined',
      },
      {
        method: 'GET', path: '/api/node',
        description: 'Node-only metrics: cpu, memory, disk, network rates, uptime, cpu_temp',
      },
      {
        method: 'GET', path: '/api/lxcs',
        description: 'All LXC containers with status, cpu%, mem%, disk I/O rates',
      },
      {
        method: 'GET', path: '/api/lxc/:vmid',
        description: 'Single LXC container by vmid (e.g. /api/lxc/101)',
        params: { vmid: 'numeric container ID' },
      },
      {
        method: 'POST', path: '/api/lxc/:vmid/:action',
        description: 'Control an LXC container',
        params: {
          vmid: 'numeric container ID',
          action: 'start | shutdown | reboot',
        },
        returns: '{ success: bool, data: <proxmox task ID> } or { success: false, error: string }',
      },
      {
        method: 'GET', path: '/api/gpu/current',
        description: 'Live GPU stats: util%, temp°C, power_w, mem_util%, fan%',
      },
      {
        method: 'GET', path: '/api/gpu/history',
        description: 'GPU history as downsampled time-series; ≤1h = full res, >1h = 360-point buckets',
        query: { window: 'seconds of history (60–604800, default 300)' },
      },
      {
        method: 'GET', path: '/api/config',
        description: 'Public panel configuration (title, GPU layout, grid columns)',
      },
      {
        method: 'GET', path: '/health',
        description: 'Health check — { status: "ok", timestamp: <epoch ms> }',
      },
      {
        method: 'GET', path: '/api/console/session',
        description: 'Mint a Proxmox auth ticket and set PVEAuthCookie so LXC console iframes auto-authenticate. Requires console credentials in config.json.',
        returns: '{ ok: true, expires: <epoch ms> } or { ok: false, error: string }',
      },
      {
        method: 'GET', path: '/api/panes',
        description: 'Load persisted pane open/minimised states: { states: { vmid: "visible"|"minimized" } }',
      },
      {
        method: 'POST', path: '/api/panes',
        description: 'Save pane states. Body: { vmid: "visible"|"minimized"|"closed" }. Persisted to pane-states.json on the server.',
      },
    ],
  });
});

// Node-only — thin slice of /api/status, no LXC/GPU noise
app.get('/api/node', (req, res) => {
  const px = client.getCachedStatus();
  const temp = host.getTempCache();
  res.json({
    stale: px.stale,
    stale_since: px.stale_since || null,
    timestamp: px.timestamp,
    node: px.node ? { ...px.node, cpu_temp: temp ? temp.package_temp : null } : null,
  });
});

// LXC list — thin slice of /api/status
app.get('/api/lxcs', (req, res) => {
  const px = client.getCachedStatus();
  res.json({
    stale: px.stale,
    stale_since: px.stale_since || null,
    timestamp: px.timestamp,
    lxcs: px.lxcs || [],
  });
});

// Pane states — persisted to pane-states.json so state survives refreshes and is shared across devices
app.get('/api/panes', (req, res) => {
  res.json({ states: paneStore.load() });
});

app.post('/api/panes', (req, res) => {
  try {
    paneStore.save(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[panel] Pane state save error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Single LXC — filtered from cache, no extra fetch
app.get('/api/lxc/:vmid', (req, res) => {
  const px = client.getCachedStatus();
  const lxc = (px.lxcs || []).find(l => l.vmid === req.params.vmid);
  if (!lxc) {
    return res.status(404).json({ success: false, error: `LXC ${req.params.vmid} not found` });
  }
  res.json({
    stale: px.stale,
    stale_since: px.stale_since || null,
    timestamp: px.timestamp,
    lxc,
  });
});

// Start
const cfg = getConfig();
const port = cfg.port || 3000;

client.startPolling();
gpuHistory.startPolling();
host.startPolling();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[panel] Proxmox Status Panel running at http://0.0.0.0:${port}`);
  console.log(`[panel] Proxmox host: ${cfg.proxmox_host}`);
  console.log(`[panel] Host exporter: ${cfg.host_exporter_url || 'not configured'}`);
});

// Attach WebSocket terminal proxy — handles upgrades to /api/lxc/:vmid/termproxy
createTermProxyServer(server);
