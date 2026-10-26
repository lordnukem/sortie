#!/usr/bin/env node
// Writes the administrator credentials for the leader-board service.
//
//   node tools/set-admin-password.js '<password>' [path/to/admin.json]
//
// The password itself is never stored — only a scrypt hash of it, its salt, and a per-install
// secret used to sign session tokens. Rotating the password rotates the secret too, so every
// token issued under the old one stops working immediately.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pw = process.argv[2];
const out = process.argv[3] || path.join(__dirname, '..', 'server', 'admin.json');
if (!pw) {
  console.error('usage: node tools/set-admin-password.js <password> [out.json]');
  process.exit(1);
}
const salt = crypto.randomBytes(16);
// Case is folded to match the service: see passwordOk() in server.js for why.
const hash = crypto.scryptSync(String(pw).trim().toLowerCase(), salt, 64, { N: 16384, r: 8, p: 1 });
fs.writeFileSync(out, JSON.stringify({
  salt: salt.toString('hex'),
  hash: hash.toString('hex'),
  secret: crypto.randomBytes(32).toString('hex'),
  set: new Date().toISOString(),
}, null, 1), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`wrote ${out} (mode 600)`);
