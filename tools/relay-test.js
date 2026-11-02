#!/usr/bin/env node
// Exercises the co-op relay over real sockets. Run it against a server you started yourself:
//
//   DB_PATH=/tmp/t.db PORT=8796 GEO=0 node server/server.js &
//   node tools/relay-test.js 8796
//
// Everything here goes through a socket on purpose. Every defect this file has ever caught --
// a sector that would not reap, an EventEmitter 'error' with no listener that killed the whole
// process when a tab closed mid-broadcast -- was invisible in the diff and obvious the moment
// something ran. Reading the code caught cosmetics; running it caught the bugs.
//
// Each client gets its own X-Forwarded-For. That is how the relay sees distinct pilots in
// production, since nginx sets it, and it keeps the per-address connection cap from masking
// the per-sector one -- a confusion that once turned a real test into a skipped one.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 8796);
const HOST = '127.0.0.1';
const ORIGIN = 'https://sortiethegame.com';
let pass = 0, fail = 0;
let ipN = 0;
const nextIp = () => `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ${name.padEnd(26)} PASS`); }
  else { fail++; console.log(`  ${name.padEnd(26)} FAIL ${detail}`); }
}

function mask(opcode, payload, { fin = true, masked = true } = {}) {
  const len = payload.length;
  let head;
  const f = (fin ? 0x80 : 0) | opcode;
  const m = masked ? 0x80 : 0;
  if (len <= 125) head = Buffer.from([f, m | len]);
  else if (len <= 65535) { head = Buffer.alloc(4); head[0] = f; head[1] = m | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = f; head[1] = m | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  if (!masked) return Buffer.concat([head, payload]);
  const k = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ k[i % 4];
  return Buffer.concat([head, k, out]);
}

// A minimal client: handshake, decode server frames (never masked), collect messages.
function connect({ origin = ORIGIN, ip = null, path = '/ws' } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    const key = crypto.randomBytes(16).toString('base64');
    let banner = '', up = false, buf = Buffer.alloc(0);
    const c = {
      sock, msgs: [], closeCode: null, status: null, ended: false,
      send(obj) { if (up) sock.write(mask(0x1, Buffer.from(JSON.stringify(obj)))); },
      raw(b) { sock.write(b); },
      welcome() { return this.msgs.find((m) => m.type === 'welcome'); },
      seen(type) { return this.msgs.filter((m) => m.type === type); },
      bye() { try { sock.destroy(); } catch { /* gone */ } },
    };
    sock.on('connect', () => sock.write(
      `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`
      + (origin ? `Origin: ${origin}\r\n` : '')
      + (ip ? `X-Forwarded-For: ${ip}\r\n` : '') + '\r\n'));
    sock.on('data', (chunk) => {
      if (!up) {
        banner += chunk.toString('latin1');
        const i = banner.indexOf('\r\n\r\n');
        if (i < 0) return;
        c.status = Number(banner.slice(9, 12));
        if (c.status !== 101) { sock.destroy(); return resolve(c); }
        up = true;
        buf = Buffer.from(banner.slice(i + 4), 'latin1');
        resolve(c);
      } else buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) break;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const body = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x8) c.closeCode = body.length >= 2 ? body.readUInt16BE(0) : 1005;
        else if (op === 0x1) { try { c.msgs.push(JSON.parse(body.toString())); } catch { /* not ours */ } }
      }
    });
    sock.on('close', () => { c.ended = true; });
    sock.on('error', () => resolve(c));
    setTimeout(() => resolve(c), 1200);
  });
}

async function join(opts, extra = {}) {
  const c = await connect({ ip: nextIp(), ...opts });
  if (c.status === 101) c.send({ type: 'join', callsign: 'TEST', ...extra });
  await wait(250);
  return c;
}
const api = async (p) => (await fetch(`http://${HOST}:${PORT}${p}`)).json();

