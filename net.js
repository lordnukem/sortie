// The socket, and nothing else.
//
// This file owns the connection to the co-op relay: dialling it, rejoining after it drops,
// pushing this pilot's state up at a fixed rate, and buffering what comes back so the render
// loop can ask "where was that ship 100ms ago" without knowing a socket exists. The game never
// touches a WebSocket; it reads `peers` and calls `sample()`.
//
// It lives outside index.html deliberately. docs/workflow.md allows one writer on the game file
// at a time, and this is the part most likely to want a second pair of eyes.
//
// Two things here are not obvious and are the reason the rest works:
//
//   - **Everything is timed on local arrival, never on the server's clock.** Snapshots carry a
//     server timestamp and it is deliberately ignored for interpolation. Trusting it would mean
//     estimating the offset between two clocks and tracking its drift, and getting that subtly
//     wrong shows up as ships that stutter or slide. Arrival time needs no agreement with
//     anybody.
//   - **The relay ticks at 20Hz and the game draws at 60+.** Drawing the newest snapshot gives
//     20Hz stutter on every other ship, so peers are rendered INTERP_MS in the past, between the
//     two snapshots that bracket that moment. The cost is that everyone sees everyone else
//     slightly late, which is the standard trade and invisible in play.

export const PROTO = 1;

// How far behind live to draw other pilots. One relay tick is 50ms, so this is two ticks of slack:
// enough that a late packet is covered by the buffer instead of becoming a visible hitch, and
// short enough that nobody is aiming at a meaningfully stale ship.
const INTERP_MS = 100;
// Snapshots older than this are dropped. Long enough to interpolate through a hiccup, short
// enough that a peer who has been gone a while does not leave a trail to extrapolate from.
const BUFFER_MS = 1000;
const STATE_HZ = 20;
const PING_MS = 3000;
// Reconnect backoff. A phone that backgrounds the tab drops the socket, and coming back to a
// dead sortie is worse than no multiplayer at all -- so this retries for a good while, but with
// a ceiling so a relay that is genuinely down is not hammered.
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 8000, 15000];

const now = () => performance.now();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
// Four decimals is finer than a metre at this scale and roughly halves the bytes on the wire.
const q = (n) => Math.round(n * 1e4) / 1e4;

