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
// How long a socket may say nothing before it has joined. It is deliberately far longer than
// the in-sortie timeout, because the two silences mean opposite things: a pilot who stops
// talking mid-fight has gone, while a socket that has not joined yet is usually a device still
// parsing two megabytes of ship models. Ten seconds was enough to refuse a throttled browser
// that was doing nothing wrong -- its join went out at about eight seconds on a fast desktop,
// and the first slow phone would have been dropped before it ever said hello.
const JOIN_GRACE_MS = 45_000;

// Bounds. These were first sized for a protocol that carried one ship per message; co-op adds
// the host's enemy snapshot, which is the largest thing on the wire -- a late wave is about 28
// ships, and at roughly 100 bytes each that is ~3 KiB a tick. 64 KiB leaves an order of
// magnitude of headroom for a boss wave with a capital escort and still bounds the damage: the
// worst case a peer can make the process hold is MAX_BUFFER per socket, so
// 192 KiB x MAX_PLAYERS x MAX_SECTORS, which is about 18 MiB with these numbers.
const MAX_FRAME = 64 * 1024;        // one frame's declared payload
const MAX_MESSAGE = 96 * 1024;      // a whole message, fragments reassembled
const MAX_BUFFER = 192 * 1024;      // unparsed bytes held for a frame that has not arrived
const MAX_PLAYERS = 4;              // pilots in one sector: Gold Lead and three wing stations
const MAX_SECTORS = 24;             // sorties running at once
const MAX_CONNS_PER_IP = 4;         // sockets from one address
// The host is the busiest talker: 20 Hz of its own state, 20 Hz of enemy snapshots, plus wave
// and kill events. 120 leaves room for a burst without leaving room for a flood.
const MSG_PER_SEC = 120;
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no O/0, no I/1 -- these get read aloud

// What a guest may not say. The host owns the Swarm, the wave and the run; a guest claiming any
// of it is either broken or trying, and in both cases the message is dropped rather than relayed.
const HOST_ONLY = new Set(['enemies', 'wave', 'spawn', 'despawn', 'boss', 'field',
  'enemy_damage', 'enemy_dead', 'pickup', 'run_end']);
// What anyone may say, relayed to the rest of the sector untouched. The relay does not model
// any of it -- see the note at the top of this file about what it does and does not own.
const RELAYED = new Set(['fire', 'hit_enemy', 'pilot_down', 'pilot_up', 'flight', 'ready', ...HOST_ONLY]);

