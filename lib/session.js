'use strict';
const db = require('./db');
const { readSession, parseCookies, COOKIE, fail } = require('./http');

// Returns the logged-in user row, or null. Re-checks the database on every request,
// so suspended/deleted accounts and changed passwords stop working immediately.
async function currentUser(req) {
  const tok = parseCookies(req)[COOKIE];
  const s = readSession(tok);
  if (!s) return null;
  const r = await db.query('select * from users where id = $1', [s.u]);
  const u = r.rows[0];
  if (!u || u.status !== 'Active' || Number(u.token_version) !== Number(s.v)) return null;
  return u;
}
async function requireUser(req) {
  const u = await currentUser(req);
  if (!u) fail(401, 'Please log in again.');
  return u;
}
const originOf = (req) => `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
module.exports = { currentUser, requireUser, originOf };
