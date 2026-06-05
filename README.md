# Proxmox Status Panel

"Industrial Matrix" style web dashboard for a Proxmox homelab server. Runs inside a Debian LXC, polls the Proxmox REST API every 5 s, and displays node stats, LXC container status, GPU info, and an embedded terminal panes view with live shells into every container — including a host root shell.

---

## Features

- **Dashboard view** — node CPU/RAM/temp/network, LXC grid with I/O flicker animations, GPU stats and history graphs
- **Panes view** — tmux-style grid of live xterm.js terminals for every LXC container and the host root shell, all in one browser tab
- **Root shell** — Proxmox node shell (`000 ROOT`) accessible directly from the panes tab strip
- **Mobile responsive** — adapts to portrait phone screens; tab strip is horizontally scrollable
- **Animated transitions** — 300 ms cross-fade with scale between dashboard and panes views
- **Tmux prefix button** — `PANES` button sends `Ctrl+B` to the last-active terminal so function keys work on mobile
- **Persisted pane states** — open/minimised pane layout is saved server-side and restored on refresh

---

## Prerequisites

- Debian 12/13 LXC on Proxmox
- 1 CPU core, 512 MB RAM, 4 GB disk
- Node.js 20.x

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

Copy the example files and fill in your values:

```bash
cp .env.example .env          # fill in API token and console password
cp config.example.json config.json  # fill in your Proxmox host, node, etc.
```

Then start:

```bash
node server/index.js
# or use the systemd service — see bottom of this file
```

Panel is available at `http://[LXC-IP]:3000`.

---

## Proxmox Setup

### 1. API token (dashboard status polling)

1. **Datacenter → Permissions → API Tokens** — add a token for `root@pam` named `dashboard`. Copy the secret.
2. **Datacenter → Permissions → Add → API Token Permission**:
   - Path: `/`
   - Token: `root@pam!dashboard`
   - Role: `PVEAuditor`

Set `PVE_API_TOKEN` in `.env`:
```
PVE_API_TOKEN=PVEAPIToken=root@pam!dashboard=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 2. Console user (terminal panes view)

The panes view connects to Proxmox's native terminal API. This requires a **PVE user with a password** — Proxmox PVEVNC ticket validation only accepts cookie-based auth, not API tokens.

#### Create the user

**Datacenter → Permissions → Users → Add**:
- Username: `dashboard@pve`
- Password: a strong password (this becomes `PVE_PASSWORD` in `.env`)

#### Grant container terminal access

```
Datacenter → Permissions → Add → User Permission
  Path:       /
  User:       dashboard@pve
  Role:       PVEVMUser
  Propagate:  ✓
```

#### Grant host shell access (for the ROOT tab)

The `000 ROOT` tab opens a node shell and requires `Sys.Console`. Create a minimal custom role and grant it:

```bash
# Run on the Proxmox host or via curl with an API token
TOKEN="PVEAPIToken=root@pam!dashboard=<your-token>"
HOST="https://<proxmox-host>:8006"
NODE="<your-node-name>"

# Create a role with only Sys.Console
curl -sk -X POST "$HOST/api2/json/access/roles" \
  -H "Authorization: $TOKEN" \
  -d "roleid=SysConsole&privs=Sys.Console"

# Grant it to dashboard@pve on /nodes/<node>
curl -sk -X PUT "$HOST/api2/json/access/acl" \
  -H "Authorization: $TOKEN" \
  -d "path=/nodes/$NODE&users=dashboard@pve&roles=SysConsole&propagate=0"