// Pilots cannot shoot each other. The scope is co-op, so there is no pilot-versus-pilot damage
// to arbitrate and the relay no longer carries any: an earlier version modelled hull, shields,
// kills and a respawn timer between pilots, and all of it was surface with nothing behind it
// once PvP was cut. What remains is simpler and truer -- a pilot reports their own hull and
// shield on `state`, and the host arbitrates the shared life pool through `pilot_down` and
// `pilot_up` like any other relayed message.

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
    this.socket.setTimeout(JOIN_GRACE_MS, () => this.close(CLOSE_POLICY, 'idle'));
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

  // Called once the pilot is in a sector: from here the tick's lastSeen check is what notices
  // a pilot who has gone quiet, so the socket's own timer can tighten to match.
  settled() {
    if (!this.closed) this.socket.setTimeout(PLAYER_TIMEOUT_MS, () => this.close(CLOSE_POLICY, 'idle'));
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
const pct = (v) => Math.min(100, Math.max(0, num(v)));

class Sector {
  constructor(id, { private: priv = false } = {}) {
    this.id = id;
    this.private = priv;
    this.players = new Map();
    this.hostId = null;
    this.createdAt = Date.now();
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
    if (this.players.size > 0) return;
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    // The sector tells the relay it is empty rather than the relay polling for it. The first
    // version swept from the socket's close handler and the sector was still listed afterwards:
    // that handler is registered in handleUpgrade, before addPlayer registers the sector's own,
    // so it ran first and swept while the leaver was still counted. Found by the harness.
    if (this.onEmpty) this.onEmpty(this);
  }

  full() { return this.players.size >= MAX_PLAYERS; }
  isHost(id) { return this.hostId === id; }

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

    // The first pilot in is the host and stays the host. Nothing hands it on: when the host
    // leaves the sortie ends, because migrating it means transferring the whole enemy state
    // mid-fight and failing in ways nobody can reproduce afterwards.
    const isFirst = this.players.size === 0;
    if (isFirst) this.hostId = id;

    const existing = [];
    for (const [, e] of this.players) {
      existing.push({
        id: e.player.id, callsign: e.player.callsign, ship: e.player.ship,
        pos: e.player.pos, rot: e.player.rot, hull: e.player.hull, shield: e.player.shield,
      });
    }

    client.send({
      type: 'welcome',
      id,
      sector: this.id,
      private: this.private,
      host: isFirst,
      hostId: this.hostId,
      tickRate: TICK_RATE_HZ,
      max: MAX_PLAYERS,
      players: existing,
    });
    this.broadcast({
      type: 'player_joined',
      player: { id, callsign: player.callsign, ship: player.ship, pos: player.pos, rot: player.rot },
    }, id);

    this.players.set(id, { client, player });
    client.settled();
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
      // Self-reported, and correctly so: in co-op nobody else decides how badly you are hurt,
      // and the only thing lying about it buys you is a wrong number over your own ship.
      if (msg.hull !== undefined) p.hull = pct(msg.hull);
      if (msg.shield !== undefined) p.shield = pct(msg.shield);
      if (msg.score !== undefined) p.score = Math.max(0, Math.min(50e6, num(msg.score)));
      if (msg.dead !== undefined) p.dead = Boolean(msg.dead);
      return;
    }

    if (msg.type === 'ping') { entry.client.send({ type: 'pong', t: num(msg.t) }); return; }

    // Co-op traffic: relayed, not modelled. The relay has no idea what an enemy is, which is
    // the point -- the sim lives in the host's browser and this moves bytes for it.
    if (RELAYED.has(msg.type)) {
      if (HOST_ONLY.has(msg.type) && !this.isHost(id)) return;
      msg.from = id;
      this.broadcast(msg, id);
      return;
    }
  }

  removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    const wasHost = this.hostId === id;
    this.players.delete(id);
    if (wasHost && this.players.size > 0) {
      // The sortie cannot continue without the browser that was running it. Say so plainly,
      // then put everyone back on the title screen rather than leaving them flying in a sector
      // where nothing will ever spawn again.
      this.broadcast({ type: 'run_end', reason: 'host_left' });
      for (const [, e] of this.players) e.client.close(CLOSE_NORMAL, 'host left');
      this.players.clear();
      this.hostId = null;
      this._idle();
      return;
    }
    this.broadcast({ type: 'player_left', id, callsign: entry.player.callsign });
    if (this.players.size === 0) this.hostId = null;
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
    this.hostId = null;
  }
}

// ---------------------------------------------------------------- relay

// Owns every sector and the per-address connection count. One of these per process.
class Relay {
  constructor() {
    this.sectors = new Map();
    this.conns = new Map();
  }

  get pilots() {
    let n = 0;
    for (const [, s] of this.sectors) n += s.players.size;
    return n;
  }

  // Public sectors only, and only the two facts the lobby needs. A private sector is absent
  // from this list entirely: its code is the whole of its privacy, so publishing the code
  // would be publishing the sector.
  lobbies() {
    const out = [];
    for (const [, s] of this.sectors) {
      if (s.private) continue;
      out.push({ sector: s.id, pilots: s.players.size, max: MAX_PLAYERS, since: s.createdAt });
    }
    return out.sort((a, b) => b.pilots - a.pilots);
  }

