'use strict';

// Run with: npm test
const test   = require('node:test');
const assert = require('node:assert');
const own    = require('./sizeOwnership');

const fakeWs = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(String(m)); } });
const ctl = ws => ws.sent.filter(m => m.startsWith('\x00pp:')).map(m => JSON.parse(m.slice(4)));
const frame = s => Buffer.from(s);

// Each test uses its own vmid: sessions live in a module-level map.
function connect(vmid, cid) {
  const conn = own.join(vmid, cid, fakeWs(), fakeWs());
  own.markReady(conn);
  return conn;
}

test('first device owns; a watcher resize is dropped', () => {
  const a = connect('901', 'aaaaaaaa');
  const b = connect('901', 'bbbbbbbb');
  assert.strictEqual(ctl(a.clientWs).at(-1).owner, true);
  assert.strictEqual(ctl(b.clientWs).at(-1).owner, false);

  assert.strictEqual(own.handleClientFrame(a, frame('1:100:40:')), true);
  const before = b.proxmoxWs.sent.length;
  assert.strictEqual(own.handleClientFrame(b, frame('1:50:20:')), true); // consumed, not forwarded
  assert.ok(!b.proxmoxWs.sent.slice(before).includes('1:50:20:'));
  assert.deepStrictEqual(ctl(b.clientWs).at(-1), { owner: false, cols: 100, rows: 40 });
  own.leave(a); own.leave(b);
});

test('a claim flips ownership and resizes every PTY', () => {
  const a = connect('902', 'aaaaaaaa');
  const b = connect('902', 'bbbbbbbb');
  own.handleClientFrame(a, frame('1:100:40:'));
  own.handleClientFrame(b, frame('9:60:30:'));
  assert.deepStrictEqual(ctl(a.clientWs).at(-1), { owner: false, cols: 60, rows: 30, claimed: true });
  assert.strictEqual(ctl(b.clientWs).at(-1).owner, true);
  assert.ok(a.proxmoxWs.sent.includes('1:60:30:'));
  own.leave(a); own.leave(b);
});

test('owner leaving hands over to the most recent device', () => {
  const a = connect('903', 'aaaaaaaa');
  const b = connect('903', 'bbbbbbbb');
  const c = connect('903', 'cccccccc');
  own.leave(a);
  assert.strictEqual(ctl(c.clientWs).at(-1).owner, true);
  assert.strictEqual(ctl(b.clientWs).at(-1).owner, false);
  own.leave(b); own.leave(c);
});

test('input frames and malformed sizes', () => {
  const a = connect('904', 'aaaaaaaa');
  assert.strictEqual(own.handleClientFrame(a, frame('0:1:x')), false); // input: forwarded
  assert.strictEqual(own.handleClientFrame(a, frame('2')), false);     // ping: forwarded
  assert.strictEqual(own.handleClientFrame(a, frame('1:0:5:')), true); // bad size: dropped
  assert.strictEqual(own.handleClientFrame(a, frame('1:5000:5:')), true);
  own.leave(a);
});

test('a reconnect restates the size and bounces it once to force a redraw', async () => {
  const a = connect('905', 'aaaaaaaa');
  own.handleClientFrame(a, frame('1:100:40:'));
  const b = connect('905', 'aaaaaaaa'); // same device, new socket
  assert.deepStrictEqual(b.proxmoxWs.sent.slice(0, 2), ['1:100:40:', '1:100:39:']);
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(b.proxmoxWs.sent.at(-1), '1:100:40:');
  own.leave(a); own.leave(b);
});
