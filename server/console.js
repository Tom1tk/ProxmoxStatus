'use strict';

const https = require('https');
const fetch = require('node-fetch');
const { getConfig } = require('./config');

// PVE tickets are valid for ~2 hours; refresh at 90 minutes to stay ahead of expiry
const TICKET_TTL_MS = 90 * 60 * 1000;

let _cache = null; // { ticket, csrf, mintedAt, expires }

async function mintTicket() {
  const cfg   = getConfig();
  const agent = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
  const url   = `${cfg.proxmox_host}/api2/json/access/ticket`;
  const body  = new URLSearchParams({
    username: cfg.pve_username,
    password: cfg.pve_password,
  }).toString();

  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      agent,
    });
  } catch (err) {
    throw new Error(`Proxmox ticket request failed: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Proxmox ticket mint failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Proxmox ticket response was not valid JSON');
  }

  const ticket = json && json.data && json.data.ticket;
  const csrf   = json && json.data && json.data.CSRFPreventionToken;

  if (!ticket || !csrf) {
    throw new Error('Proxmox ticket response missing ticket or CSRFPreventionToken — check pve_username/pve_password');
  }

  return { ticket, csrf };
}

// Returns a cached-or-fresh { ticket, csrf, mintedAt, expires }.
// Thread-safe: parallel calls while minting in-flight are handled by awaiting the same promise.
let _mintingPromise = null;

async function getTicket() {
  const now = Date.now();
  if (_cache && (now - _cache.mintedAt) < TICKET_TTL_MS) {
    return _cache;
  }

  // Deduplicate concurrent requests — only one mint at a time
  if (!_mintingPromise) {
    _mintingPromise = mintTicket()
      .then(({ ticket, csrf }) => {
        _cache = { ticket, csrf, mintedAt: Date.now(), expires: Date.now() + TICKET_TTL_MS };
        console.log('[console] Proxmox ticket minted; valid until', new Date(_cache.expires).toISOString());
        return _cache;
      })
      .finally(() => { _mintingPromise = null; });
  }

  return _mintingPromise;
}

module.exports = { getTicket };