```

Set credentials in `.env`:
```
PVE_USERNAME=dashboard@pve
PVE_PASSWORD=your-dashboard-user-password
```

---

## Secrets (`.env`)

Secrets are loaded from `.env` (gitignored) or from the environment. Environment variables take precedence over `config.json`.

```bash
# Proxmox API token — for status polling and LXC power actions
PVE_API_TOKEN=PVEAPIToken=root@pam!dashboard=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Proxmox user credentials — for terminal panes (PVEVNC ticket auth)
PVE_USERNAME=dashboard@pve
PVE_PASSWORD=your-password-here
```

**Never commit `.env` or `config.json` with real secrets to version control.** Both are gitignored.

---

## Configuration Reference (`config.json`)

| Field | Description |
|---|---|
| `proxmox_host` | Proxmox API base URL, e.g. `https://<proxmox-ip>:8006` |
| `proxmox_node` | Node name as shown in Proxmox UI |
| `verify_ssl` | `false` to skip self-signed cert check (default for homelabs) |
| `panel_title` | Displayed in the header bar, e.g. `HP Z640` |
| `panel_subtitle` | Displayed in the footer, e.g. `PROXMOX 8` |
| `port` | HTTP port (default: `3000`) |
| `poll_interval_ms` | Proxmox poll interval in ms (default: `5000`) |
| `lxc_names` | Map of `"vmid" → "display name"` — overrides Proxmox container names |
| `lxc_grid_cols` | Columns in the LXC grid on a 16:9 screen (default: `6`, scales with aspect ratio) |
| `gpus` | Static GPU config array — see GPU section below |
| `show_gpus` | `true`/`false` — show or hide the GPU section |
| `max_net_mbps` | Maximum network speed for the net ticker bars (default: `1000`) |
| `pve_username` | PVE username for console auth — prefer `.env` `PVE_USERNAME` |
| `pve_password` | PVE password for console auth — prefer `.env` `PVE_PASSWORD` |

---

## Panes View

Click **⊞** in the top-right of the header to switch to panes view.

- **Tabs** across the top: `000 ROOT` (host shell) pinned at the left, then one tab per container sorted by vmid
- Tab labels are uppercase with vowels removed to save space (e.g. `vinted-bot` → `VNTD BT`)
- Click a tab once to open, again to minimise, again to restore; **×** disconnects
- **PANES** button (top-left) sends `Ctrl+B` to the last-typed terminal — use as a tmux prefix on mobile
- Pane layout is persisted server-side across refreshes
- xterm.js is lazy-loaded from CDN and cached; first open may be slightly slower

### How terminal auth works

The server authenticates as `dashboard@pve` using a cached PVE session ticket (re-minted every 90 minutes). For each terminal open it calls `POST /nodes/{node}/lxc/{vmid}/termproxy` (or `/nodes/{node}/termproxy` for the root shell) and proxies the Proxmox WebSocket directly to the browser. No Proxmox cookies or credentials are ever sent to the browser.

---

## CPU Temperature

Proxmox doesn't expose CPU temperature via its REST API. The panel reads `/sys/class/thermal/thermal_zone0/temp` from inside the LXC.

Add a bind mount to the LXC config on the **Proxmox host** to expose it:

```
# /etc/pve/lxc/[vmid].conf
lxc.mount.entry: /sys/class/thermal sys/class/thermal none bind,optional,create=dir
```

Restart the LXC after adding this. If the file is not accessible temperature is silently hidden.

---

## GPU Stats

Configure static GPU entries in `config.json` — the left-side summary panel uses these names even when live stats are not available:

```json
"gpus": [
  { "id": "0", "display_name": "RTX 3090", "vram_total_gb": 24 }
],
"show_gpus": true
```

If `nvidia-smi` is available inside this LXC, live utilisation, VRAM, power, and temperature are polled every 2 s and history graphs are drawn for the past 5 / 15 / 60 minutes. GPU pass-through to this specific LXC is required for live stats.

---

## Systemd Service

```bash
cp proxmox-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable proxmox-panel
systemctl start proxmox-panel
```

```bash
systemctl status proxmox-panel
journalctl -u proxmox-panel -f
```

---

## Troubleshooting

**Terminals show `[Connection failed]` or HTTP 403**
Ensure `dashboard@pve` exists with a password and `PVE_USERNAME`/`PVE_PASSWORD` are set in `.env`. Verify `PVEVMUser` is granted on `/` for that user.

**ROOT shell tab fails to connect**
The `SysConsole` role must be granted to `dashboard@pve` on `/nodes/<node>`. See the host shell setup steps above.

**SSL errors connecting to Proxmox**
Set `"verify_ssl": false` in `config.json`.

**403 / permission denied from the status API**
Verify `PVE_API_TOKEN` has the `PVEAuditor` role on `/`.

**LXC can't reach Proxmox API**
Ensure the LXC is on the same bridge as the Proxmox host:
```bash
curl -k https://<proxmox-host>:8006/api2/json/version
```

**Container shows wrong name**
Add an entry to `lxc_names` in `config.json`: `"225": "My Container"`.

**Panel not loading from another machine**
The server binds to `0.0.0.0:3000`. Check LXC and Proxmox firewall rules for port 3000.
