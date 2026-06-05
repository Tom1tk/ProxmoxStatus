'use strict';

const https = require('https');
const fetch = require('node-fetch');
const { WebSocketServer, WebSocket } = require('ws');
const { getConfig }   = require('./config');
const consoleAuth     = require('./console');

function createTermProxyServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url      = new URL(request.url, 'http://localhost');
    const lxcMatch = url.pathname.match(/^\/api\/lxc\/(\d+)\/termproxy$/);
    const isNode   = url.pathname === '/api/node/termproxy';

    if (lxcMatch) {
      wss.handleUpgrade(request, socket, head, ws => handleTermConnection(ws, lxcMatch[1]));
    } else if (isNode) {
      wss.handleUpgrade(request, socket, head, ws => handleTermConnection(ws, null));
    } else {
      socket.destroy();
    }
  });

  async function handleTermConnection(clientWs, vmid) {
    const cfg    = getConfig();
    const agent  = new https.Agent({ rejectUnauthorized: cfg.verify_ssl });
    const isNode = vmid === null;
    const label  = isNode ? 'node-shell' : `LXC ${vmid}`;

    let proxmoxWs;

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

      proxmoxWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
      });
      clientWs.on('message', (data, isBinary) => {
        if (proxmoxWs.readyState === WebSocket.OPEN) proxmoxWs.send(data, { binary: isBinary });
      });

      proxmoxWs.on('close', () => {
        console.log(`[termproxy] ${label}: Proxmox closed`);
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
      return;
    }

    clientWs.on('close', code => {
      console.log(`[termproxy] ${label}: client disconnected (${code})`);
      if (proxmoxWs && proxmoxWs.readyState !== WebSocket.CLOSED) proxmoxWs.close();
    });
    clientWs.on('error', err => {
      console.error(`[termproxy] ${label}: client error:`, err.message);
      if (proxmoxWs && proxmoxWs.readyState !== WebSocket.CLOSED) proxmoxWs.close();
    });
  }

  console.log('[termproxy] Terminal WebSocket proxy ready');
}

module.exports = { createTermProxyServer };
