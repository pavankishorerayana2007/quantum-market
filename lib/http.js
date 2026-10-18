'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error('AUTH_SECRET must be set (32+ characters)');
  return s;
}

// ----- passwords: scrypt (built into Node, memory-hard) -----
const SC = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, SC);
  return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [v, s, h] = stored.split('$');
  if (v !== 's1' || !s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, SC);
  const want = Buffer.from(h, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}

// ----- signed session cookie (HMAC-SHA256) -----
const b64 = (b) => Buffer.from(b).toString('base64url');
function signSession(uid, tv, days = 7) {
  const body = b64(JSON.stringify({ u: uid, v: tv, e: Date.now() + days * 864e5 }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}
function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.e > Date.now() ? p : null;
  } catch (_) { return null; }
}
const COOKIE = 'qm_session';
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
const startSession = (res, u) => setCookie(res, signSession(u.id, u.token_version), 7 * 86400);
const endSession = (res) => setCookie(res, '', 0);

// ----- request helpers -----
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch (_) { fail(400, 'Invalid JSON'); }
  }
  return {};
}
function checkPost(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) fail(415, 'Content-Type must be application/json');
  const o = req.headers.origin;
  if (o) {
    let host;
    try { host = new URL(o).host; } catch (_) { fail(403, 'Bad origin'); }
    if (host !== req.headers.host) fail(403, 'Cross-site request blocked');
  }
}
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('[api error]', req.method, req.url, e && e.message); // never log bodies or secrets
      return send(res, 500, { error: 'Server error. Please try again.' });
    }
  };
}
module.exports = {
  HttpError, fail, hashPassword, verifyPassword, startSession, endSession, readSession,
  parseCookies, COOKIE, readJson, checkPost, send, handler,
};
