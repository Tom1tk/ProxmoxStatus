'use strict';

// Terminal size ownership for shared LXC consoles.
//
// Every browser connection to an LXC pane runs its own lxc-console, all
// attached to the same container console tty, and lxc-console copies its PTY
// size onto that tty on attach and on every SIGWINCH — so whichever device
// resized last used to dictate the size for everyone. Instead, one client id
// (a browser) owns each vmid's size: only its resizes reach Proxmox, and the
// other connections are kept at the owner's size and told it via a small
// control frame so they can render scaled ("watching"). A client takes
// ownership by sending a claim frame, which it does when the user focuses the
// pane. Frames are Proxmox-protocol-shaped but never forwarded:
//
//   client → server   9:cols:rows:   claim at my desired size
//   server → client   \x00pp:{json}  { owner, cols, rows } (text frame)

const CTL_PREFIX = '\x00pp:';
const MAX_DIM    = 1000;

const sessions = new Map(); // vmid → { ownerId, cols, rows, conns: Set<conn> }

// Parses "1:cols:rows:" / "9:cols:rows:". Returns null when malformed.
function parseDims(data) {
  const [, c, r] = data.toString('latin1').split(':');
  const cols = Number(c), rows = Number(r);
  const ok = n => Number.isInteger(n) && n > 0 && n <= MAX_DIM;
  return ok(cols) && ok(rows) ? { cols, rows } : null;
}

function sendCtl(session, conn) {
  if (conn.clientWs.readyState !== 1) return;
  conn.clientWs.send(CTL_PREFIX + JSON.stringify({
    owner: conn.cid === session.ownerId,
    cols:  session.cols,
    rows:  session.rows,
  }));
}

function broadcastCtl(session) {
  for (const conn of session.conns) if (conn.ready) sendCtl(session, conn);
}

// Keeps every connection's PTY at the owner's size, so any lxc-console that
// re-reads its winsize (attach, SIGWINCH) writes the same value to the tty.
function applySize(session, { cols, rows }) {
  const changed = cols !== session.cols || rows !== session.rows;
  session.cols = cols;
  session.rows = rows;
  const frame = `1:${cols}:${rows}:`;
  for (const conn of session.conns) {
    if (conn.ready && conn.proxmoxWs.readyState === 1) conn.proxmoxWs.send(frame);
  }
  return changed;
}

function join(vmid, cid, clientWs, proxmoxWs) {
  let session = sessions.get(vmid);
  if (!session) {
    session = { ownerId: null, cols: null, rows: null, conns: new Set() };
    sessions.set(vmid, session);
  }
  if (!session.ownerId) session.ownerId = cid;
  const conn = { vmid, cid, clientWs, proxmoxWs, ready: false };
  session.conns.add(conn);
  return conn;
}

// Proxmox has authenticated this connection (sent "OK"). A watcher's
// lxc-console has just attached at its PTY's default size — put it straight
// back to the owner's.
function markReady(conn) {
  const session = sessions.get(conn.vmid);
  if (!session) return;
  conn.ready = true;
  if (session.cols && conn.cid !== session.ownerId && conn.proxmoxWs.readyState === 1) {
    conn.proxmoxWs.send(`1:${session.cols}:${session.rows}:`);
  }
  sendCtl(session, conn);
}

// Returns true when the frame was consumed here and must not be forwarded.
// Hot path: input frames cost one byte comparison.
function handleClientFrame(conn, data) {
  const b0 = data[0];
  if ((b0 !== 0x31 && b0 !== 0x39) || data[1] !== 0x3a) return false;
  const session = sessions.get(conn.vmid);
  if (!session) return false;
  const dims = parseDims(data);
  if (!dims) return true;

  if (b0 === 0x39) {
    session.ownerId = conn.cid;
    applySize(session, dims);
    broadcastCtl(session);
    return true;
  }
  if (conn.cid !== session.ownerId) return true; // watcher resize: drop
  if (applySize(session, dims)) broadcastCtl(session);
  return true;
}

function leave(conn) {
  const session = sessions.get(conn.vmid);
  if (!session || !session.conns.delete(conn)) return;
  if (session.conns.size === 0) {
    sessions.delete(conn.vmid);
    return;
  }
  const ownerPresent = [...session.conns].some(c => c.cid === session.ownerId);
  if (!ownerPresent) {
    // Hand over to the most recently connected device; its next resize (it
    // re-applies geometry on becoming owner) sets the size.
    session.ownerId = [...session.conns].pop().cid;
    broadcastCtl(session);
  }
}

module.exports = { join, markReady, handleClientFrame, leave };
