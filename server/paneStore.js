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

// Merge changed panes into the saved map: { vmid: 'visible'|'minimized'|'closed' }.
// Only changes are sent, so a device with an old copy can't undo another's.
// Closed is the default and is removed rather than stored.
const VMID_RE = /^(\d+|node)$/;
function save(changes) {
  const states = load();
  for (const [vmid, state] of Object.entries(changes || {})) {
    if (!VMID_RE.test(vmid)) continue;
    if (state === 'visible' || state === 'minimized') states[vmid] = state;
    else if (state === 'closed') delete states[vmid];
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(states, null, 2), 'utf8');
}

module.exports = { load, save };
