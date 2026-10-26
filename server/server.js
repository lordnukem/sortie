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
// How deep the global board goes. The table itself keeps every run for ever -- this is only
// how far down the ranking is public. Returning all hundred at once is about 10 KB, so the
// clients fetch the lot and decide for themselves how much to put on screen.
const BOARD_KEEP = 100;
const BOARD_PAGE = 20;   // the default slice when a caller does not ask for a depth
const GEO_ENABLED = process.env.GEO !== '0';

const ORIGINS = new Set([
  'https://lordnukem.github.io',
  'https://sortiethegame.com',
  'https://www.sortiethegame.com',
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
    country TEXT, region TEXT, city TEXT, lat REAL, lon REAL, cc TEXT,
    ua TEXT, os TEXT, browser TEXT, device TEXT,
    flags TEXT
  );
  CREATE INDEX IF NOT EXISTS scores_rank ON scores (score DESC, id ASC);
  CREATE TABLE IF NOT EXISTS geo_cache (ip TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT, lat REAL, lon REAL, cc TEXT, at INTEGER);
`);
// Columns added after the first rows were already stored. SQLite has no "add column if missing",
// so the attempt is made and the duplicate-column error is the expected outcome on every boot
// after the first.
for (const [col, type] of [['lat', 'REAL'], ['lon', 'REAL'], ['cc', 'TEXT']]) {
  for (const table of ['scores', 'geo_cache']) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already there */ }
  }
}
const insert = db.prepare(`INSERT INTO scores
  (name, score, wave, kills, shots, hits, rocks, seconds, created_at, client_tz, client_time,
   ip, country, region, city, lat, lon, cc, ua, os, browser, device, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const topQ = db.prepare(`SELECT name, score, wave, created_at, country FROM scores
  ORDER BY score DESC, id ASC LIMIT ?`);
const rankQ = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?');
const geoGet = db.prepare('SELECT country, region, city, lat, lon, cc, at FROM geo_cache WHERE ip = ?');
const geoPut = db.prepare('INSERT OR REPLACE INTO geo_cache (ip, country, region, city, lat, lon, cc, at) VALUES (?,?,?,?,?,?,?,?)');

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
  if (hit && Date.now() - hit.at < GEO_TTL) return { country: hit.country, region: hit.region, city: hit.city, lat: hit.lat, lon: hit.lon, cc: hit.cc };
  try {
    const ctl = AbortSignal.timeout(2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,lat,lon`, { signal: ctl });
    const j = await res.json();
    if (j.status !== 'success') return {};
    const out = {
      country: j.country || null, region: j.regionName || null, city: j.city || null,
      lat: Number.isFinite(j.lat) ? j.lat : null, lon: Number.isFinite(j.lon) ? j.lon : null,
      cc: j.countryCode || null,
    };
    geoPut.run(ip, out.country, out.region, out.city, out.lat, out.lon, out.cc, Date.now());
    return out;
  } catch { return {}; }
}
const isPrivate = (ip) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip);

// ---------------------------------------------------------------- public statistics
// Country, never city, and never an address. The game's About page promises players that only
// name, score, wave, date and country are ever shown to anyone, and this endpoint is the one
// that would quietly break that promise if it returned what it has.
const statCounts = (col) => db.prepare(
  `SELECT ${col} AS k, COUNT(*) AS n FROM scores WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY n DESC`).all();
function publicStats() {
  const totals = db.prepare(`SELECT
      COUNT(*) AS runs,
      COALESCE(SUM(seconds), 0) AS seconds,
      COALESCE(AVG(seconds), 0) AS avgSeconds,
      COALESCE(MAX(seconds), 0) AS longest,
      COALESCE(MAX(wave), 0) AS deepestWave,
      COALESCE(AVG(wave), 0) AS avgWave,
      COALESCE(SUM(kills), 0) AS kills,
      COALESCE(SUM(rocks), 0) AS rocks,
      COALESCE(SUM(shots), 0) AS shots,
      COALESCE(SUM(hits), 0) AS hits,
      MIN(created_at) AS firstRun, MAX(created_at) AS lastRun
    FROM scores`).get();
  return {
    totals,
    countries: db.prepare(`SELECT country AS k, cc, COUNT(*) AS n, MAX(score) AS best
      FROM scores WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC`).all(),
    os: statCounts('os'), browser: statCounts('browser'), device: statCounts('device'),
    // A run per day, for the activity strip.
    daily: db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
      FROM scores GROUP BY day ORDER BY day DESC LIMIT 60`).all(),
    board: db.prepare(`SELECT name, score, wave, seconds, created_at, country, cc
      FROM scores ORDER BY score DESC, id ASC LIMIT ?`).all(BOARD_KEEP),
  };
}

// ---------------------------------------------------------------- administration
// The page behind this shows addresses and cities, so the check is here and never in the page:
// a password compared in client JavaScript is a password published. The hash lives outside the
// repository in a file only this service can read.
const crypto = require('node:crypto');
const ADMIN_FILE = process.env.ADMIN_FILE || path.join(__dirname, 'admin.json');
let admin = null;
try { admin = JSON.parse(require('node:fs').readFileSync(ADMIN_FILE, 'utf8')); }
catch { console.warn('No admin credentials; the admin API is disabled. Run tools/set-admin-password.js.'); }

// Case is folded before hashing. The password is short enough that the case of one word is not
// what is protecting it, and getting locked out of your own dashboard over a capital is worse.
const normalise = (pw) => String(pw || '').trim().toLowerCase();
function passwordOk(pw) {
  if (!admin) return false;
  const want = Buffer.from(admin.hash, 'hex');
  const got = crypto.scryptSync(normalise(pw), Buffer.from(admin.salt, 'hex'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// A signed token rather than a session table: there is one administrator and no state worth
// keeping. The secret is per-install, so tokens do not survive a password change.
function issueToken(hours = 12) {
  const exp = Date.now() + hours * 3600_000;
  const sig = crypto.createHmac('sha256', admin.secret).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
function tokenOk(token) {
  if (!admin || typeof token !== 'string') return false;
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  const want = crypto.createHmac('sha256', admin.secret).update(String(exp)).digest('hex');
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const ADMIN_COLS = ['id', 'created_at', 'name', 'score', 'wave', 'kills', 'shots', 'hits', 'rocks',
  'seconds', 'ip', 'country', 'region', 'city', 'lat', 'lon', 'cc', 'os', 'browser', 'device',
  'client_tz', 'client_time', 'flags', 'ua'];
const adminRows = (limit, offset) => db.prepare(
  `SELECT ${ADMIN_COLS.join(', ')} FROM scores ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);
function toCsv(rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [ADMIN_COLS.join(','), ...rows.map((r) => ADMIN_COLS.map((c) => cell(r[c])).join(','))].join('\r\n');
}

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    const limit = Math.min(BOARD_KEEP, Math.max(1, int(url.searchParams.get('limit') || BOARD_PAGE, 1, BOARD_KEEP)));
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
      geo.lat ?? null, geo.lon ?? null, geo.cc || null,
      d.ua, d.os, d.browser, d.device,
      soft.length ? soft.join(',') : null,
    );
    return send(res, 201, { rank: rankQ.get(r.score).n + 1, board: topQ.all(BOARD_KEEP) });
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    if (!allow('s:' + ip, 60, 60_000)) return send(res, 429, { error: 'slow down' });
    return send(res, 200, publicStats());
  }

  // --- administration -------------------------------------------------------------------
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    // Deliberately mean: a six-digit tail on a first name is not much entropy, so the thing
    // guarding it is how few guesses an attacker gets, and how slowly each one is answered.
    if (!allow('a:' + ip, 8, 900_000)) return send(res, 429, { error: 'too many attempts, wait 15 minutes' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); } catch { return send(res, 400, { error: 'bad json' }); }
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));
    if (!admin) return send(res, 503, { error: 'no administrator is configured' });
    if (!passwordOk(body.password)) return send(res, 401, { error: 'wrong password' });
    return send(res, 200, { token: issueToken(), hours: 12 });
  }
  if (url.pathname.startsWith('/api/admin/')) {
    if (!tokenOk(bearer(req))) return send(res, 401, { error: 'sign in' });
    if (url.pathname === '/api/admin/rows') {
      const limit = int(url.searchParams.get('limit') || 200, 1, 5000) || 200;
      const offset = int(url.searchParams.get('offset') || 0, 0, 1e7);
      return send(res, 200, {
        total: db.prepare('SELECT COUNT(*) AS n FROM scores').get().n,
        columns: ADMIN_COLS,
        rows: adminRows(limit, offset),
        stats: publicStats(),
        // The detail the public endpoint deliberately withholds.
        cities: db.prepare(`SELECT country, region, city, lat, lon, COUNT(*) AS n
          FROM scores WHERE city IS NOT NULL GROUP BY country, region, city ORDER BY n DESC`).all(),
        flagged: db.prepare('SELECT COUNT(*) AS n FROM scores WHERE flags IS NOT NULL').get().n,
      });
    }
    if (url.pathname === '/api/admin/export.json') {
      const rows = adminRows(1e6, 0);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="sortie-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify({ exported: new Date().toISOString(), columns: ADMIN_COLS, rows }, null, 1));
    }
    if (url.pathname === '/api/admin/export.csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sortie-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end(toCsv(adminRows(1e6, 0)));
    }
    return send(res, 404, { error: 'no such endpoint' });
  }

  send(res, 404, { error: 'no such endpoint' });
});
server.listen(PORT, HOST, () => console.log(`sortie-api on http://${HOST}:${PORT} db=${DB_PATH}`));
