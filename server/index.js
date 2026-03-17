'use strict';

const path = require('path');
const express = require('express');
const { getConfig, getPublicConfig } = require('./config');
const ProxmoxClient = require('./proxmox');
const host = require('./host');

const app = express();
const client = new ProxmoxClient();

// Static files
app.use(express.static(path.join(__dirname, '..', 'client')));

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start
const cfg = getConfig();
const port = cfg.port || 3000;

client.startPolling();
host.startPolling();

app.listen(port, '0.0.0.0', () => {
  console.log(`[panel] Proxmox Status Panel running at http://0.0.0.0:${port}`);
  console.log(`[panel] Proxmox host: ${cfg.proxmox_host}`);
  console.log(`[panel] Host exporter: ${cfg.host_exporter_url || 'not configured'}`);
});
