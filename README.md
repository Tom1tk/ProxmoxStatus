# Proxmox Status Panel

"Industrial Matrix" style web dashboard for a Proxmox homelab server. Runs inside a Debian LXC, polls the Proxmox REST API every 5 s, and displays node stats, LXC container status, GPU stats with up to 7 days of history, and an embedded terminal panes view with live shells into every container — including a host root shell.

---

## Features

- **Dashboard view** — node CPU/RAM/temp/network, LXC grid with I/O flicker animations and per-container CPU/RAM/DISK bars, GPU stats and history graphs
- **LXC power actions** — click a container to START, REBOOT or SHUT it down
- **Stale indicator** — a red `STALE` badge in the header when the Proxmox API stops responding and last known values are shown
- **Panes view** — tmux-style grid of live xterm.js terminals for every LXC container and the host root shell, all in one browser tab
- **Root shell** — Proxmox node shell (`000 ROOT`) accessible directly from the panes tab strip
- **Mobile responsive** — adapts to portrait phone screens; tab strip is horizontally scrollable
- **Animated transitions** — 300 ms cross-fade with scale between dashboard and panes views
- **Tmux prefix button** — `PANES` button sends `Ctrl+B` to the last-active terminal so function keys work on mobile
- **Persisted pane states** — open/minimised pane layout is saved server-side and restored on refresh
- **Reader mode** — renders terminals as large, selectable text for phones, with tap-to-type
- **Light / dark theme** — footer toggle; terminals and running TUIs follow the theme
- **Multi-device terminals** — the device you are using sets each terminal's size; other devices watch at that size
- **Auto-reconnect** — terminals reconnect after network drops, sleep or tab switches

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

Run the tests with:

```bash
npm test
```

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
| `api_token` | Proxmox API token — prefer `.env` `PVE_API_TOKEN` |
| `proxmox_node` | Node name as shown in Proxmox UI |
| `verify_ssl` | `false` to skip self-signed cert check (default for homelabs) |
| `panel_title` | Displayed in the header bar, e.g. `HP Z640` |
| `panel_subtitle` | Displayed in the footer, e.g. `PROXMOX 8` |
| `port` | HTTP port (default: `3000`) |
| `poll_interval_ms` | Proxmox poll interval in ms (default: `5000`) |
| `lxc_names` | Map of `"vmid" → "display name"` — overrides Proxmox container names |
| `lxc_grid_cols` | Columns in the LXC grid on a 16:9 screen (default: `6`, scales with aspect ratio) |
| `host_exporter_url` | Host exporter metrics URL for CPU temperature, e.g. `http://<proxmox-ip>:9101/metrics` |
| `host_exporter_poll_ms` | Host exporter poll interval in ms (default: `5000`) |
| `gpus` | Optional GPU display-name overrides — see GPU section below |
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
- **▤** in the footer toggles reader mode; the size button next to it cycles the text size
- On mobile, a key row offers keys a phone keyboard lacks (Esc, Tab, Ctrl, arrows, and Ctrl+B for tmux)
- When several devices open the same container, the device you last interacted with owns the terminal size. Others show it scaled to fit; touching a pane there takes ownership and redraws once. The ROOT shell is per-connection and is not shared

### How terminal auth works

The server authenticates as `dashboard@pve` using a cached PVE session ticket (re-minted every 90 minutes). For each terminal open it calls `POST /nodes/{node}/lxc/{vmid}/termproxy` (or `/nodes/{node}/termproxy` for the root shell) and proxies the Proxmox WebSocket directly to the browser. No Proxmox cookies or credentials are ever sent to the browser.

Terminal WebSocket upgrades are only accepted when the browser's `Origin` matches the `Host` header. A reverse proxy in front of the panel must pass the original `Host` through.

If the panel sits behind an auth proxy such as Cloudflare Access, the page reloads itself when the auth session expires so you are sent back through login.

---

## CPU Temperature

Proxmox doesn't expose CPU temperature via its REST API. The panel reads it from a small host exporter running on the **Proxmox host**, which serves JSON with a `temps` object at `/metrics`.

```json
"host_exporter_url": "http://<proxmox-ip>:9101/metrics",
"host_exporter_poll_ms": 5000
```

If the exporter is unreachable, the temperature readout is hidden rather than showing an old value.

---

## GPU Stats

Live GPU stats are read every 2 s from `/mnt/gpu-stats/gpu_stats.txt`, a CSV file written on the host and bind-mounted into this LXC. One line per GPU:

```
index,name,temp,power_draw,power_limit,gpu_util,mem_util,fan_pct
```

If the file hasn't been updated for 30 s its writer is treated as dead and no GPUs are shown.

The server keeps 7 days of history per GPU at 2 s resolution and saves it to `/var/lib/dashboard/gpu_history.bin` every 5 minutes, so it survives restarts (up to 5 minutes is lost on a restart). The history graph offers 5m / 30m / 1h / 6h / 12h / 1d / 7d windows; history is recorded whether or not a browser is open.

Optionally override GPU names in `config.json`, matched by GPU index:

```json
"gpus": [
  { "index": 0, "display_name": "RTX 3090" }
],
"show_gpus": true
```

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

**Terminals stop connecting behind a reverse proxy**
Check `journalctl -u proxmox-panel` for `rejected origin`. The proxy must forward the original `Host` header.

**Header shows `STALE`**
The Proxmox API hasn't answered recently; values shown are the last known ones. Check that the LXC can reach Proxmox (below).

**GPU section shows no GPUs**
Check that `/mnt/gpu-stats/gpu_stats.txt` exists in the LXC and is being updated every few seconds.

**Container shows wrong name**
Add an entry to `lxc_names` in `config.json`: `"225": "My Container"`.

**Panel not loading from another machine**
The server binds to `0.0.0.0:3000`. Check LXC and Proxmox firewall rules for port 3000.
