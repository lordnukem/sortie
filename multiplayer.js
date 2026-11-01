// server/multiplayer.js - Zero-dependency RFC 6455 WebSocket Server & Sector State Engine
// Part of SORTIE! Multiplayer Support
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TICK_RATE_HZ = 20;
const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;
const PLAYER_TIMEOUT_MS = 10000;

class WebSocketClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => this._onClose());
    this.socket.on('error', (err) => {
      this.emit('error', err);
      this._onClose();
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const byte0 = this.buffer[0];
      const byte1 = this.buffer[1];

      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (this.buffer.length < totalLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      let payload = this.buffer.subarray(offset, offset + payloadLen);
      if (masked && maskKey) {
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(totalLen);

      if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload);
      } else if (opcode === 0xa) {
        this.emit('pong', payload);
      } else if (opcode === 0x1) {
        try {
          const str = payload.toString('utf8');
          const json = JSON.parse(str);
          this.emit('message', json);
        } catch (e) {
          this.emit('error', new Error('Invalid JSON frame'));
        }
      }
    }
  }

  send(data) {
    if (this.closed || !this.socket.writable) return;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const payload = Buffer.from(str, 'utf8');
    this._sendFrame(0x1, payload);
  }

  _sendFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return;
    const len = payload.length;
    let header;

    if (len <= 125) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this._onClose();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const closeFrame = Buffer.from([0x88, 0x00]);
      this.socket.write(closeFrame, () => this.socket.end());
    } catch (e) {
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

class Sector {
  constructor(name = 'varan-prime') {
    this.name = name;
    this.players = new Map();
    this.intervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  addPlayer(client, joinData) {
    const id = 'pilot_' + crypto.randomBytes(4).toString('hex');
    const player = {
      id,
      callsign: (joinData.callsign || 'Viper-' + id.slice(-3)).slice(0, 16),
      ship: joinData.ship || 'interceptor',
      pos: [0, 0, 0],
      rot: [0, 0, 0, 1],
      vel: [0, 0, 0],
      throttle: 0,
      firing: false,
      hull: 100,
      shield: 100,
      score: 0,
      lastSeen: Date.now()
    };

    const existing = [];
    for (const [, p] of this.players) {
      existing.push({
        id: p.player.id,
        callsign: p.player.callsign,
        ship: p.player.ship,
        pos: p.player.pos,
        rot: p.player.rot,
        hull: p.player.hull,
        shield: p.player.shield
      });
    }

    client.send({
      type: 'welcome',
      id,
      sector: this.name,
      tickRate: TICK_RATE_HZ,
      players: existing
    });

    this.broadcast({
      type: 'player_joined',
      player: {
        id: player.id,
        callsign: player.callsign,
        ship: player.ship,
        pos: player.pos,
        rot: player.rot
      }
    }, id);

    this.players.set(id, { client, player });

    client.on('message', (msg) => this.handleMessage(id, msg));
    client.on('close', () => this.removePlayer(id));
  }

  handleMessage(id, msg) {
    const entry = this.players.get(id);
    if (!entry) return;
    const p = entry.player;
    p.lastSeen = Date.now();

    if (msg.type === 'state') {
      if (Array.isArray(msg.pos) && msg.pos.length === 3) p.pos = msg.pos;
      if (Array.isArray(msg.rot) && msg.rot.length === 4) p.rot = msg.rot;
      if (Array.isArray(msg.vel) && msg.vel.length === 3) p.vel = msg.vel;
      p.throttle = Number(msg.throttle || 0);
      p.firing = Boolean(msg.firing);
    } else if (msg.type === 'fire') {
      this.broadcast({
        type: 'proj',
        shooterId: id,
        weapon: msg.weapon || 'pulse',
        pos: msg.pos,
        dir: msg.dir
      }, id);
    } else if (msg.type === 'hit') {
      const targetId = msg.targetId;
      const targetEntry = this.players.get(targetId);
      if (targetEntry) {
        const dmg = Math.min(Math.max(Number(msg.damage || 10), 1), 50);
        if (targetEntry.player.shield > dmg) {
          targetEntry.player.shield -= dmg;
        } else {
          const rem = dmg - targetEntry.player.shield;
          targetEntry.player.shield = 0;
          targetEntry.player.hull = Math.max(0, targetEntry.player.hull - rem);
        }

        this.broadcast({
          type: 'damage',
          targetId,
          attackerId: id,
          shield: targetEntry.player.shield,
          hull: targetEntry.player.hull
        });

        if (targetEntry.player.hull <= 0) {
          p.score += 100;
          this.broadcast({
            type: 'kill',
            killerId: id,
            killerCallsign: p.callsign,
            victimId: targetId,
            victimCallsign: targetEntry.player.callsign
          });
        }
      }
    } else if (msg.type === 'ping') {
      entry.client.send({ type: 'pong', t: msg.t });
    }
  }

  removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    this.players.delete(id);
    this.broadcast({
      type: 'player_left',
      id,
      callsign: entry.player.callsign
    });
  }

  broadcast(msg, excludeId = null) {
    const payload = JSON.stringify(msg);
    for (const [id, entry] of this.players) {
      if (id !== excludeId) {
        entry.client.send(payload);
      }
    }
  }

  tick() {
    const now = Date.now();
    const snapshot = {};
    let count = 0;

    for (const [id, entry] of this.players) {
      if (now - entry.player.lastSeen > PLAYER_TIMEOUT_MS) {
        entry.client.close();
        this.removePlayer(id);
        continue;
      }

      snapshot[id] = {
        pos: entry.player.pos,
        rot: entry.player.rot,
        vel: entry.player.vel,
        thr: entry.player.throttle,
        fire: entry.player.firing,
        hull: entry.player.hull,
        shd: entry.player.shield,
        sc: entry.player.score
      };
      count++;
    }

    if (count > 0) {
      this.broadcast({
        type: 'tick',
        t: now,
        s: snapshot
      });
    }
  }

  destroy() {
    clearInterval(this.intervalId);
    for (const [, entry] of this.players) {
      entry.client.close();
    }
    this.players.clear();
  }
}

function handleUpgrade(req, socket, head, defaultSector) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws' && url.pathname !== '/multiplayer') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(responseHeaders.join('\r\n'));

  const client = new WebSocketClient(socket);
  client.on('message', function onFirstJoin(msg) {
    if (msg.type === 'join') {
      client.removeListener('message', onFirstJoin);
      defaultSector.addPlayer(client, msg);
    }
  });
}

function initMultiplayer(server) {
  const sector = new Sector('varan-prime');
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, sector);
  });
  return sector;
}

module.exports = {
  WebSocketClient,
  Sector,
  handleUpgrade,
  initMultiplayer
};