  _code() {
    // Collisions are vanishingly unlikely at 32^4 against at most MAX_SECTORS live sectors,
    // but a retry is two lines and a collision would silently drop someone into a stranger's
    // sortie, which is exactly the kind of bug nobody reports clearly.
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let j = 0; j < 4; j++) c += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)];
      if (!this.sectors.has(c)) return c;
    }
    return null;
  }

  _create(priv) {
    if (this.sectors.size >= MAX_SECTORS) return null;
    const code = this._code();
    if (!code) return null;
    const s = new Sector(code, { private: priv });
    s.onEmpty = () => { s.destroy(); this.sectors.delete(code); };
    this.sectors.set(code, s);
    return s;
  }

  // Three ways in, in the order a join is checked:
  //   a named sector   -> that one, if it exists and has room
  //   create: private  -> a new unlisted sector
  //   anything else    -> matchmake into the fullest public sector that still has room, so
  //                       pilots pool together instead of each sitting alone in their own
  sectorFor(join) {
    const want = typeof join.sector === 'string' ? join.sector.toUpperCase().slice(0, 4) : null;
    if (want) {
      const s = this.sectors.get(want);
      if (!s) return { error: 'no such sector' };
      if (s.full()) return { error: 'sector full' };
      return { sector: s };
    }
    if (join.create === 'private') {
      const s = this._create(true);
      return s ? { sector: s } : { error: 'no sectors free' };
    }
    let best = null;
    for (const [, s] of this.sectors) {
      if (s.private || s.full()) continue;
      if (!best || s.players.size > best.players.size) best = s;
    }
    if (best) return { sector: best };
    const s = this._create(false);
    return s ? { sector: s } : { error: 'no sectors free' };
  }

  sweep() {
    for (const [id, s] of this.sectors) if (s.players.size === 0) { s.destroy(); this.sectors.delete(id); }
  }

  destroy() {
    for (const [, s] of this.sectors) s.destroy();
    this.sectors.clear();
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

function handleUpgrade(req, socket, head, relay, opts = {}) {
  const origins = opts.origins;
  const conns = relay.conns;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' && url.pathname !== '/multiplayer') return refuse(socket, 404, 'Not Found');

  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['sec-websocket-version'] !== '13') return refuse(socket, 400, 'Bad Request');

  // A WebSocket handshake is not subject to the same-origin policy, so without this any page
  // on the internet could open a socket here in a visitor's browser and join their sector.
  const origin = req.headers.origin;
  if (origins && !(origin && origins.has(origin))) return refuse(socket, 403, 'Forbidden');

  const ip = peerIp(req);
  if ((conns.get(ip) || 0) >= MAX_CONNS_PER_IP) return refuse(socket, 429, 'Too Many Requests');

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  socket.setNoDelay(true);

  conns.set(ip, (conns.get(ip) || 0) + 1);
  const client = new WebSocketClient(socket, head);
  client.on('close', () => {
    const n = (conns.get(ip) || 1) - 1;
    if (n > 0) conns.set(ip, n); else conns.delete(ip);
    // Deferred, and only a safety net: a sector normally reaps itself through onEmpty. This
    // covers a socket that was handed a freshly created sector and died before it ever joined.
    setImmediate(() => relay.sweep());
  });
  // A connection holds no slot in any sector until it says who it is, and a socket that never
  // joins is dropped by the idle timeout in the client.
  client.on('message', function onFirstJoin(msg) {
    if (!msg || msg.type !== 'join') return;
    client.removeListener('message', onFirstJoin);
    const got = relay.sectorFor(msg);
    // Closed rather than left hanging: the client distinguishes 1008 from a dropped connection
    // and shows the reason instead of retrying something that will be refused again.
    if (got.error) return client.close(CLOSE_POLICY, got.error);
    got.sector.addPlayer(client, msg);
  });
}

function initMultiplayer(server, opts = {}) {
  const relay = new Relay();
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    try {
      handleUpgrade(req, socket, head, relay, { origins: opts.origins });
    } catch (err) {
      console.error('ws upgrade failed', err);
      try { socket.destroy(); } catch { /* already gone */ }
    }
  });
  return relay;
}

module.exports = {
  WebSocketClient, Sector, Relay, handleUpgrade, initMultiplayer,
  LIMITS: { MAX_FRAME, MAX_MESSAGE, MAX_BUFFER, MAX_PLAYERS, MAX_SECTORS, MAX_CONNS_PER_IP, MSG_PER_SEC },
};
