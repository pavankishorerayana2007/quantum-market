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
  const pid = url.searchParams.get('p'), bp = url.searchParams.get('bp'), cp = url.searchParams.get('cp'), qr = url.searchParams.get('qr');
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
  if (qr) {
    // owner QR -> that owner, the admin, or a buyer with an order/cart item from that owner.
    // admin QR -> only owners and the admin. Buyers can never get the admin QR.
    const t = (await db.query('select id, role, status, pay_qr from users where id = $1', [qr])).rows[0];
    if (!t || !t.pay_qr) fail(404, 'Not found');
    let ok = false;
    if (u.role === 'admin') ok = true;
    else if (u.role === 'owner') ok = t.id === u.id || t.role === 'admin';
    else if (u.role === 'buyer' && t.role === 'owner' && t.status === 'Active') {
      const ord = await db.query('select id from orders where buyer_id = $1 and owner_id = $2 limit 1', [u.id, t.id]);
      const cart = await db.query('select buyer_id from qr_access where buyer_id = $1 and owner_id = $2 and at >= $3', [u.id, t.id, new Date(Date.now() - 864e5).toISOString()]);
      ok = ord.rows.length > 0 || cart.rows.length > 0;
    }
    if (!ok) fail(404, 'Not found');
    const im = (await db.query('select data from images where id = $1', [t.pay_qr])).rows[0];
    return sendImage(res, im && im.data, 'private, max-age=3600');
  }
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
