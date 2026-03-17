# Proxmox Status Panel

"Industrial Matrix" style read-only web dashboard for a Proxmox homelab server. Runs inside a Debian LXC, polls the Proxmox REST API every 5s, and displays node stats, LXC container status with I/O flicker animations, and GPU info.

---

## Prerequisites

- Debian 12/13 LXC on Proxmox
- 1 CPU core, 512 MB RAM, 4 GB disk
- Node.js 20.x (see below)

### Install Node.js 20.x

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

---

## Installation

```bash
cd /opt/proxmox-panel
npm install
```

Edit `config.json` with your Proxmox host, node name, and API token (see below).

```bash
node server/index.js
```

Panel is available at `http://[LXC-IP]:3000`.

---

## Proxmox API Token Setup

1. In the Proxmox web UI, go to **Datacenter → Permissions → Users** and create `dashboard@pve`.
2. Go to **Datacenter → Permissions → API Tokens**, add a token for `dashboard@pve` named `dashboard-token`. Uncheck "Privilege Separation".
3. Go to **Datacenter → Permissions → Add → API Token Permission**:
   - Path: `/nodes/[your-node-name]`
   - Token: `dashboard@pve!dashboard-token`
   - Role: `PVEAuditor`
4. Copy the token secret shown — it won't be shown again.
5. Set `api_token` in `config.json`:
   ```
   PVEAPIToken=dashboard@pve!dashboard-token=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

---

## Configuration Reference (`config.json`)

| Field | Description |
|---|---|
| `proxmox_host` | Proxmox API base URL, e.g. `https://192.168.68.10:8006` |
| `proxmox_node` | Node name as shown in Proxmox UI |
| `api_token` | Full API token string (see above) |
| `verify_ssl` | `false` to skip self-signed cert check (recommended for home use) |
| `panel_title` | Displayed in header, e.g. `HP Z640` |
| `panel_subtitle` | Displayed in footer, e.g. `PROXMOX 8` |
| `port` | HTTP port to listen on (default: `3000`) |
| `poll_interval_ms` | How often to poll Proxmox in ms (default: `5000`) |
| `lxc_names` | Map of `vmid → display name` (overrides Proxmox names) |
| `lxc_order` | Array of vmid strings — sets display order in grid |
| `gpus` | Static GPU config array (see GPU section below) |
| `show_gpus` | `true`/`false` — whether to render the GPU section |
| `max_net_mbps` | Maximum network speed for ticker scaling (default: `1000`) |
| `lxc_grid_cols` | Number of columns in LXC grid (default: `6`) |

---

## CPU Temperature

Proxmox doesn't expose CPU temperature via its REST API. This panel reads `/sys/class/thermal/thermal_zone0/temp` inside the LXC.

To make this work, add a bind mount to the LXC config on the **Proxmox host**:

```
# Edit /etc/pve/lxc/[vmid].conf on the Proxmox host:
lxc.mount.entry: /sys/class/thermal sys/class/thermal none bind,optional,create=dir
```

Restart the LXC after adding this. If the file is not accessible, temperature is hidden from the UI (no empty box shown).

---

## GPU Stats

GPU stats require `nvidia-smi` to be available **inside this LXC**. This is only possible if the GPU is passed through to this specific LXC — which is unlikely if the GPU is used by another container (e.g. an AI inference LXC).

**Typical setup:**
- The dashboard LXC will **not** have GPU access
- Configure static GPU entries in `config.json` under `gpus` with `display_name` and `vram_total_gb`
- The GPU section will show configured names with empty bars and "NO DATA" for live stats
- Set `show_gpus: false` to hide the GPU section entirely

**If you do have GPU access in this LXC:**
Install the matching NVIDIA driver and `nvidia-smi`. The panel will detect it automatically on startup and query live stats every poll cycle.

---

## Systemd Service

```bash
cp proxmox-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable proxmox-panel
systemctl start proxmox-panel
```

Check status:
```bash
systemctl status proxmox-panel
journalctl -u proxmox-panel -f
```

---

## Troubleshooting

**SSL errors connecting to Proxmox:**
Set `"verify_ssl": false` in `config.json`. Proxmox uses a self-signed certificate by default.

**403 / permission denied from Proxmox API:**
Verify the API token has the `PVEAuditor` role on `/nodes/[nodename]`. The token must not have "Privilege Separation" unchecked if you want it to inherit user permissions.

**LXC can't reach Proxmox API:**
Make sure the LXC is on the same bridge as the Proxmox host. Try `curl -k https://192.168.68.10:8006/api2/json/version` from inside the LXC.

**Container shows wrong name:**
Add an entry to `lxc_names` in `config.json` mapping the vmid to the display name you want.

**Panel not loading from another machine:**
The server binds to `0.0.0.0`. Check the LXC firewall and Proxmox firewall rules — ensure port 3000 is reachable on the LXC IP.
