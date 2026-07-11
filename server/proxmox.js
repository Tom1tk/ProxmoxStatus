'use strict';

const https = require('https');
const fetch = require('node-fetch');
const { getConfig, getDisplayName } = require('./config');

class ProxmoxClient {
  constructor() {
    this._cache = null;
    this._prevNet = null;
    this._prevDisk = {};
    this._stale = false;
    this._staleSince = null;
    this._timer = null;
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  startPolling() {
    const cfg = getConfig();
    this._poll();
    this._timer = setInterval(() => this._poll(), cfg.poll_interval_ms);
  }

  getCachedStatus() {
    if (!this._cache) {
      return { stale: true, stale_since: Date.now(), timestamp: Date.now(), node: null, lxcs: [], gpus: [] };
    }
    return Object.assign({}, this._cache, {
      stale: this._stale,
      stale_since: this._stale ? this._staleSince : undefined,
    });
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  async _poll() {
    try {
      const data = await this._fetchAll();
      this._cache = data;
      this._stale = false;
      this._staleSince = null;
    } catch (err) {
      console.error('[proxmox] Poll error:', err.message);
      if (!this._stale) {
        this._stale = true;
        this._staleSince = Date.now();
      }
    }
  }

  // ─── Fetch all data ────────────────────────────────────────────────────────

  async _fetchAll() {
    const cfg = getConfig();
    const agent = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
    const headers = { Authorization: cfg.api_token };
    const base = `${cfg.proxmox_host}/api2/json/nodes/${cfg.proxmox_node}`;

    const [nodeStatus, lxcList, rrdData] = await Promise.all([
      this._get(`${base}/status`, headers, agent),
      this._get(`${base}/lxc`, headers, agent),
      this._get(`${base}/rrddata?timeframe=hour&cf=AVERAGE`, headers, agent),
    ]);

    // Node metrics
    const ns = nodeStatus.data;
    const now = Date.now();

    // Network rate from rrddata (already in bytes/s)
    const rrdEntries = rrdData.data || [];
    const lastRrd = rrdEntries[rrdEntries.length - 1] || {};
    const netIn = lastRrd.netin || 0;
    const netOut = lastRrd.netout || 0;

    // Disk usage from storage
    // Use rootfs from node status (most reliable across Proxmox setups)
    const diskUsed = ns.rootfs ? ns.rootfs.used : 0;
    const diskTotal = ns.rootfs ? ns.rootfs.total : 0;

    // LXC stats
    const lxcs = await this._fetchLxcs(lxcList.data || [], headers, agent, base);

    return {
      timestamp: now,
      node: {
        hostname: ns.nodename || cfg.proxmox_node,
        cpu: ns.cpu || 0,
        mem_used: ns.memory ? ns.memory.used : 0,
        mem_total: ns.memory ? ns.memory.total : 0,
        disk_used: diskUsed,
        disk_total: diskTotal,
        net_in: netIn,
        net_out: netOut,
        uptime: ns.uptime || 0,
      },
      lxcs,
    };
  }

  // ─── LXC stats ─────────────────────────────────────────────────────────────

  async _fetchLxcs(lxcList, headers, agent, base) {
    const cfg = getConfig();
    const now = Date.now();

    const results = await Promise.allSettled(
      lxcList.map(lxc => this._get(`${base}/lxc/${lxc.vmid}/status/current`, headers, agent)
        .then(r => ({ lxc, stat: r.data }))
        .catch(() => ({ lxc, stat: null }))
      )
    );

    const items = results.map(r => {
      if (r.status === 'rejected') return null;
      const { lxc, stat } = r.value;
      const vmid = String(lxc.vmid);
      const displayName = getDisplayName(vmid, lxc.name);

      // Disk I/O delta (cumulative bytes → bytes/s)
      let diskRead = 0, diskWrite = 0;
      if (stat && this._prevDisk[vmid]) {
        const prev = this._prevDisk[vmid];
        const dt = (now - prev.ts) / 1000;
        if (dt > 0) {
          diskRead  = Math.max(0, ((stat.diskread  || 0) - prev.diskread)  / dt);
          diskWrite = Math.max(0, ((stat.diskwrite || 0) - prev.diskwrite) / dt);
        }
      }
      if (stat) {
        this._prevDisk[vmid] = {
          diskread:  stat.diskread  || 0,
          diskwrite: stat.diskwrite || 0,
          ts: now,
        };
      }

      return {
        vmid,
        name: lxc.name,
        display_name: displayName,
        status: stat ? stat.status : (lxc.status || 'unknown'),
        cpu: stat ? (stat.cpu || 0) : 0,
        mem: stat ? (stat.mem && stat.maxmem ? stat.mem / stat.maxmem : 0) : 0,
        disk_read:  diskRead,
        disk_write: diskWrite,
        maxcpu:  stat ? (stat.cpus    || 0) : 0,
        memused: stat ? (stat.mem     || 0) : 0,
        maxmem:  stat ? (stat.maxmem  || 0) : 0,
        disk:    stat ? (stat.disk    || 0) : 0,
        maxdisk: stat ? (stat.maxdisk || 0) : 0,
      };
    }).filter(Boolean);

    // Sort by vmid numerically — new LXCs appear automatically in the right position
    items.sort((a, b) => Number(a.vmid) - Number(b.vmid));

    return items;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async executeAction(vmid, action) {
    const cfg = getConfig();
    const agent = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
    const headers = { Authorization: cfg.api_token };
    const url = `${cfg.proxmox_host}/api2/json/nodes/${cfg.proxmox_node}/lxc/${vmid}/status/${action}`;
    return this._post(url, headers, agent);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _get(url, headers, agent) {
    const res = await fetch(url, { headers, agent });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  async _post(url, headers, agent) {
    const res = await fetch(url, { method: 'POST', headers, agent });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

}

module.exports = ProxmoxClient;
