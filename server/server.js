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
const { initMultiplayer } = require('./multiplayer.js');

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
    level TEXT,
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

// ---------------------------------------------------------------- sessions
// The denominator the score table never had. A row in `scores` exists only for a run someone
// chose to submit, which tells us what the people who finished and cared did -- and nothing
// about how many opened the game, on what, or where they stopped. Platform and difficulty
// questions were being argued from three submitted rows, all from one machine, so this records
// the visit itself: one row per page load, updated as the run progresses.
//
// `vid` is kept by the client across visits and `sid` is new on every load, so "how many
// people" and "how many sessions" are different questions with different answers. Monotonic
// fields are merged with max() on update, because pings can arrive late or out of order and a
// stale one must not walk a run backwards.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    vid TEXT,
    created_at TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    started INTEGER NOT NULL DEFAULT 0,
    runs INTEGER NOT NULL DEFAULT 0,
    wave_max INTEGER NOT NULL DEFAULT 0,
    waves_cleared INTEGER NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0,
    shots INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    level TEXT,
    ended TEXT,
    submitted INTEGER NOT NULL DEFAULT 0,
    installed INTEGER NOT NULL DEFAULT 0,
    touch INTEGER NOT NULL DEFAULT 0,
    vw INTEGER, vh INTEGER,
    ip TEXT, country TEXT, region TEXT, city TEXT, cc TEXT,
    ua TEXT, os TEXT, browser TEXT, device TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_seen ON sessions (seen_at DESC);
  CREATE INDEX IF NOT EXISTS sessions_vid ON sessions (vid);
`);

// ---------------------------------------------------------------- debug telemetry
// Off unless the service starts with SORTIE_TELEMETRY=dev. When it is off nothing is written to
// these two tables, and every ping is answered with x-sortie-telemetry: live, which tells the game
// not to send its debug fields at all. The on/off switch is therefore this one environment variable.
const TELEMETRY_DEV = process.env.SORTIE_TELEMETRY === 'dev';
const DEV_EVENTS_MAX = 200; // per visit, so one stuck client cannot fill the table
db.exec(`
  CREATE TABLE IF NOT EXISTS dev_sessions (
    sid TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    mode TEXT, flight TEXT, role TEXT,
    pilots INTEGER, lives INTEGER, wingmen INTEGER,
    fps INTEGER, jank INTEGER, dpr REAL
  );
  CREATE TABLE IF NOT EXISTS dev_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sid TEXT NOT NULL,
    at TEXT NOT NULL,
    t INTEGER,
    code TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS dev_events_sid ON dev_events (sid, id);
  CREATE INDEX IF NOT EXISTS dev_sessions_flight ON dev_sessions (flight);
