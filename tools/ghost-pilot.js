#!/usr/bin/env node
// A pilot with no browser. Joins a sector and flies a slow circle, sending state at 20 Hz.
//
//   node tools/ghost-pilot.js --port 8796 --sector ABCD --callsign WINGMAN
//
// It exists because the client half of co-op cannot be tested with one browser, and testing it
// with two means two WebGL contexts under a software renderer, which wedges the machine before
// it proves anything. This is the second pilot: cheap, headless, and deterministic, so when a
// peer fails to appear on screen the fault is in the client rather than in whatever the other
// browser happened to be doing.
const net = require('node:net');
const crypto = require('node:crypto');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8796));
const SECTOR = arg('sector', null);
const CALLSIGN = arg('callsign', 'GHOST');
const RADIUS = Number(arg('radius', 90));
const SECONDS = Number(arg('seconds', 90));
const LEAD = Number(arg('lead', 2.2));   // seconds ahead of the lead ship to take station
// --swarm N makes the ghost pretend to be the host and broadcast N Swarm ships. It is the only
// way to test the guest half without a second browser, and two WebGL contexts under a software
// renderer do not survive that. The ships fly circles; the point is the wire, not the AI.
const SWARM = Number(arg('swarm', 0));
let gotTicks = 0, gotFoes = 0, foeBytes = 0, lastFoeCount = 0, maxFoeCount = 0, sawWave = null;
const ORIGIN = arg('origin', 'http://127.0.0.1:8777');

let sock, up = false, buf = Buffer.alloc(0), id = null;

function frame(payload) {
  const len = payload.length;
  let head;
  if (len <= 125) head = Buffer.from([0x81, 0x80 | len]);
  else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  const k = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ k[i % 4];
  return Buffer.concat([head, k, out]);
}
const say = (obj) => { if (up) sock.write(frame(Buffer.from(JSON.stringify(obj)))); };

sock = net.connect(PORT, '127.0.0.1', () => {
  sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n`
    + `Origin: ${ORIGIN}\r\nX-Forwarded-For: 10.66.0.${1 + Math.floor(Math.random() * 250)}\r\n\r\n`);
});

let banner = '';
sock.on('data', (chunk) => {
  if (!up) {
    banner += chunk.toString('latin1');
    const i = banner.indexOf('\r\n\r\n');
    if (i < 0) return;
    if (!banner.startsWith('HTTP/1.1 101')) {
      console.error('refused:', banner.split('\r\n')[0]);
      process.exit(1);
    }
    up = true;
    buf = Buffer.from(banner.slice(i + 4), 'latin1');
    const join = { type: 'join', callsign: CALLSIGN, ship: 'striker' };
    if (SECTOR) join.sector = SECTOR.toUpperCase();
    say(join);
  } else buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 2) break;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + len) break;
    const body = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 0x8) { console.log('closed by relay'); process.exit(0); }
    if (op !== 0x1) continue;
    let m; try { m = JSON.parse(body.toString()); } catch { continue; }
    if (m.type === 'welcome') {
      id = m.id;
      console.log(`${CALLSIGN} joined sector ${m.sector} as ${m.host ? 'host' : 'guest'} (${m.players.length} already there)`);
    } else if (m.type === 'enemies') {
      // Counted rather than printed: at 20 Hz the log would be the only thing anyone sees.
      gotFoes++; lastFoeCount = (m.e || []).length; foeBytes += body.length;
      if (lastFoeCount > maxFoeCount) maxFoeCount = lastFoeCount;
    } else if (m.type === 'wave') {
      sawWave = m; console.log(` <- wave ${m.n} (${m.kind})`);
    } else if (m.type === 'enemy_dead') {
      console.log(` <- enemy_dead nid=${m.nid} ${m.type}`);
    } else if (m.type === 'tick') {
      gotTicks++;
      // Fly formation on whoever else is here. The tick carries every pilot's position, so the
      // ghost can hold station on a real player instead of orbiting a fixed point the player
      // leaves behind within seconds -- which is the difference between a peer you can see on
      // screen and a contact somewhere off the back of the scope.
      // Station is taken ahead of the lead, not on their last reported point: a ship doing 40
      // a second leaves that point behind before the next tick, so a ghost that orbits it is
      // permanently astern and never once appears on screen. Extrapolating along their own
      // velocity puts it where they are going, which is where a wingman actually flies.
      for (const k in m.s) if (k !== id) {
        const p = m.s[k].pos, v = m.s[k].vel || [0, 0, 0];
        lead = [p[0] + v[0] * LEAD, p[1] + v[1] * LEAD, p[2] + v[2] * LEAD];
        break;
      }
    } else {
      console.log(' <-', m.type, m.callsign || (m.player && m.player.callsign) || '');
    }
  }
});
sock.on('error', (e) => { console.error('socket:', e.message); process.exit(1); });

// A slow circle, nose along the tangent so the model is not merely sliding sideways -- a peer
// that never rotates would hide an interpolation bug in the rotation. The circle is centred on
// the other pilot once one is seen, and on the launch point until then.
let lead = null;
const t0 = Date.now();
setInterval(() => {
  if (!id) return;
  const t = (Date.now() - t0) / 1000;
  const a = t * 0.35;
  const c = lead || [0, 28, -550];
  const pos = [c[0] + Math.cos(a) * RADIUS, c[1] + 8 + Math.sin(t * 0.7) * 6, c[2] + Math.sin(a) * RADIUS];
  // Yaw-only quaternion facing along the tangent.
  const yaw = a + Math.PI / 2;
  say({
    type: 'state', pos,
    rot: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    vel: [-Math.sin(a) * RADIUS * 0.35, 0, Math.cos(a) * RADIUS * 0.35],
    throttle: 0.6, firing: false, hull: 72, shield: 40, score: 1500, dead: false,
  });
}, 50).unref?.();

// The fake Swarm, when asked for one. A wave event first, because a guest takes the wave from
// an event rather than inferring it from ships trickling in over twenty seconds.
if (SWARM > 0) {
  const types = ['drone', 'lancer', 'warden'];
  setTimeout(() => say({ type: 'wave', n: 1, kind: 'fight' }), 1200);
  setInterval(() => {
    if (!id) return;
    const t = (Date.now() - t0) / 1000;
    const c = lead || [0, 28, -550];
    const rows = [];
    for (let i = 0; i < SWARM; i++) {
      const a = t * 0.5 + (i * Math.PI * 2) / SWARM;
      const R = 70 + (i % 3) * 25;
      const yaw = a + Math.PI / 2;
      rows.push([1000 + i, types[i % types.length],
        r2(c[0] + Math.cos(a) * R), r2(c[1] + 10 + (i % 4) * 6), r2(c[2] + Math.sin(a) * R),
        0, r3(Math.sin(yaw / 2)), 0, r3(Math.cos(yaw / 2)), 40, 'attack']);
    }
    say({ type: 'enemies', e: rows });
  }, 50).unref?.();
}
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

setTimeout(() => {
  console.log(`done -- ticks ${gotTicks}, enemy snapshots ${gotFoes}`
    + (gotFoes ? `, most ships in one ${maxFoeCount}, mean ${Math.round(foeBytes / gotFoes)} bytes` : '')
    + (sawWave ? `, wave ${sawWave.n}` : ''));
  process.exit(0);
}, SECONDS * 1000);
