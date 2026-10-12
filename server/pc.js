'use strict';

// Desktop PC control (folded in from the old pc-control app): online check
// via TCP 22, Wake-on-LAN, and restart/shutdown over SSH. Configured from
// PC_IP / PC_USER / PC_MAC in .env; disabled when any is missing.
const net = require('net');
const { execFile } = require('child_process');

const POLL_MS = 5000;
// Values copied from the old app's .env are quoted; the panel's loader keeps quotes.
const unquote = v => (v || '').replace(/^(["'])(.*)\1$/, '$2');
const [PC_IP, PC_USER, PC_MAC] = ['PC_IP', 'PC_USER', 'PC_MAC'].map(k => unquote(process.env[k]));
const enabled = !!(PC_IP && PC_USER && PC_MAC);

let _online = null;

function probe() {
  return new Promise(resolve => {
    const sock = net.connect({ host: PC_IP, port: 22, timeout: 1000 });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function poll() {
  _online = await probe();
  setTimeout(poll, POLL_MS);
}

function startPolling() {
  if (enabled) poll();
}

// null = not configured (client hides the rail)
function getStatus() {
  return enabled ? { online: _online } : null;
}

const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
const COMMANDS = {
  wake:     () => ['/usr/bin/wakeonlan', [PC_MAC]],
  restart:  () => ['/usr/bin/ssh', [...SSH, `${PC_USER}@${PC_IP}`, 'systemctl reboot 2>/dev/null || shutdown /r /t 0']],
  shutdown: () => ['/usr/bin/ssh', [...SSH, `${PC_USER}@${PC_IP}`, 'systemctl poweroff 2>/dev/null || shutdown /s /t 0']],
};

function runAction(action) {
  return new Promise((resolve, reject) => {
    if (!enabled) return reject(new Error('PC control not configured'));
    const cmd = COMMANDS[action];
    if (!cmd) return reject(new Error('Invalid action'));
    const [file, args] = cmd();
    execFile(file, args, { timeout: 15000 }, (err, stdout, stderr) => {
      // A reboot/poweroff can drop the SSH session before it exits cleanly (255).
      if (err && !(err.code === 255 && /closed by remote host/.test(stderr))) {
        return reject(new Error((stderr || err.message).trim().split('\n').pop()));
      }
      resolve();
    });
  });
}

module.exports = { startPolling, getStatus, runAction, ACTIONS: Object.keys(COMMANDS) };
