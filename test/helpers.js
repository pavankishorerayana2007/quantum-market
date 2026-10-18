'use strict';
// Test-only helpers: an in-memory SQLite database that runs the same SQL as production,
// plus a tiny fake request/response so the real API handlers can be called.
process.env.AUTH_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.UPI_ID = 'shop@testbank';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../lib/db');

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  const conv = (sql) => sql.replace(/\$(\d+)/g, '?$1');
  const run = (sql, p = []) => {
    const s = conv(sql);
    const st = raw.prepare(s);
    if (/^\s*(select|with)\b/i.test(s) || /\breturning\b/i.test(s)) {
      const rows = st.all(...p).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    const r = st.run(...p);
    return { rows: [], rowCount: Number(r.changes) };
  };
  let depth = Promise.resolve();
  db.useImpl({
    query: async (s, p) => run(s, p),
    tx: (fn) => {
      const job = depth.then(async () => {
        raw.exec('BEGIN');
        try { const out = await fn(async (s, p) => run(s, p)); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
      });
      depth = job.catch(() => {});
      return job;
    },
    close() {},
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean).forEach((s) => raw.exec(s));
  return raw;
}

const handlers = {
  auth: require('../api/auth'), act: require('../api/act'), state: require('../api/state'), img: require('../api/img'), health: require('../api/health'),
};

class Client {
  constructor() { this.cookie = ''; }
  async call(name, { method = 'POST', body, url = '/x', headers = {} } = {}) {
    const req = { method, url, headers: { host: 'shop.test', 'content-type': 'application/json', ...headers }, body };
    if (this.cookie) req.headers.cookie = this.cookie;
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
    await handlers[name](req, res);
    const sc = res.headers['set-cookie'];
    if (sc) { const v = sc.split(';')[0]; this.cookie = v.endsWith('=') ? '' : v; }
    let json = null;
    try { json = JSON.parse(res.body); } catch (_) { /* binary */ }
    return { status: res.statusCode, headers: res.headers, json, raw: res.body };
  }
  auth(body) { return this.call('auth', { body }); }
  act(a, d = {}) { return this.call('act', { body: { a, ...d } }); }
  state() { return this.call('state', { method: 'GET' }); }
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
module.exports = { freshDb, Client, PNG, db, core: require('../lib/core') };
