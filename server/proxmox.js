'use strict';

const https = require('https');
const fs = require('fs');
const { exec } = require('child_process');
const fetch = require('node-fetch');
const { getConfig, getDisplayName } = require('./config');

class ProxmoxClient {
  constructor() {
    this._cache = null;
    this._prevNet = null;       // { netin, netout, ts }
    this._prevDisk = {};        // vmid → { diskread, diskwrite }
    this._stale = false;
    this._staleSince = null;
    this._gpuAvailable = null;  // null = not yet checked
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

    const [nodeStatus, lxcList, storageList] = await Promise.all([
      this._get(`${base}/status`, headers, agent),
      this._get(`${base}/lxc`, headers, agent),
      this._get(`${base}/storage`, headers, agent),
    ]);

    // Node metrics
    const ns = nodeStatus.data;
    const now = Date.now();

    // Network rate (cumulative bytes → bytes/s delta)
    let netIn = 0, netOut = 0;
    if (this._prevNet) {
      const dt = (now - this._prevNet.ts) / 1000;
      if (dt > 0) {
        netIn = Math.max(0, (ns.netin - this._prevNet.netin) / dt);
        netOut = Math.max(0, (ns.netout - this._prevNet.netout) / dt);
      }
    }
    this._prevNet = { netin: ns.netin, netout: ns.netout, ts: now };

    // Disk usage from storage
    let diskUsed = 0, diskTotal = 0;
    for (const s of (storageList.data || [])) {
      if (s.content && s.content.includes('rootdir')) {
        diskUsed += s.disk || 0;
        diskTotal += s.maxdisk || 0;
      }
    }
    if (diskTotal === 0) {
      // fallback: sum all
      for (const s of (storageList.data || [])) {
        diskUsed += s.disk || 0;
        diskTotal += s.maxdisk || 0;
      }
    }

    // CPU temp
    const cpuTemp = this._readCpuTemp();

    // LXC stats
    const lxcs = await this._fetchLxcs(lxcList.data || [], headers, agent, base);

    // GPU data
    const gpus = await this._fetchGpus();

    return {
      timestamp: now,
      node: {
        hostname: ns.pveversion ? cfg.proxmox_node : (ns.nodename || cfg.proxmox_node),
        cpu: ns.cpu || 0,
        mem_used: ns.memory ? ns.memory.used : 0,
        mem_total: ns.memory ? ns.memory.total : 0,
        disk_used: diskUsed,
        disk_total: diskTotal,
        net_in: netIn,
        net_out: netOut,
        cpu_temp: cpuTemp,
        uptime: ns.uptime || 0,
      },
      lxcs,
      gpus,
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
      };
    }).filter(Boolean);

    // Sort by lxc_order
    const order = cfg.lxc_order || [];
    items.sort((a, b) => {
      const ia = order.indexOf(a.vmid);
      const ib = order.indexOf(b.vmid);
      if (ia === -1 && ib === -1) return Number(a.vmid) - Number(b.vmid);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    return items;
  }

  // ─── GPU ───────────────────────────────────────────────────────────────────

  async _fetchGpus() {
    const cfg = getConfig();
    if (!cfg.show_gpus) return [];

    // Check nvidia-smi availability once
    if (this._gpuAvailable === null) {
      this._gpuAvailable = await this._checkNvidiaSmi();
      console.log(`[proxmox] nvidia-smi available: ${this._gpuAvailable}`);
    }

    if (this._gpuAvailable) {
      try {
        return await this._fetchNvidiaGpus();
      } catch (e) {
        console.warn('[proxmox] nvidia-smi error:', e.message);
      }
    }

    // Fallback: static config with null live values
    return (cfg.gpus || []).map(g => ({
      id: g.id,
      display_name: g.display_name,
      vram_used_gb: null,
      vram_total_gb: g.vram_total_gb,
      gpu_util: null,
      temp: null,
      process: null,
    }));
  }

  _checkNvidiaSmi() {
    return new Promise(resolve => {
      exec('which nvidia-smi', err => resolve(!err));
    });
  }

  _fetchNvidiaGpus() {
    return new Promise((resolve, reject) => {
      const query = 'index,name,memory.used,memory.total,utilization.gpu,temperature.gpu';
      exec(`nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`, (err, stdout) => {
        if (err) return reject(err);
        const cfg = getConfig();
        const lines = stdout.trim().split('\n').filter(Boolean);
        const gpus = lines.map((line, i) => {
          const parts = line.split(',').map(s => s.trim());
          const cfgGpu = (cfg.gpus || [])[i] || {};
          return {
            id: cfgGpu.id || `gpu${i}`,
            display_name: cfgGpu.display_name || parts[1] || `GPU ${i}`,
            vram_used_gb: parseFloat(parts[2]) / 1024 || null,
            vram_total_gb: parseFloat(parts[3]) / 1024 || cfgGpu.vram_total_gb || null,
            gpu_util: parseInt(parts[4]) || 0,
            temp: parseInt(parts[5]) || null,
            process: null, // would need separate query
          };
        });
        resolve(gpus);
      });
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _get(url, headers, agent) {
    const res = await fetch(url, { headers, agent });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  _readCpuTemp() {
    try {
      const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      return parseInt(raw.trim()) / 1000;
    } catch {
      return null;
    }
  }
}

module.exports = ProxmoxClient;
