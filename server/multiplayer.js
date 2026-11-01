// A zero-dependency WebSocket relay for co-op sorties, and the sector state it relays.
//
// Relay, not an authority. The server holds each pilot's last reported position, hull and
// shield and fans them out; it does not simulate flight, projectiles or damage, and it cannot
// tell a true hit report from an invented one. That is a deliberate choice for co-op against
// the game's own AI, where the other pilots are people you invited. It is also the reason this
// must never be the basis for a ranked or public-lobby mode without a real simulation behind
// it: every number below arrives from a client and is believed.
//
// What the server does own is the shape of the traffic. Everything a client sends is bounded --
// frame size, buffer size, message rate, connections per address, pilots per sector -- because
// the endpoint is public and unauthenticated, and an unbounded reader on a public socket is a
// way to stop the process from anywhere in the world.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TICK_RATE_HZ = 20;
const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;
const PLAYER_TIMEOUT_MS = 10_000;
const RESPAWN_MS = 4_000;

// Bounds. A state packet is a few hundred bytes and a join is smaller, so 16 KiB is already
// two orders of magnitude of headroom; the point is that there is a ceiling at all.
const MAX_FRAME = 16 * 1024;        // one frame's declared payload
const MAX_MESSAGE = 32 * 1024;      // a whole message, fragments reassembled
const MAX_BUFFER = 64 * 1024;       // unparsed bytes held for a frame that has not arrived
const MAX_PLAYERS = 16;             // pilots in one sector
const MAX_CONNS_PER_IP = 4;         // sockets from one address
const MSG_PER_SEC = 60;             // 20 Hz of state leaves room for fire and hit reports

// RFC 6455 §7.4.1 close codes, the four this uses.
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_TOO_BIG = 1009;
const CLOSE_POLICY = 1008;