async function sectors() {
  console.log('\nsectors and lobbies');
  const a = await join({}, { callsign: 'LEAD' });
  const b = await join({}, { callsign: 'TWO' });
  const wa = a.welcome(), wb = b.welcome();
  ok('quick match shares sector', wa && wb && wa.sector === wb.sector, wa && wb ? `${wa.sector} vs ${wb.sector}` : 'no welcome');
  ok('first pilot is host', wa && wa.host === true && wb && wb.host === false, `${wa && wa.host} / ${wb && wb.host}`);
  ok('both agree who hosts', wa && wb && wa.hostId === wb.hostId);
  ok('welcome states the cap', wa && wa.max === 4, wa && wa.max);

  const pub = await api('/api/lobbies');
  ok('public sector is listed', pub.lobbies.some((l) => l.sector === wa.sector));

  const p = await join({}, { create: 'private', callsign: 'SOLO' });
  const wp = p.welcome();
  const after = await api('/api/lobbies');
  ok('private sector is hidden', wp && wp.private === true && after.lobbies.every((l) => l.sector !== wp.sector));

  const byCode = await join({}, { sector: wp.sector, callsign: 'GUEST' });
  ok('join by code works', byCode.welcome() && byCode.welcome().sector === wp.sector);

  const nope = await join({}, { sector: 'ZZZZ' });
  ok('unknown code refused', !nope.welcome() && nope.closeCode === 1008, `close ${nope.closeCode}`);

  [a, b, p, byCode, nope].forEach((c) => c.bye());
  await wait(400);
}

async function caps() {
  console.log('\ncaps');
  const host = await join({}, { create: 'private', callsign: 'LEAD' });
  const code = host.welcome().sector;
  const held = [host];
  for (let i = 2; i <= 4; i++) held.push(await join({}, { sector: code, callsign: 'W' + i }));
  ok('four pilots fit', held.filter((c) => c.welcome()).length === 4);

  const fifth = await join({}, { sector: code, callsign: 'FIVE' });
  ok('fifth pilot refused', !fifth.welcome() && fifth.closeCode === 1008, `close ${fifth.closeCode}`);

  // The per-address cap is separate, and only visible when several sockets share an address.
  const ip = nextIp();
  const same = [];
  for (let i = 0; i < 6; i++) same.push(await connect({ ip }));
  ok('per-address cap holds', same.filter((c) => c.status === 101).length === 4,
    same.map((c) => c.status).join(' '));

  [...held, fifth, ...same].forEach((c) => c.bye());
  await wait(400);
}

async function authority() {
  console.log('\nhost authority');
  const host = await join({}, { create: 'private', callsign: 'LEAD' });
  const code = host.welcome().sector;
  const guest = await join({}, { sector: code, callsign: 'TWO' });

  guest.send({ type: 'wave', n: 3 });
  await wait(300);
  ok('guest cannot run the wave', host.seen('wave').length === 0, `host saw ${host.seen('wave').length}`);

  host.send({ type: 'wave', n: 3 });
  await wait(300);
  const w = guest.seen('wave')[0];
  ok('host can run the wave', !!w && w.n === 3);
  ok('relayed message is attributed', w && w.from === host.welcome().id);
  ok('sender is not echoed to', host.seen('wave').length === 0);

  guest.send({ type: 'fire', pos: [0, 0, 0], dir: [0, 0, 1] });
  await wait(300);
  ok('anyone may fire', host.seen('fire').length === 1);

  guest.send({ type: 'state', pos: [1, 2, 3], rot: [0, 0, 0, 1], hull: 40, shield: 0 });
  await wait(300);
  const t = host.seen('tick').pop();
  const g = t && t.s[guest.welcome().id];
  ok('state carries own damage', g && g.hull === 40 && g.shd === 0, g && `${g.hull}/${g.shd}`);

  host.bye();
  await wait(400);
  ok('host leaving ends the run', guest.seen('run_end').some((m) => m.reason === 'host_left'));
  guest.bye();
  await wait(400);

  const h = await api('/api/health');
  ok('sector is reaped', h.sectors === 0 && h.pilots === 0, JSON.stringify(h));
}

