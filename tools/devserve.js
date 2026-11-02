#!/usr/bin/env node
// A local stand-in for the nginx vhost, so the game can be played against a real relay without
// touching the live one. It serves the repo as static files and proxies /api and /ws to an API
// server you started yourself:
//
//   DB_PATH=/tmp/t.db PORT=8796 GEO=0 node server/server.js &
//   node tools/devserve.js 8777 8796
//   # then open http://127.0.0.1:8777/ in two browsers
//
// It exists because the two halves of the game only meet behind a reverse proxy: index.html
// resolves its API to a bare /api on localhost, and net.js resolves the socket to a same-origin
// /ws, so without something joining them on one port neither can be exercised locally.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const PORT = Number(process.argv[2] || 8777);
const API = Number(process.argv[3] || 8796);
const ROOT = path.resolve(__dirname, '..');

// In production every pilot arrives from their own address and nginx forwards it, so the
// relay's per-address connection cap counts one socket each. Locally every browser is
// 127.0.0.1, so four tabs would exhaust the cap and the fifth would be refused for a reason
// that does not exist in the real deployment. Give each client port its own synthetic address
// so local testing is faithful rather than accidentally stricter than production.
const fakeIp = (sock) => `10.77.${((sock.remotePort || 0) >> 8) & 255}.${(sock.remotePort || 0) & 255}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.obj': 'text/plain',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    // Pass the client's address along the way nginx does, since the API reads it from there.
    const headers = { ...req.headers, 'x-forwarded-for': fakeIp(req.socket), host: `127.0.0.1:${API}` };
    const up = http.request({ host: '127.0.0.1', port: API, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('api down'); });
    req.pipe(up);
    return;
  }
  // No directory traversal: resolve, then check the result is still inside the repo.
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',   // a dev server that caches is a dev server that lies
    });
    res.end(buf);
  });
});

// The upgrade is proxied as raw bytes: replay the request line and headers to the API, then
// splice the two sockets together and stay out of the way.
server.on('upgrade', (req, sock, head) => {
  const up = net.connect(API, '127.0.0.1', () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'x-forwarded-for') continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push(`x-forwarded-for: ${fakeIp(req.socket)}`, '', '');
    up.write(lines.join('\r\n'));
    if (head && head.length) up.write(head);
    sock.pipe(up);
    up.pipe(sock);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`dev server on http://127.0.0.1:${PORT}/  (api and ws -> 127.0.0.1:${API})`));