class WebSocketClient extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    // A fragmented message is held here between frames: opcode of the first frame, and the
    // pieces so far. Without this, a continuation frame has no way to say what it continues.
    this.frag = null;
    this.rate = { n: 0, reset: Date.now() + 1000 };

    // A floor listener, and not a decorative one: an EventEmitter that emits 'error' with
    // nobody listening throws, and a socket write to a peer that has just vanished fails
    // asynchronously with EPIPE, so the throw lands outside every try/catch and takes the
    // process with it. Closing a browser tab mid-broadcast is enough to trigger it. Anything
    // that genuinely wants these events can still subscribe; this only guarantees a listener.
    this.on('error', () => {});

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => this._onClose());
    this.socket.on('error', (err) => { this.emit('error', err); this._onClose(); });
    // A socket that connects and then says nothing must not hold a slot forever. This matters
    // more than it looks: a peer that vanishes without a FIN is invisible to the server until
    // something is written to it, and nothing is written to a socket that never joined, so
    // without this its slot against MAX_CONNS_PER_IP is held until the kernel gives up. A
    // joined pilot is never caught by it, because the 20 Hz tick writing to the socket counts
    // as activity; a pilot who goes quiet is caught by the lastSeen check in tick() instead.
    this.socket.setTimeout(PLAYER_TIMEOUT_MS, () => this.close(CLOSE_POLICY, 'idle'));
    this.socket.setKeepAlive(true, 30_000);
    if (this.buffer.length) this._drain();
  }

  _onData(chunk) {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > MAX_BUFFER) {
      // The peer has declared a frame it is not delivering, or is simply flooding. Either way
      // the bytes held on its behalf stop here rather than growing to whatever it asked for.
      return this.close(CLOSE_TOO_BIG, 'buffer');
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._drain();
  }

  _drain() {
    while (!this.closed && this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const rsv = byte0 & 0x70;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      // No extension was negotiated, so a reserved bit set is a peer talking a protocol this
      // one does not speak -- not something to guess at.
      if (rsv) return this.close(CLOSE_PROTOCOL, 'rsv');

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        // Checked as a BigInt, before it is narrowed: Number() past 2^53 rounds, and a length
        // that rounds down past a size check is how an oversized frame gets accepted.
        if (big > BigInt(MAX_FRAME)) return this.close(CLOSE_TOO_BIG, 'frame');
        payloadLen = Number(big);
        offset = 10;
      }
      if (payloadLen > MAX_FRAME) return this.close(CLOSE_TOO_BIG, 'frame');

      // §5.1: every frame from a client is masked. An unmasked one is either a broken client
      // or a cross-protocol attempt by something that is not a WebSocket client at all.
      if (!masked) return this.close(CLOSE_PROTOCOL, 'unmasked');

      const totalLen = offset + 4 + payloadLen;
      if (this.buffer.length < totalLen) return;

      const maskKey = this.buffer.subarray(offset, offset + 4);
      const body = this.buffer.subarray(offset + 4, offset + 4 + payloadLen);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) payload[i] = body[i] ^ maskKey[i % 4];
      this.buffer = this.buffer.subarray(totalLen);

      // Control frames (§5.5) are never fragmented and never longer than 125 bytes, and they
      // may arrive in the middle of a fragmented data message.
      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) return this.close(CLOSE_PROTOCOL, 'control');
        if (opcode === 0x8) return this.close(CLOSE_NORMAL, 'peer');
        if (opcode === 0x9) this._sendFrame(0xa, payload);
        else if (opcode === 0xa) this.emit('pong', payload);
        else return this.close(CLOSE_PROTOCOL, 'opcode');
        continue;
      }

      if (opcode === 0x0) {
        if (!this.frag) return this.close(CLOSE_PROTOCOL, 'orphan continuation');
        this.frag.size += payloadLen;
        if (this.frag.size > MAX_MESSAGE) return this.close(CLOSE_TOO_BIG, 'message');
        this.frag.parts.push(payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.frag) return this.close(CLOSE_PROTOCOL, 'interleaved');
        this.frag = { opcode, parts: [payload], size: payloadLen };
      } else {
        return this.close(CLOSE_PROTOCOL, 'opcode');
      }

      if (!fin) continue;
      const { opcode: kind, parts } = this.frag;
      this.frag = null;
      // Binary carries nothing in this protocol. Say so rather than dropping it silently.
      if (kind === 0x2) return this.close(CLOSE_PROTOCOL, 'binary');
      if (!this._spend()) return;
      try {
        this.emit('message', JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        this.emit('error', new Error('invalid JSON frame'));
      }
    }
  }

  // One token bucket per connection. A client that talks faster than the protocol can possibly
  // need is either broken or amplifying its traffic through the broadcast, and both end here.
  _spend() {
    const now = Date.now();
    if (now > this.rate.reset) { this.rate = { n: 0, reset: now + 1000 }; }
    if (++this.rate.n > MSG_PER_SEC) { this.close(CLOSE_POLICY, 'rate'); return false; }
    return true;
  }

  send(data) {
    if (this.closed || !this.socket.writable) return;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  _sendFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len <= 125) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._onClose();
    }
  }

  close(code = CLOSE_NORMAL, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const body = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const frame = Buffer.alloc(2 + body.length);
      frame.writeUInt16BE(code, 0);
      body.copy(frame, 2);
      this._closing = true;
      const header = Buffer.from([0x88, frame.length]);
      this.socket.write(Buffer.concat([header, frame]), () => this.socket.end());
      // A peer that never acknowledges the close must not hold the socket open.
      setTimeout(() => this.socket.destroy(), 2000).unref();
    } catch {
      this.socket.destroy();
    }
    this.emit('close');
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

// ---------------------------------------------------------------- sector

const SPAWN_SPREAD = 400;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const vec = (v, n) => (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  ? v.map(num) : null);
// Broadcast to every peer, so it is neither markup nor unbounded.
const callsign = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 16);

class Sector {
  constructor(name = 'varan-prime') {
    this.name = name;
    this.players = new Map();
    this.intervalId = null;
  }

