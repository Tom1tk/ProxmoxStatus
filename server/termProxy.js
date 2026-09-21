'use strict';

const https = require('https');
const fetch = require('node-fetch');
const { WebSocketServer, WebSocket } = require('ws');
const { getConfig }   = require('./config');
const consoleAuth     = require('./console');
const ownership       = require('./sizeOwnership');

const CID_RE = /^[a-z0-9]{8,32}$/;
// Reply to the client's keepalive "2" (which Proxmox never answers) so the
// browser can tell a live socket from a half-open one on a flaky network.
const PING_ACK = '\x00pp:{"ack":1}';
// Protocol-level ping to every browser socket; one that misses a round is
// dropped so its Proxmox console session doesn't linger as a ghost.
const HEARTBEAT_MS = 30000;

function createTermProxyServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const url      = new URL(request.url, 'http://localhost');
    const lxcMatch = url.pathname.match(/^\/api\/lxc\/(\d+)\/termproxy$/);
    const isNode   = url.pathname === '/api/node/termproxy';

    if (lxcMatch) {
      // cid: stable per-browser id for size ownership (see sizeOwnership.js).
      // Just a label; an unexpected value gets a throwaway id.
      const rawCid = url.searchParams.get('cid') || '';
      const cid    = CID_RE.test(rawCid) ? rawCid : Math.random().toString(36).slice(2, 12);
      wss.handleUpgrade(request, socket, head, ws => { wss.emit('connection', ws); handleTermConnection(ws, lxcMatch[1], cid); });
    } else if (isNode) {
      wss.handleUpgrade(request, socket, head, ws => { wss.emit('connection', ws); handleTermConnection(ws, null, null); });
    } else {
      socket.destroy();
    }
  });

  async function handleTermConnection(clientWs, vmid, cid) {
    const cfg    = getConfig();
    const agent  = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
    const isNode = vmid === null;
    const label  = isNode ? 'node-shell' : `LXC ${vmid}`;

    let proxmoxWs;
    let conn = null; // size-ownership handle; LXC only — each node shell has its own PTY

    // Registered before the async setup below: a browser that gives up while
    // we're still fetching a ticket must not leave an orphaned console behind.
    const teardown = () => {
      if (conn) ownership.leave(conn);
      if (proxmoxWs && proxmoxWs.readyState !== WebSocket.CLOSED) proxmoxWs.close();
    };
    clientWs.on('close', code => {
      console.log(`[termproxy] ${label}: client disconnected (${code})`);
      teardown();
    });
    clientWs.on('error', err => {
      console.error(`[termproxy] ${label}: client error:`, err.message);
      teardown();
    });

    try {
      const { ticket: pveCookie, csrf } = await consoleAuth.getTicket();

      // Node shell uses /nodes/{node}/termproxy; LXC uses /nodes/{node}/lxc/{vmid}/termproxy
      const termproxyPath = isNode
        ? `/api2/json/nodes/${cfg.proxmox_node}/termproxy`
        : `/api2/json/nodes/${cfg.proxmox_node}/lxc/${vmid}/termproxy`;

      const res = await fetch(`${cfg.proxmox_host}${termproxyPath}`, {
        method:  'POST',
        headers: { Cookie: `PVEAuthCookie=${pveCookie}`, CSRFPreventionToken: csrf },
        agent,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`termproxy API HTTP ${res.status}: ${text.slice(0, 120)}`);
      }

      const { data } = await res.json();
      const { ticket: vncticket, port, user } = data;
      if (clientWs.readyState !== WebSocket.OPEN) return; // browser left mid-setup

      const wsBase    = cfg.proxmox_host.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws');
      const wsockPath = isNode
        ? `/api2/json/nodes/${cfg.proxmox_node}/vncwebsocket`
        : `/api2/json/nodes/${cfg.proxmox_node}/lxc/${vmid}/vncwebsocket`;
      const wsUrl = `${wsBase}${wsockPath}?port=${port}&vncticket=${encodeURIComponent(vncticket)}`;

      proxmoxWs = new WebSocket(wsUrl, ['binary'], {
        agent,
        headers: { origin: cfg.proxmox_host, Cookie: `PVEAuthCookie=${pveCookie}` },
      });

      proxmoxWs.on('open', () => {
        proxmoxWs.send(`${user}:${vncticket}\n`);
        console.log(`[termproxy] ${label} connected`);
      });

      if (!isNode) conn = ownership.join(vmid, cid, clientWs, proxmoxWs);

      proxmoxWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
        // First Proxmox message is the auth "OK"; forwarded above first so the
        // client sees it before the ownership control frame.
        if (conn && !conn.ready) ownership.markReady(conn);
      });
      clientWs.on('message', (data, isBinary) => {
        if (data.length === 1 && data[0] === 0x32) clientWs.send(PING_ACK); // then forwarded
        if (conn && ownership.handleClientFrame(conn, data)) return;
        if (proxmoxWs.readyState === WebSocket.OPEN) proxmoxWs.send(data, { binary: isBinary });
      });

      proxmoxWs.on('close', () => {
        console.log(`[termproxy] ${label}: Proxmox closed`);
        if (conn) ownership.leave(conn);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000);
      });
      proxmoxWs.on('error', err => {
        console.error(`[termproxy] ${label}: Proxmox WS error:`, err.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011);
      });

    } catch (err) {
      console.error(`[termproxy] ${label}: setup failed:`, err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(`\r\n\x1b[31m[Connection failed: ${err.message}]\x1b[0m\r\n`);
        setTimeout(() => clientWs.close(1011), 100);
      }
    }
  }

  console.log('[termproxy] Terminal WebSocket proxy ready');
}

module.exports = { createTermProxyServer };
