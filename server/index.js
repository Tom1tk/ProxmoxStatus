'use strict';

const path = require('path');
const express = require('express');
const { getConfig, getPublicConfig } = require('./config');
const ProxmoxClient = require('./proxmox');

const app = express();
const client = new ProxmoxClient();

// Static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// API endpoints
app.get('/api/status', (req, res) => {
  res.json(client.getCachedStatus());
});

app.get('/api/config', (req, res) => {
  res.json(getPublicConfig());
});

// Start
const cfg = getConfig();
const port = cfg.port || 3000;

client.startPolling();

app.listen(port, '0.0.0.0', () => {
  console.log(`[panel] Proxmox Status Panel running at http://0.0.0.0:${port}`);
  console.log(`[panel] Proxmox host: ${cfg.proxmox_host}`);
  console.log(`[panel] Node: ${cfg.proxmox_node}`);
});