  // The tick exists to move state between pilots. With nobody in the sector there is no state
  // and no pilots, so it does not run -- an idle box should be idle.
  _resume() {
    if (this.intervalId || this.players.size === 0) return;
    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.intervalId.unref();
  }
  _idle() {
    if (!this.intervalId || this.players.size > 0) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  full() { return this.players.size >= MAX_PLAYERS; }

  addPlayer(client, joinData) {
    const id = 'pilot_' + crypto.randomBytes(4).toString('hex');
    const player = {
      id,
      callsign: callsign(joinData && joinData.callsign) || 'Viper-' + id.slice(-3),
      ship: callsign(joinData && joinData.ship) || 'interceptor',
      pos: this._spawn(),
      rot: [0, 0, 0, 1],
      vel: [0, 0, 0],
      throttle: 0,
      firing: false,
      hull: 100,
      shield: 100,
      score: 0,
      dead: false,
      lastSeen: Date.now(),
    };

    const existing = [];
    for (const [, e] of this.players) {
      existing.push({
        id: e.player.id, callsign: e.player.callsign, ship: e.player.ship,
        pos: e.player.pos, rot: e.player.rot, hull: e.player.hull, shield: e.player.shield,
      });
    }

    client.send({ type: 'welcome', id, sector: this.name, tickRate: TICK_RATE_HZ, players: existing });
    this.broadcast({
      type: 'player_joined',
      player: { id, callsign: player.callsign, ship: player.ship, pos: player.pos, rot: player.rot },
    }, id);

    this.players.set(id, { client, player });
    client.on('message', (msg) => this.handleMessage(id, msg));
    client.on('close', () => this.removePlayer(id));
    this._resume();
    return id;
  }

  _spawn() {
    const r = () => (Math.random() - 0.5) * SPAWN_SPREAD;
    return [r(), r() * 0.25, r()];
  }

  handleMessage(id, msg) {
    const entry = this.players.get(id);
    if (!entry || !msg || typeof msg !== 'object') return;
    const p = entry.player;
    p.lastSeen = Date.now();

    if (msg.type === 'state') {
      const pos = vec(msg.pos, 3), rot = vec(msg.rot, 4), vel = vec(msg.vel, 3);
      if (pos) p.pos = pos;
      if (rot) p.rot = rot;
      if (vel) p.vel = vel;
      p.throttle = num(msg.throttle);
      p.firing = Boolean(msg.firing);
      return;
    }

    if (msg.type === 'fire') {
      const pos = vec(msg.pos, 3), dir = vec(msg.dir, 3);
      if (p.dead || !pos || !dir) return;
      this.broadcast({ type: 'proj', shooterId: id, weapon: callsign(msg.weapon) || 'pulse', pos, dir }, id);
      return;
    }

    if (msg.type === 'hit') {
      // Believed, not verified -- see the note at the top of this file. The checks here are the
      // ones that keep the relay's own state coherent, not ones that keep a client honest.
      const target = this.players.get(msg.targetId);
      if (!target || p.dead || target.player.dead || target.player.id === id) return;
      const t = target.player;
      const dmg = Math.min(Math.max(num(msg.damage) || 10, 1), 50);
      const absorbed = Math.min(t.shield, dmg);
      t.shield -= absorbed;
      t.hull = Math.max(0, t.hull - (dmg - absorbed));
      this.broadcast({ type: 'damage', targetId: t.id, attackerId: id, shield: t.shield, hull: t.hull });
      if (t.hull <= 0) this._kill(entry, target);
      return;
    }

    if (msg.type === 'ping') entry.client.send({ type: 'pong', t: num(msg.t) });
  }

  // A kill fires once. Before this, a dead pilot stayed in the sector at zero hull and every
  // further hit report re-broadcast the kill and paid the shooter again -- 37 kills and 3700
  // points off one corpse, in the probe that found it.
  _kill(killer, victim) {
    const v = victim.player;
    v.dead = true;
    killer.player.score += 100;
    this.broadcast({
      type: 'kill',
      killerId: killer.player.id, killerCallsign: killer.player.callsign,
      victimId: v.id, victimCallsign: v.callsign,
      respawnIn: RESPAWN_MS,
    });
    setTimeout(() => {
      // The sector may have emptied, or this pilot may have disconnected, while they were down.
      if (!this.players.has(v.id)) return;
      v.dead = false;
      v.hull = 100;
      v.shield = 100;
      v.pos = this._spawn();
      v.vel = [0, 0, 0];
      this.broadcast({ type: 'respawn', id: v.id, pos: v.pos, hull: v.hull, shield: v.shield });
    }, RESPAWN_MS).unref();
  }

  removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    this.players.delete(id);
    this.broadcast({ type: 'player_left', id, callsign: entry.player.callsign });
    this._idle();
  }

