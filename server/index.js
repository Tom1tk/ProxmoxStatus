'use strict';

const path = require('path');
const express = require('express');
const { getConfig, getPublicConfig } = require('./config');
const ProxmoxClient = require('./proxmox');
const host = require('./host');
const gpuHistory = require('./gpuHistory');

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

// Start
const cfg = getConfig();
const port = cfg.port || 3000;

client.startPolling();
host.startPolling();
gpuHistory.startPolling();

app.listen(port, '0.0.0.0', () => {
  console.log(`[panel] Proxmox Status Panel running at http://0.0.0.0:${port}`);
  console.log(`[panel] Proxmox host: ${cfg.proxmox_host}`);
  console.log(`[panel] Host exporter: ${cfg.host_exporter_url || 'not configured'}`);
});