`);
const devSessionPut = db.prepare(`INSERT INTO dev_sessions
  (sid, updated_at, mode, flight, role, pilots, lives, wingmen, fps, jank, dpr)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(sid) DO UPDATE SET
    updated_at = excluded.updated_at, mode = excluded.mode, flight = excluded.flight,
    role = excluded.role, pilots = excluded.pilots, lives = excluded.lives,
    wingmen = excluded.wingmen, fps = excluded.fps, jank = excluded.jank, dpr = excluded.dpr`);
const devEventCount = db.prepare('SELECT COUNT(*) AS n FROM dev_events WHERE sid = ?');
const devEventPut = db.prepare('INSERT INTO dev_events (sid, at, t, code, detail) VALUES (?,?,?,?,?)');
function storeDebug(sid, now, body) {
  devSessionPut.run(
    sid, now,
    ['solo', 'coop'].includes(body.mode) ? body.mode : null,
    typeof body.flight === 'string' && body.flight.length <= 80 ? body.flight : null,
    ['host', 'guest'].includes(body.role) ? body.role : null,
    int(body.pilots, 1, 8), int(body.lives, 0, 99), int(body.wingmen, 0, 10),
    int(body.fps, 0, 1000), int(body.jank, 0, 1e6),
    Number.isFinite(Number(body.dpr)) ? Math.min(8, Number(body.dpr)) : null,
  );
  const events = Array.isArray(body.events) ? body.events.slice(0, 60) : [];
  let room = DEV_EVENTS_MAX - devEventCount.get(sid).n;
  for (const e of events) {
    if (room <= 0) break;
    if (!e || typeof e.c !== 'string' || !/^[a-z_]{1,24}$/.test(e.c)) continue;
    devEventPut.run(sid, now, int(e.t, 0, 86400) ?? 0, e.c, String(e.d ?? '').slice(0, 120));
    room--;
  }
}
// Columns added after the first rows were already stored. SQLite has no "add column if missing",
// so the attempt is made and the duplicate-column error is the expected outcome on every boot
// after the first.
for (const [col, type] of [['lat', 'REAL'], ['lon', 'REAL'], ['cc', 'TEXT'], ['level', 'TEXT']]) {
  for (const table of ['scores', 'geo_cache']) {
    if (col === 'level' && table !== 'scores') continue;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* already there */ }
  }
}
// How far the boss fight got. Added after sessions already had rows, so the same tolerance applies.
for (const [col, type] of [['pods', 'INTEGER NOT NULL DEFAULT 0'], ['core_hits', 'INTEGER NOT NULL DEFAULT 0'],
  ['boss', 'TEXT'], ['boss_kills', 'INTEGER NOT NULL DEFAULT 0']]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`); } catch { /* already there */ }
}
const insert = db.prepare(`INSERT INTO scores
  (name, score, wave, level, kills, shots, hits, rocks, seconds, created_at, client_tz, client_time,
   ip, country, region, city, lat, lon, cc, ua, os, browser, device, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const topQ = db.prepare(`SELECT name, score, wave, level, created_at, country FROM scores
  ORDER BY score DESC, id ASC LIMIT ?`);
const rankQ = db.prepare('SELECT COUNT(*) AS n FROM scores WHERE score > ?');
// ---------------------------------------------------------------- co-op board
// A separate table, not a column on `scores`. A co-op kill is cheaper than a solo one -- four
// guns on the same wave -- so the two are not comparable, and the whole point of the difficulty
// multiplier was to keep one board that means something. Mixing them would quietly undo that.
//
// One row per sortie, posted by the host, carrying the team total and who flew it. `flight` is
// unique so a retry, or a second client posting the same sortie, updates nothing and returns
// the rank the first post got.
db.exec(`
  CREATE TABLE IF NOT EXISTS coop_scores (
    id INTEGER PRIMARY KEY,
    flight TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    roster TEXT,
    pilots INTEGER NOT NULL,
    score INTEGER NOT NULL,
    wave INTEGER NOT NULL,
    level TEXT,
    kills INTEGER NOT NULL DEFAULT 0,
    shots INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    rocks INTEGER NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    ip TEXT,
    country TEXT, region TEXT, city TEXT, lat REAL, lon REAL, cc TEXT,
    ua TEXT, os TEXT, browser TEXT, device TEXT,
    flags TEXT
  );
`);
const coopInsert = db.prepare(`INSERT INTO coop_scores
  (flight, name, roster, pilots, score, wave, level, kills, shots, hits, rocks, seconds,
   created_at, ip, country, region, city, lat, lon, cc, ua, os, browser, device, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const coopTopQ = db.prepare(`SELECT name, roster, pilots, score, wave, level, created_at, country
  FROM coop_scores ORDER BY score DESC, id ASC LIMIT ?`);
const coopRankQ = db.prepare('SELECT COUNT(*) AS n FROM coop_scores WHERE score > ?');
const coopHasQ = db.prepare('SELECT score FROM coop_scores WHERE flight = ?');

const geoGet = db.prepare('SELECT country, region, city, lat, lon, cc, at FROM geo_cache WHERE ip = ?');
const geoPut = db.prepare('INSERT OR REPLACE INTO geo_cache (ip, country, region, city, lat, lon, cc, at) VALUES (?,?,?,?,?,?,?,?)');

// One statement for both the first ping of a visit and every one after it. The insert carries
// the things decided once (identity, platform, where from); the update carries only progress,
// and takes the larger of the two for anything that can only go up.
const pingPut = db.prepare(`INSERT INTO sessions
  (sid, vid, created_at, seen_at, started, runs, wave_max, waves_cleared, seconds, shots, hits,
   kills, deaths, level, ended, submitted, installed, touch, vw, vh,
   ip, country, region, city, cc, ua, os, browser, device, pods, core_hits, boss, boss_kills)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(sid) DO UPDATE SET
    seen_at       = excluded.seen_at,
    started       = MAX(sessions.started, excluded.started),
    runs          = MAX(sessions.runs, excluded.runs),
    wave_max      = MAX(sessions.wave_max, excluded.wave_max),
    waves_cleared = MAX(sessions.waves_cleared, excluded.waves_cleared),
    seconds       = MAX(sessions.seconds, excluded.seconds),
    shots         = MAX(sessions.shots, excluded.shots),
    hits          = MAX(sessions.hits, excluded.hits),
    kills         = MAX(sessions.kills, excluded.kills),
    deaths        = MAX(sessions.deaths, excluded.deaths),
    level         = COALESCE(excluded.level, sessions.level),
    ended         = COALESCE(excluded.ended, sessions.ended),
    submitted     = MAX(sessions.submitted, excluded.submitted),
    installed     = MAX(sessions.installed, excluded.installed),
    vw            = COALESCE(excluded.vw, sessions.vw),
    vh            = COALESCE(excluded.vh, sessions.vh),
    pods          = MAX(sessions.pods, excluded.pods),
    core_hits     = MAX(sessions.core_hits, excluded.core_hits),
    boss          = COALESCE(excluded.boss, sessions.boss),
    boss_kills    = MAX(sessions.boss_kills, excluded.boss_kills)`);

// ---------------------------------------------------------------- what a client may claim
const NAME_OK = /^[A-Z0-9.\-]{3}$/;
const int = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};

// Plausibility, not proof. Anyone who reads the minified client can post numbers that satisfy
// all of this; the point is to cost them an afternoon rather than a curl command, and to keep
// the obviously impossible out of the table.
const LEVEL_SCORE = { recruit: 0.6, normal: 1, veteran: 1.6, ace: 2.4 };
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
  const ceiling = (2000 + r.wave * 14000 + r.kills * 1200 + r.rocks * 150) * (LEVEL_SCORE[r.level] || 1);
  if (r.score > ceiling) bad.push('score>ceiling');
  if (r.shots === 0 && r.kills > 0) soft.push('no-shots');
  if (r.seconds === 0) soft.push('no-clock');
  return { bad, soft };
}

