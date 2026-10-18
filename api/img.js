'use strict';
const db = require('../lib/db');
const { handler, fail } = require('../lib/http');
const { currentUser } = require('../lib/session');

// Serves product images (public) and payment proofs (only people allowed to see them).
function sendImage(res, dataUrl, cache) {
  const m = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) fail(404, 'Not found');
  res.statusCode = 200;
  res.setHeader('Content-Type', m[1]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cache);
  res.end(Buffer.from(m[2], 'base64'));
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') fail(405, 'Method not allowed');
  const url = new URL(req.url, 'http://x');
  const pid = url.searchParams.get('p'), bp = url.searchParams.get('bp'), cp = url.searchParams.get('cp');
  if (pid) {
    const r = await db.query('select image, items, status, owner_id from products where id = $1', [pid]);
    const p = r.rows[0];
    if (!p) fail(404, 'Not found');
    const i = url.searchParams.get('i');
    let img = p.image;
    if (i !== null) { const items = JSON.parse(p.items || '[]'); img = items[Number(i)] && items[Number(i)].img; }
    return sendImage(res, img, 'public, max-age=31536000, immutable'); // URL changes (v=) when product changes
  }
  const u = await currentUser(req);
  if (!u) fail(401, 'Please log in.');
  if (bp) {
    const b = (await db.query('select * from buyer_payments where id = $1', [bp])).rows[0];
    if (!b || !(u.role === 'admin' || (u.role === 'owner' && b.owner_id === u.id) || (u.role === 'buyer' && b.buyer_email === u.email))) fail(404, 'Not found');
    return sendImage(res, b.proof, 'private, max-age=3600');
  }
  if (cp) {
    const c = (await db.query('select * from commission_payments where id = $1', [cp])).rows[0];
    if (!c || !(u.role === 'admin' || (u.role === 'owner' && c.owner_id === u.id))) fail(404, 'Not found');
    return sendImage(res, c.proof, 'private, max-age=3600');
  }
  return fail(404, 'Not found');
});