  broadcast(msg, excludeId = null) {
    const payload = JSON.stringify(msg);
    for (const [id, entry] of this.players) if (id !== excludeId) entry.client.send(payload);
  }

  tick() {
    const now = Date.now();
    const snapshot = {};
    let count = 0;
    for (const [id, entry] of this.players) {
      if (now - entry.player.lastSeen > PLAYER_TIMEOUT_MS) {
        entry.client.close(CLOSE_POLICY, 'timeout');
        this.removePlayer(id);
        continue;
      }
      const p = entry.player;
      snapshot[id] = {
        pos: p.pos, rot: p.rot, vel: p.vel, thr: p.throttle, fire: p.firing,
        hull: p.hull, shd: p.shield, sc: p.score, dead: p.dead,
      };
      count++;
    }
    if (count > 0) this.broadcast({ type: 'tick', t: now, s: snapshot });
  }

  destroy() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    for (const [, entry] of this.players) entry.client.close(CLOSE_NORMAL, 'shutdown');
    this.players.clear();
  }
}

// ---------------------------------------------------------------- upgrade

function refuse(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  } catch { /* the peer is already gone */ }
  socket.destroy();
}

function peerIp(req) {
  // Same rule as server.js: nginx is the only thing in front and it sets this; take the first
  // hop and believe nothing else in the chain.
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0];
  return (first || req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
}

function handleUpgrade(req, socket, head, sector, opts = {}) {
  const origins = opts.origins;
  const conns = opts.conns;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' && url.pathname !== '/multiplayer') return refuse(socket, 404, 'Not Found');

  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') return refuse(socket, 400, 'Bad Request');

  // A WebSocket handshake is not subject to the same-origin policy, so without this any page
  // on the internet could open a socket here in a visitor's browser and join their sector.
  const origin = req.headers.origin;
  if (origins && !(origin && origins.has(origin))) return refuse(socket, 403, 'Forbidden');

  const ip = peerIp(req);
  if (conns && (conns.get(ip) || 0) >= MAX_CONNS_PER_IP) return refuse(socket, 429, 'Too Many Requests');
  if (sector.full()) return refuse(socket, 503, 'Sector Full');

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  socket.setNoDelay(true);

  if (conns) conns.set(ip, (conns.get(ip) || 0) + 1);
  const client = new WebSocketClient(socket, head);
  client.on('close', () => {
    if (!conns) return;
    const n = (conns.get(ip) || 1) - 1;
    if (n > 0) conns.set(ip, n); else conns.delete(ip);
  });
  // A connection holds no slot in the sector until it says who it is, and a socket that never
  // joins is dropped by the idle timeout in the client.
  client.on('message', function onFirstJoin(msg) {
    if (!msg || msg.type !== 'join') return;
    client.removeListener('message', onFirstJoin);
    if (sector.full()) return client.close(CLOSE_POLICY, 'full');
    sector.addPlayer(client, msg);
  });
}

function initMultiplayer(server, opts = {}) {
  const sector = new Sector(opts.sector || 'varan-prime');
  const conns = new Map();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      handleUpgrade(req, socket, head, sector, { origins: opts.origins, conns });
    } catch (err) {
      console.error('ws upgrade failed', err);
      try { socket.destroy(); } catch { /* already gone */ }
    }
  });
  return sector;
}

module.exports = {
  WebSocketClient, Sector, handleUpgrade, initMultiplayer,
  LIMITS: { MAX_FRAME, MAX_MESSAGE, MAX_BUFFER, MAX_PLAYERS, MAX_CONNS_PER_IP, MSG_PER_SEC },
};
