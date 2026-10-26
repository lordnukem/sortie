// Sortie! global leader board.
//
// A deliberately small service: Node's own http and sqlite, no dependencies, bound to localhost
// and reached through nginx. It stores one row per posted score and answers the top twenty.
//
// Everything a client sends is hostile until proven otherwise. The only fields taken from the
// request body are the run's own numbers; the IP, the clock and the geolocation are decided here,
// because a client that can set its own country can set its own score.
'use strict';
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'scores.db');
const BOARD_MAX = 20;
const GEO_ENABLED = process.env.GEO !== '0';

const ORIGINS = new Set([
  'https://lordnukem.github.io',
  'https://sortie.questfor.ge',
  'http://sortie.questfor.ge',
  'http://72.62.196.152',
  'http://127.0.0.1:8777',
  'http://localhost:8777',
]);

// ---------------------------------------------------------------- storage
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    score INTEGER NOT NULL,
    wave INTEGER NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0,
    shots INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    rocks INTEGER NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    client_tz TEXT,
    client_time TEXT,
    ip TEXT,
    country TEXT, region TEXT, city TEXT,
    ua TEXT, os TEXT, browser TEXT, device TEXT,
    flags TEXT
  );
  CREATE INDEX IF NOT EXISTS scores_rank ON scores (score DESC, id ASC);
  CREATE TABLE IF NOT EXISTS geo_cache (ip TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT, at INTEGER);
`);
const insert = db.prepare(`INSERT INTO scores
  (name, score, wave, kills, shots, hits, rocks, seconds, created_at, client_tz, client_time,
   ip, country, region, city, ua, os, browser, device, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const topQ = db.prepare(`SELECT name, score, wave, created_at, country FROM scores
  ORDER BY score DESC, id ASC LIMIT ?`);
const rankQ = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?');
const geoGet = db.prepare('SELECT country, region, city, at FROM geo_cache WHERE ip = ?');
const geoPut = db.prepare('INSERT OR REPLACE INTO geo_cache (ip, country, region, city, at) VALUES (?,?,?,?,?)');

// ---------------------------------------------------------------- what a client may claim
const NAME_OK = /^[A-Z0-9.\-]{3}$/;
const int = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};

// Plausibility, not proof. Anyone who reads the minified client can post numbers that satisfy
// all of this; the point is to cost them an afternoon rather than a curl command, and to keep
// the obviously impossible out of the table.
const WAVE_MAX = 400;
function judge(r) {
  const bad = [], soft = [];
  if (!NAME_OK.test(r.name)) bad.push('name');
  if (r.score <= 0 || r.score > 50e6) bad.push('score-range');
  if (r.wave < 1 || r.wave > WAVE_MAX) bad.push('wave-range');
  if (r.hits > r.shots) bad.push('hits>shots');
  if (r.kills > r.shots) bad.push('kills>shots');
  // A wave cannot be cleared instantly: the spawn queue alone takes this long to deliver.
  if (r.seconds > 0 && r.seconds < r.wave * 8) bad.push('too-fast');
  // The richest plausible wave: an ace plus a capital escort plus a generous pile of everything.
  const ceiling = 2000 + r.wave * 14000 + r.kills * 1200 + r.rocks * 150;
  if (r.score > ceiling) bad.push('score>ceiling');
  if (r.shots === 0 && r.kills > 0) soft.push('no-shots');
  if (r.seconds === 0) soft.push('no-clock');
  return { bad, soft };
}

// ---------------------------------------------------------------- client description
// Coarse on purpose: the family of the thing, not a fingerprint.
function describe(ua = '') {
  const s = String(ua).slice(0, 400);
  const os = /Windows NT 10/.test(s) ? 'Windows'
    : /Windows/.test(s) ? 'Windows'
    : /Android/.test(s) ? 'Android'
    : /(iPhone|iPad|iPod)/.test(s) ? 'iOS'
    : /Mac OS X/.test(s) ? 'macOS'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux' : 'unknown';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\//.test(s) ? 'Opera'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari' : 'unknown';
  const device = /(iPad|Tablet)/.test(s) ? 'tablet'
    : /(Mobi|iPhone|Android)/.test(s) ? 'phone' : 'desktop';
  return { os, browser, device, ua: s };
}

// ---------------------------------------------------------------- geolocation
// Resolved from the IP here rather than asked of the browser: the browser prompt is a permission
// dialog nobody wants mid-game, and a client-supplied country is just another field to forge.
// The lookup is a third-party call, so it is cached hard and failure is not an error.
const GEO_TTL = 30 * 24 * 3600 * 1000;
async function geolocate(ip) {
  if (!GEO_ENABLED || !ip || isPrivate(ip)) return {};
  const hit = geoGet.get(ip);
  if (hit && Date.now() - hit.at < GEO_TTL) return { country: hit.country, region: hit.region, city: hit.city };
  try {
    const ctl = AbortSignal.timeout(2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`, { signal: ctl });
    const j = await res.json();
    if (j.status !== 'success') return {};
    const out = { country: j.country || null, region: j.regionName || null, city: j.city || null };
    geoPut.run(ip, out.country, out.region, out.city, Date.now());
    return out;
  } catch { return {}; }
}
const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip);

// ---------------------------------------------------------------- rate limiting
const buckets = new Map();
function allow(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (b.n >= limit) return false;
  b.n++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------- http
function clientIp(req) {
  // nginx is the only thing in front, and it sets this. Take the first hop and nothing else:
  // the rest of the chain is whatever the client felt like claiming.
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0];
  return (first || req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '');
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
const send = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
};

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, rows: db.prepare('SELECT COUNT(*) AS n FROM scores').get().n });

  if (url.pathname === '/api/scores' && req.method === 'GET') {
    if (!allow('r:' + ip, 120, 60_000)) return send(res, 429, { error: 'slow down' });
    const limit = Math.min(BOARD_MAX, Math.max(1, int(url.searchParams.get('limit') || BOARD_MAX, 1, BOARD_MAX)));
    return send(res, 200, { board: topQ.all(limit) });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    if (!allow('w:' + ip, 20, 3600_000)) return send(res, 429, { error: 'too many runs' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    const r = {
      name: String(body.name || '').toUpperCase().slice(0, 3),
      score: int(body.score, 0, 50e6),
      wave: int(body.wave, 0, WAVE_MAX),
      kills: int(body.kills, 0, 1e6),
      shots: int(body.shots, 0, 1e7),
      hits: int(body.hits, 0, 1e7),
      rocks: int(body.rocks, 0, 1e6),
      seconds: Math.min(86400, Math.max(0, Number(body.seconds) || 0)),
    };
    const { bad, soft } = judge(r);
    if (bad.length) return send(res, 422, { error: 'implausible', why: bad });
    const d = describe(req.headers['user-agent']);
    const geo = await geolocate(ip);
    insert.run(
      r.name, r.score, r.wave, r.kills, r.shots, r.hits, r.rocks, r.seconds,
      new Date().toISOString(),
      String(body.tz || '').slice(0, 64) || null,
      String(body.localTime || '').slice(0, 40) || null,
      ip || null, geo.country || null, geo.region || null, geo.city || null,
      d.ua, d.os, d.browser, d.device,
      soft.length ? soft.join(',') : null,
    );
    return send(res, 201, { rank: rankQ.get(r.score).n + 1, board: topQ.all(BOARD_MAX) });
  }

  send(res, 404, { error: 'no such endpoint' });
});
server.listen(PORT, HOST, () => console.log(`sortie-api on http://${HOST}:${PORT} db=${DB_PATH}`));