// The same shape of plausibility test as judge(), with the one difference that matters: four
// pilots clear a wave faster and kill more, so both the score ceiling and the floor on how long
// a wave can take scale with the flight. Without that, a legitimate four-pilot run reads as
// impossible and a solo one posted as co-op reads as fine.
function judgeCoop(r) {
  const bad = [], soft = [];
  if (!NAME_OK.test(r.name)) bad.push('name');
  if (r.pilots < 2 || r.pilots > 4) bad.push('pilots-range');
  if (r.score <= 0 || r.score > 200e6) bad.push('score-range');
  if (r.wave < 1 || r.wave > WAVE_MAX) bad.push('wave-range');
  if (r.hits > r.shots) bad.push('hits>shots');
  if (r.kills > r.shots) bad.push('kills>shots');
  // Each extra gun shortens a wave, but not without limit: half the solo floor is the fastest
  // a wave can plausibly go however many people are shooting, because the spawn queue still
  // has to deliver the ships.
  const floor = r.wave * 8 * Math.max(0.5, 1 - (r.pilots - 1) * 0.15);
  if (r.seconds > 0 && r.seconds < floor) bad.push('too-fast');
  const ceiling = (2000 + r.wave * 14000 + r.kills * 1200 + r.rocks * 150)
    * (LEVEL_SCORE[r.level] || 1) * r.pilots;
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
    levels: statCounts('level'),
    // A run per day, for the activity strip.
    daily: db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
      FROM scores GROUP BY day ORDER BY day DESC LIMIT 60`).all(),
    board: db.prepare(`SELECT name, score, wave, level, seconds, created_at, country, cc
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
const ADMIN_COLS = ['id', 'created_at', 'name', 'score', 'wave', 'level', 'kills', 'shots', 'hits', 'rocks',
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

// Every route runs under this guard. An async handler with no catch turns any throw into an
// unhandled rejection, and Node 22 exits on one of those -- so a single malformed write took the
// whole API down. A failed request now gets a 500 and a log line, and the process keeps serving.
const handleRequest = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, rows: db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, pilots: relay.pilots, sectors: relay.sectors.size, telemetry: TELEMETRY_DEV ? 'dev' : 'live' });

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
      level: ['recruit', 'normal', 'veteran', 'ace'].includes(body.level) ? body.level : 'normal',
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
      r.name, r.score, r.wave, r.level, r.kills, r.shots, r.hits, r.rocks, r.seconds,
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

  // ---- co-op ------------------------------------------------------------
  if (url.pathname === '/api/lobbies' && req.method === 'GET') {
    if (!allow('l:' + ip, 120, 60_000)) return send(res, 429, { error: 'slow down' });
    return send(res, 200, { lobbies: relay.lobbies() });
  }

  if (url.pathname === '/api/coop' && req.method === 'GET') {
    if (!allow('r:' + ip, 120, 60_000)) return send(res, 429, { error: 'slow down' });
    const limit = Math.min(BOARD_KEEP, Math.max(1, int(url.searchParams.get('limit') || BOARD_PAGE, 1, BOARD_KEEP)));
    return send(res, 200, { board: coopTopQ.all(limit) });
  }

  if (url.pathname === '/api/coop' && req.method === 'POST') {
    if (!allow('w:' + ip, 20, 3600_000)) return send(res, 429, { error: 'too many runs' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
    // The sortie's own id. Without it a retry after a dropped response would post the run twice,
    // and a four-pilot flight would have four chances to do it.
    const flight = String(body.flight || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
    if (flight.length < 8) return send(res, 400, { error: 'bad flight id' });
    const already = coopHasQ.get(flight);
    if (already) return send(res, 200, { rank: coopRankQ.get(already.score).n + 1, board: coopTopQ.all(BOARD_KEEP), duplicate: true });
    const r = {
      name: String(body.name || '').toUpperCase().slice(0, 3),
      roster: String(body.roster || '').replace(/[^A-Za-z0-9 ,_-]/g, '').slice(0, 80),
      pilots: int(body.pilots, 0, 4),
      score: int(body.score, 0, 200e6),
      wave: int(body.wave, 0, WAVE_MAX),
      level: ['recruit', 'normal', 'veteran', 'ace'].includes(body.level) ? body.level : 'normal',
      kills: int(body.kills, 0, 4e6),
      shots: int(body.shots, 0, 4e7),
      hits: int(body.hits, 0, 4e7),
      rocks: int(body.rocks, 0, 4e6),
      seconds: Math.min(86400, Math.max(0, Number(body.seconds) || 0)),
    };
    const { bad, soft } = judgeCoop(r);
    if (bad.length) return send(res, 422, { error: 'implausible', why: bad });
    const d = describe(req.headers['user-agent']);
    const geo = await geolocate(ip);
    coopInsert.run(
      flight, r.name, r.roster || null, r.pilots, r.score, r.wave, r.level,
      r.kills, r.shots, r.hits, r.rocks, r.seconds, new Date().toISOString(),
      ip || null, geo.country || null, geo.region || null, geo.city || null,
      geo.lat ?? null, geo.lon ?? null, geo.cc || null,
      d.ua, d.os, d.browser, d.device,
      soft.length ? soft.join(',') : null,
    );
    return send(res, 201, { rank: coopRankQ.get(r.score).n + 1, board: coopTopQ.all(BOARD_KEEP) });
  }

  if (url.pathname === '/api/stats' && req.method === 'GET') {
    if (!allow('s:' + ip, 60, 60_000)) return send(res, 429, { error: 'slow down' });
    return send(res, 200, publicStats());
  }

  // A visit, and how far it got. Unlike a score this is not a claim worth faking -- there is no
  // ranking to climb -- so it is validated for shape and range and otherwise taken at face
  // value. It answers with 204 and no body: the client must never wait on, or care about, this.
  if (url.pathname === '/api/ping' && req.method === 'POST') {
    if (!allow('p:' + ip, 240, 3600_000)) { res.writeHead(429); res.end(); return; }
    let body;
    // 16 KB: a dev ping can carry a batch of events. Live pings are a few hundred bytes.
    try { body = JSON.parse(await readBody(req, 16384)); } catch { res.writeHead(400); res.end(); return; }
    const ID = /^[a-z0-9]{10,32}$/;
    const sid = String(body.sid || '');
    const vid = String(body.vid || '');
    if (!ID.test(sid)) { res.writeHead(400); res.end(); return; }
    const first = body.phase === 'load';
    // Geolocation is looked up once per visit. `geolocate` caches by IP, so this is usually a
    // map hit, but on a cold IP it is an outbound request and there is no reason to make one on
    // every wave ping.
    const geo = first ? await geolocate(ip) : {};
    const d = describe(req.headers['user-agent']);
    const now = new Date().toISOString();
    pingPut.run(
      sid, ID.test(vid) ? vid : null, now, now,
      body.phase === 'load' ? 0 : 1,
      int(body.runs, 0, 1000),
      int(body.wave, 0, WAVE_MAX),
      int(body.cleared, 0, WAVE_MAX),
      Math.min(86400, Math.max(0, Number(body.seconds) || 0)),
      int(body.shots, 0, 1e7), int(body.hits, 0, 1e7),
      int(body.kills, 0, 1e6), int(body.deaths, 0, 1000),
      ['recruit', 'normal', 'veteran', 'ace'].includes(body.level) ? body.level : null,
      ['dead', 'quit', 'saved'].includes(body.ended) ? body.ended : null,
      body.submitted ? 1 : 0, body.installed ? 1 : 0, body.touch ? 1 : 0,
      int(body.vw, 0, 20000) || null, int(body.vh, 0, 20000) || null,
      ip || null, geo.country || null, geo.region || null, geo.city || null, geo.cc || null,
      d.ua, d.os, d.browser, d.device,
      int(body.pods, 0, 100), int(body.core, 0, 1e6),
      ['hive', 'holdout', 'ace'].includes(body.boss) ? body.boss : null,
      int(body.bosses, 0, 100),
    );
    if (TELEMETRY_DEV && body.mode) storeDebug(sid, now, body);
    res.writeHead(204, { 'x-sortie-telemetry': TELEMETRY_DEV ? 'dev' : 'live' });
    res.end();
    return;
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
    // The funnel, which is the whole reason the sessions table exists: of everyone who opened
    // the game, how many pressed Launch, how far they got, and on what. Grouped server-side
    // because the interesting cuts are aggregates and the row dump is already available below.
    if (url.pathname === '/api/admin/funnel') {
      const one = (sql) => db.prepare(sql).get();
      const all = (sql) => db.prepare(sql).all();
      return send(res, 200, {
        totals: one(`SELECT
          COUNT(*) AS visits,
          COUNT(DISTINCT vid) AS visitors,
          SUM(started) AS started,
          SUM(submitted) AS submitted,
          SUM(installed) AS installed,
          SUM(CASE WHEN wave_max >= 5 THEN 1 ELSE 0 END) AS reached_boss,
          SUM(shots) AS shots, SUM(hits) AS hits, SUM(kills) AS kills,
          ROUND(AVG(CASE WHEN started = 1 THEN seconds END), 1) AS avg_seconds,
          ROUND(AVG(CASE WHEN started = 1 THEN wave_max END), 2) AS avg_wave
          FROM sessions`),
        byDevice: all(`SELECT device, COUNT(*) AS visits, SUM(started) AS started,
          ROUND(AVG(CASE WHEN started = 1 THEN wave_max END), 2) AS avg_wave,
          ROUND(AVG(CASE WHEN started = 1 THEN seconds END), 1) AS avg_seconds
          FROM sessions GROUP BY device ORDER BY visits DESC`),
        byOs: all(`SELECT os, COUNT(*) AS visits, SUM(started) AS started
          FROM sessions GROUP BY os ORDER BY visits DESC`),
        byBrowser: all(`SELECT browser, COUNT(*) AS visits, SUM(started) AS started
          FROM sessions GROUP BY browser ORDER BY visits DESC`),
        byCountry: all(`SELECT country, cc, COUNT(*) AS visits, SUM(started) AS started
          FROM sessions WHERE country IS NOT NULL GROUP BY country, cc ORDER BY visits DESC`),
        // Where runs stop. The reason the design cares: every boss sits at wave 5 and up.
        byWave: all(`SELECT wave_max AS wave, COUNT(*) AS runs FROM sessions
          WHERE started = 1 GROUP BY wave_max ORDER BY wave_max`),
        byEnding: all(`SELECT COALESCE(ended, 'abandoned') AS ending, COUNT(*) AS runs
          FROM sessions WHERE started = 1 GROUP BY ending ORDER BY runs DESC`),
        byLevel: all(`SELECT COALESCE(level, 'unset') AS level, COUNT(*) AS runs,
          ROUND(AVG(wave_max), 2) AS avg_wave FROM sessions WHERE started = 1
          GROUP BY level ORDER BY runs DESC`),
        recent: all(`SELECT sid, vid, created_at, seen_at, started, wave_max, waves_cleared,
          seconds, shots, hits, kills, deaths, level, ended, submitted, installed, touch, vw, vh,
          country, city, os, browser, device FROM sessions ORDER BY seen_at DESC LIMIT 300`),
      });
    }
    if (url.pathname === '/api/admin/sessions.csv') {
      const cols = ['sid', 'vid', 'created_at', 'seen_at', 'started', 'runs', 'wave_max',
        'waves_cleared', 'seconds', 'shots', 'hits', 'kills', 'deaths', 'level', 'ended',
        'submitted', 'installed', 'touch', 'vw', 'vh', 'ip', 'country', 'region', 'city', 'cc',
        'os', 'browser', 'device', 'ua', 'pods', 'core_hits', 'boss', 'boss_kills'];
      const data = db.prepare(`SELECT ${cols.join(', ')} FROM sessions ORDER BY seen_at DESC`).all();
      const cell = (v) => {
        if (v === null || v === undefined) return '';
        const t = String(v);
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sortie-sessions-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end([cols.join(','), ...data.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n'));
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
};
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`request ${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
// Co-op relay on /ws. It shares this file's origin allowlist rather than keeping its own: a
// WebSocket handshake is exempt from the same-origin policy, so that list is the only thing
// standing between the sector and any page on the internet.
const relay = initMultiplayer(server, { origins: ORIGINS });
server.listen(PORT, HOST, () => console.log(`sortie-api on http://${HOST}:${PORT} db=${DB_PATH}`));