// Where the relay lives. The rule is the same one index.html uses to find the API, and for the
// same reason: a host that serves /api also serves /ws behind the same nginx, so the socket is
// same-origin there and the port follows the page. Everywhere else -- GitHub Pages, which is a
// different origin entirely -- it is absolute. That cross-origin case is exactly why the relay
// checks Origin against an allowlist.
const SAME_ORIGIN = ['sortiethegame.com', 'www.sortiethegame.com', '72.62.196.152', '127.0.0.1', 'localhost'];
export function relayURL() {
  if (!SAME_ORIGIN.includes(location.hostname)) return 'wss://sortiethegame.com/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

// One other pilot, as the game sees them: who they are, what they are flying, and a short
// history of where they have been.
// A short history of where something was. Pilots and enemies both need one and the problem is
// identical for both, so it lives here once rather than twice: the only difference between a
// peer and a Swarm fighter, as far as drawing them smoothly goes, is who is reporting them.
class Track {
  constructor() { this.buf = []; }
  push(s) {
    const at = now();
    // Out-of-order arrival is rare but not impossible, and a snapshot inserted behind the
    // newest one would make sample() interpolate backwards. Drop it rather than sort.
    if (this.buf.length && at < this.buf[this.buf.length - 1].at) return;
    this.buf.push({ at, ...s });
    const cut = at - BUFFER_MS;
    while (this.buf.length > 2 && this.buf[0].at < cut) this.buf.shift();
  }
}

class Peer {
  constructor(d) {
    this.id = d.id;
    this.callsign = d.callsign || '????';
    this.ship = d.ship || 'striker';
    this.hull = d.hull ?? 100;
    this.shield = d.shield ?? 100;
    this.score = d.score ?? 0;
    this.dead = false;
    this.obj = null;         // the game hangs its THREE.Group here
    this.track = new Track();
  }
  get buf() { return this.track.buf; }
  push(s) { this.track.push(s); }
}

// One Swarm ship as a guest sees it. `st` is the host's AI state, carried only so the guest can
// mirror things the state drives -- a ship in 'show' is not on the scope yet, for instance.
class Foe {
  constructor(id, type) {
    this.id = id;
    this.type = type;
    this.hp = 1;
    this.st = '';
    this.obj = null;
    this.track = new Track();
  }
  get buf() { return this.track.buf; }
}

export class Net {
  constructor() {
    this.status = 'idle';          // idle | connecting | open | reconnecting | closed
    this.self = null;              // { id, callsign, host }
    this.sector = null;
    this.private = false;
    this.peers = new Map();
    this.foes = new Map();         // the Swarm, as reported by whoever is hosting
    this.wave = null;              // { n, kind } from the host's last wave event
    this.rtt = 0;
    this.error = null;
    this.ws = null;
    this._handlers = new Map();
    this._want = null;             // the join we are trying to hold, kept for reconnects
    this._tries = 0;
    this._timer = null;
    this._stateAt = 0;
    this._foeAt = 0;
    this._pingAt = 0;
    this._closing = false;
  }

  // --- events -------------------------------------------------------------
  // Any message type can be subscribed to, including ones this file knows nothing about, so
  // enemy replication can be built on top without reopening the transport.
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type).delete(fn);
  }
  _emit(type, msg) {
    const hs = this._handlers.get(type);
    if (!hs) return;
    // A throwing handler must not take the socket down with it.
    for (const fn of hs) { try { fn(msg); } catch (err) { console.error(`net: ${type} handler failed`, err); } }
  }

  // --- connection ---------------------------------------------------------
  // `want` is { callsign, ship, sector, code }. It is remembered, because a reconnect has to
  // ask for the same sector rather than being matchmade somewhere else mid-sortie.
  connect(want) {
    this._want = { ...want };
    this._closing = false;
    this._tries = 0;
    return this._open();
  }

  _open() {
    clearTimeout(this._timer);
    this.status = this._tries ? 'reconnecting' : 'connecting';
    this.error = null;
    this._emit('status', { status: this.status, tries: this._tries });
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(relayURL());
      } catch (err) {
        // A malformed URL or a blocked scheme fails here rather than on the socket.
        this._fail(err.message || 'cannot open socket');
        return resolve(false);
      }
      this.ws = ws;
      this._resolve = resolve;

      ws.onopen = () => {
        this._tries = 0;
        this.send('join', {
          proto: PROTO,
          callsign: this._want.callsign,
          ship: this._want.ship,
          sector: this._want.sector || undefined,
          code: this._want.code || undefined,
        });
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg && typeof msg.type === 'string') this._inbound(msg);
      };
      // onclose fires for every ending, clean or not, so the retry lives there alone -- onerror
      // would otherwise schedule a second attempt for the same drop.
      ws.onerror = () => { this.error = 'connection failed'; };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        const settled = this.status === 'open';
        this.peers.clear();
        if (this._closing) {
          this.status = 'closed';
          this._emit('status', { status: this.status });
          return;
        }
        // 1008 is the relay refusing us -- full sector, wrong code, rate limit. Retrying would
        // only be refused again, so surface it instead of looping.
        if (e.code === 1008) return this._fail(e.reason || 'refused');
        this._retry();
        if (!settled && this._resolve) { this._resolve(false); this._resolve = null; }
      };
    });
  }

  _retry() {
    const wait = BACKOFF_MS[Math.min(this._tries, BACKOFF_MS.length - 1)];
    this._tries++;
    this.status = 'reconnecting';
    this._emit('status', { status: this.status, tries: this._tries, wait });
    this._timer = setTimeout(() => this._open(), wait);
  }

  _fail(reason) {
    this.error = reason;
    this.status = 'closed';
    this._emit('status', { status: this.status, error: reason });
    this._emit('error', { reason });
    if (this._resolve) { this._resolve(false); this._resolve = null; }
  }

  close() {
    this._closing = true;
    clearTimeout(this._timer);
    this.peers.clear();
    this.self = null;
    if (this.ws) { try { this.ws.close(1000, 'leave'); } catch { /* already gone */ } }
    this.ws = null;
    this.status = 'closed';
    this._emit('status', { status: this.status });
  }

  get connected() { return this.status === 'open' && this.ws && this.ws.readyState === 1; }
  get host() { return !!(this.self && this.self.host); }

  // --- outbound -----------------------------------------------------------
  send(type, payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    } catch {
      return false;
    }
  }

  // Called every frame; sends at STATE_HZ. The relay caps messages per second and a 60fps game
  // pushing state every frame would spend that budget three times over on its own. It is also
  // what keeps the connection alive: the relay drops a pilot who has said nothing for ten
  // seconds, so this runs on the title screen too, not only in a sortie.
  //
  // `extra` carries hull, shield, score and dead. Those are self-reported, which is correct in
  // co-op: nobody else gets a say in how badly you are hurt, and the only thing lying about it
  // buys you is a wrong number over your own ship.
  tickState(pos, rot, vel, extra = {}) {
    if (!this.connected) return;
    const t = now();
    if (t - this._stateAt < 1000 / STATE_HZ) return;
    this._stateAt = t;
    this.send('state', {
      pos: [q(pos.x), q(pos.y), q(pos.z)],
      rot: [q(rot.x), q(rot.y), q(rot.z), q(rot.w)],
      vel: [q(vel.x), q(vel.y), q(vel.z)],
      throttle: q(extra.throttle || 0),
      firing: !!extra.firing,
      hull: q(extra.hull ?? 100),
      shield: q(extra.shield ?? 100),
      score: Math.round(extra.score || 0),
      dead: !!extra.dead,
    });
    if (t - this._pingAt > PING_MS) { this._pingAt = t; this.send('ping', { t }); }
  }

  // The Swarm, from the host. One flat array per ship rather than an object: at 28 ships
  // twenty times a second the key names cost more than the numbers do, and this is the largest
  // thing on the wire by a wide margin.
  //   [ id, type, x, y, z, qx, qy, qz, qw, hp, state ]
  sendFoes(list) {
    if (!this.connected || !this.host) return;
    const t = now();
    if (t - this._foeAt < 1000 / STATE_HZ) return;
    this._foeAt = t;
    this.send('enemies', { e: list });
  }

  _foes(msg) {
    const seen = new Set();
    for (const row of msg.e || []) {
      const [id, type, x, y, z, qx, qy, qz, qw, hp, st] = row;
      seen.add(id);
      let f = this.foes.get(id);
      if (!f) { f = new Foe(id, type); this.foes.set(id, f); }
      f.hp = hp; f.st = st;
      f.track.push({ pos: [x, y, z], rot: [qx, qy, qz, qw], vel: null });
    }
    // Absent from the snapshot means gone. A separate death event carries the explosion, but
    // this is what guarantees the guest's world cannot drift from the host's -- a missed event
    // costs a bang, not a ship that lives for ever.
    for (const id of [...this.foes.keys()]) if (!seen.has(id)) this.foes.delete(id);
  }

  // --- inbound ------------------------------------------------------------
  _inbound(msg) {
    switch (msg.type) {
      case 'welcome': {
        // A reconnect can come back with a different role: the sector may have been reaped and
        // rebuilt, or someone else may have taken it while we were away. The game has to be
        // told, because a client that was simulating the Swarm and is now a guest no longer
        // owns the world it is holding.
        const was = this.self && this.self.host;
        this.self = { id: msg.id, callsign: this._want.callsign, host: !!msg.host };
        if (was !== undefined && was !== this.self.host) this._emit('role', { host: this.self.host, was });
        this.sector = msg.sector;
        this.private = !!msg.private;
        this.peers.clear();
        this.foes.clear();
        for (const p of msg.players || []) this.peers.set(p.id, new Peer(p));
        this.status = 'open';
        this._emit('status', { status: this.status });
        if (this._resolve) { this._resolve(true); this._resolve = null; }
        break;
      }

      case 'player_joined':
        if (msg.player && msg.player.id !== (this.self && this.self.id)) {
          this.peers.set(msg.player.id, new Peer(msg.player));
        }
        break;

      case 'player_left':
        this.peers.delete(msg.id);
        break;

      case 'host':
        // The relay names the host on welcome and again if it ever changes hands.
        if (this.self) this.self.host = msg.id === this.self.id;
        break;

      case 'tick':
        for (const id in msg.s) {
          if (this.self && id === this.self.id) continue;
          const p = this.peers.get(id);
          if (!p) continue;            // a snapshot for someone whose join has not arrived yet
          const s = msg.s[id];
          p.hull = s.hull; p.shield = s.shd; p.score = s.sc; p.dead = !!s.dead;
          p.push({ pos: s.pos, rot: s.rot, vel: s.vel, thr: s.thr, fire: s.fire });
        }
        break;

      // There is no case for pilot damage, and that is deliberate: pilots cannot shoot each
      // other. Hull, shield and death arrive on `state`, self-reported by the pilot they
      // belong to, which in co-op is the only party with anything to say about them.

      case 'enemies':
        if (!this.host) this._foes(msg);
        break;

      case 'wave':
        if (!this.host) this.wave = { n: msg.n, kind: msg.kind };
        break;

      case 'pong':
        if (typeof msg.t === 'number') this.rtt = Math.round(now() - msg.t);
        break;
    }
    this._emit(msg.type, msg);
    this._emit('*', msg);
  }

  // --- interpolation ------------------------------------------------------
  // Where this peer was INTERP_MS ago, as {pos:[x,y,z], rot:[x,y,z,w], t} in the arrays the
  // snapshots already use -- the caller copies them into whatever vector type it keeps.
  // Returns null when there is nothing to draw yet.
  sample(thing, at = now()) {
    const b = thing.buf;
    if (!b.length) return null;
    const want = at - INTERP_MS;

    // Before the buffer starts: nothing to interpolate towards, so hold the oldest pose rather
    // than inventing one.
    if (want <= b[0].at) return { pos: b[0].pos, rot: b[0].rot, t: 0 };

    for (let i = b.length - 1; i > 0; i--) {
      const hi = b[i], lo = b[i - 1];
      if (want >= lo.at && want <= hi.at) {
        const span = hi.at - lo.at;
        const t = span > 0 ? clamp((want - lo.at) / span, 0, 1) : 1;
        return { pos: lerp3(lo.pos, hi.pos, t), rot: slerpQ(lo.rot, hi.rot, t), t };
      }
    }

    // Past the newest snapshot: the peer has gone quiet. Carry them forward on their last
    // velocity for a short while so a single dropped packet is not a freeze, then stop --
    // extrapolating a ship that has genuinely stopped sending invents a flight path.
    const last = b[b.length - 1];
    const ahead = Math.min((want - last.at) / 1000, 0.25);
    if (ahead <= 0 || !last.vel) return { pos: last.pos, rot: last.rot, t: 1 };
    return {
      pos: [last.pos[0] + last.vel[0] * ahead, last.pos[1] + last.vel[1] * ahead, last.pos[2] + last.vel[2] * ahead],
      rot: last.rot,
      t: 1,
    };
  }
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Quaternion slerp, with the short-way flip. Without the flip a peer rolling through the far
// side of a rotation spins the long way round, which reads as a ship suddenly cartwheeling.
function slerpQ(a, b, t) {
  let [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  let d = ax * bx + ay * by + az * bz + aw * bw;
  if (d < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; d = -d; }
  if (d > 0.9995) {
    const o = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
    const n = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return [o[0] / n, o[1] / n, o[2] / n, o[3] / n];
  }
  const th = Math.acos(clamp(d, -1, 1));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

export const net = new Net();