async function hardening() {
  console.log('\nhardening');
  const bad = await connect({ origin: 'https://evil.example', ip: nextIp() });
  ok('foreign origin refused', bad.status === 403, String(bad.status));
  const none = await connect({ origin: null, ip: nextIp() });
  ok('missing origin refused', none.status === 403, String(none.status));

  // Ten bytes of header declaring a terabyte, then a dribble. Nothing must be buffered towards it.
  const big = await connect({ ip: nextIp() });
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81; hdr[1] = 0xff; hdr.writeBigUInt64BE(1n << 40n, 2);
  big.raw(hdr); big.raw(Buffer.alloc(4096));
  await wait(300);
  ok('oversized frame refused', big.closeCode === 1009, `close ${big.closeCode}`);

  const um = await connect({ ip: nextIp() });
  um.raw(mask(0x1, Buffer.from('{"type":"ping"}'), { masked: false }));
  await wait(300);
  ok('unmasked frame refused', um.closeCode === 1002, `close ${um.closeCode}`);

  // Browsers fragment large messages; a join split across two frames must still arrive.
  const fr = await connect({ ip: nextIp() });
  const s = JSON.stringify({ type: 'join', callsign: 'FRAG' });
  fr.raw(mask(0x1, Buffer.from(s.slice(0, 12)), { fin: false }));
  fr.raw(mask(0x0, Buffer.from(s.slice(12)), { fin: true }));
  await wait(350);
  ok('fragmented join accepted', !!fr.welcome());

  const fast = await join({}, { callsign: 'FAST' });
  for (let i = 0; i < 400; i++) fast.send({ type: 'ping', t: i });
  await wait(400);
  ok('message flood refused', fast.closeCode === 1008, `close ${fast.closeCode}`);

  const nasty = await join({}, { callsign: '<img src=x onerror=1> OVERLONG NAME' });
  const sitter = await join({}, { sector: nasty.welcome().sector, callsign: 'SIT' });
  await wait(300);
  const seen = sitter.welcome().players[0];
  ok('callsign is sanitised', seen && !/[<>=]/.test(seen.callsign), seen && JSON.stringify(seen.callsign));

  [bad, none, big, um, fr, fast, nasty, sitter].forEach((c) => c.bye());
  await wait(400);
}

async function board() {
  console.log('\nco-op board');
  const post = async (b) => {
    const r = await fetch(`http://${HOST}:${PORT}/api/coop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
    });
    return { code: r.status, body: await r.json() };
  };
  const base = { name: 'TST', pilots: 4, score: 240000, wave: 7, kills: 90, shots: 600, hits: 400, rocks: 12, seconds: 520 };
  const id = () => 'test-' + crypto.randomBytes(8).toString('hex');

  ok('solo run rejected', (await post({ ...base, flight: id(), pilots: 1 })).body.why?.includes('pilots-range'));
  ok('impossible score rejected', (await post({ ...base, flight: id(), score: 99e6 })).body.why?.includes('score>ceiling'));
  ok('impossible pace rejected', (await post({ ...base, flight: id(), wave: 9, seconds: 20 })).body.why?.includes('too-fast'));
  ok('short flight id rejected', (await post({ ...base, flight: 'abc' })).code === 400);

  const f = id();
  const first = await post({ ...base, flight: f });
  ok('plausible run accepted', first.code === 201 && first.body.rank >= 1, String(first.code));
  const again = await post({ ...base, flight: f });
  ok('same flight not doubled', again.body.duplicate === true && again.body.rank === first.body.rank);

  const solo = await (await fetch(`http://${HOST}:${PORT}/api/scores`)).json();
  ok('solo board untouched', solo.board.every((r) => r.name !== 'TST'));
}

(async () => {
  try {
    await api('/api/health');
  } catch {
    console.error(`No server on ${HOST}:${PORT}. Start one first:\n  DB_PATH=/tmp/t.db PORT=${PORT} GEO=0 node server/server.js &`);
    process.exit(2);
  }
  await sectors();
  await caps();
  await authority();
  await hardening();
  await board();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
