'use strict';

const path = require('path');
const fs   = require('fs');

const STORE_PATH = path.join(__dirname, '..', 'pane-states.json');

// Load current state map: { vmid: 'visible' | 'minimized' }
// Closed is the default so we only store non-closed states.
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// Save state map — strips closed entries to keep the file compact.
function save(states) {
  const compact = {};
  for (const [vmid, state] of Object.entries(states || {})) {
    if (state === 'visible' || state === 'minimized') compact[vmid] = state;
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(compact, null, 2), 'utf8');
}

module.exports = { load, save };
