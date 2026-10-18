'use strict';
const crypto = require('crypto');
const db = require('./db');
const { fail, hashPassword, verifyPassword } = require('./http');

/* ---------------- small helpers ---------------- */
const J = JSON.stringify;
const P = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return d; } };
const iso = () => new Date().toISOString();
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const amt = (pr, q) => Math.round(Math.round(pr * 100) * q) / 100;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (o) => { Object.keys(o).forEach((k) => (o[k] == null) && delete o[k]); return o; };
const nf = (n) => String(+(+n).toFixed(3));
const UF = { kg: { f: 1000, s: 'g' }, g: { f: 1, s: 'g' }, L: { f: 1000, s: 'ml' }, ml: { f: 1, s: 'ml' } };
const qtxt = (u, q) => (UF[u] && UF[u].f === 1000 && q < 1 ? nf(q * 1000) + ' ' + UF[u].s : nf(q) + ' ' + u);
const CATS = ['Groceries', 'Ayurvedic Medicines', 'Other Medical Products', 'Household Products', 'Other Categories'];
const PTYPES = ['Packaged', 'Loose / Weighted', 'Perishable', 'Herbal / Ayurvedic', 'Medical device', 'Other'];
const isLoose = (pt) => /^Loose/.test(pt || '');
const REF = /^[A-Za-z0-9]{8,22}$/;
const MAIL = /^\S+@\S+\.\S+$/;

function S(v, min, max, label) {
  if (typeof v !== 'string') fail(400, label + ' is required');
  const t = v.trim();
  if (t.length < min || t.length > max) fail(400, `${label} must be ${min} to ${max} characters`);
  return t;
}
function NUM(v, label, o = {}) {
  const { min = 0, max = 1e9, int = false, gt0 = false } = o;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < min || n > max || (gt0 && n <= 0) || (int && !Number.isInteger(n))) fail(400, 'Invalid ' + label);
  return n;
}
function IMG(v, label) {
  if (typeof v !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 2.8e6) {
    fail(400, label + ' must be a JPG, PNG or WEBP image (up to 2 MB)');
  }
  return v;
}
const email = (v) => { const e = S(v, 5, 200, 'Email').toLowerCase(); if (!MAIL.test(e)) fail(400, 'Enter a valid email'); return e; };
const password = (v, label = 'Password') => {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) fail(400, label + ' must be 8 to 200 characters');
  return v;
};

async function nextId(q, name) {
  const r = await q('update counters set val = val + 1 where name = $1 returning val', [name]);
  return Number(r.rows[0].val);
}
async function notify(q, role, ref, title, msg, go) {
  const id = await nextId(q, 'notif');
  await q('insert into notifications(id, role, user_ref, title, msg, go, at, is_read) values ($1,$2,$3,$4,$5,$6,$7,0)',
    [id, role, ref || null, title, msg, go ? J(go) : null, iso()]);
}
const money = (n) => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN');
async function getRate(q) { const r = await q("select value from settings where key = 'commission_rate'"); return Number(r.rows[0].value); }

/* ---------------- users ---------------- */
const pubUser = (u) => clean({
  id: u.id, e: u.email, n: u.name, r: u.role, shop: u.shop, st: u.status,
  m: u.mobile, a: u.address, c: u.city, s: u.state, p: u.pin, cr: u.created_at,
});
async function userById(id, q = db.query) {
  const r = await q('select * from users where id = $1', [id]);
  return r.rows[0] || null;
}

async function register(body) {
  const name = S(body.name, 2, 100, 'Full name');
  const em = email(body.email);
  const pw = password(body.password);
  return db.tx(async (q) => {
    const ex = await q('select id from users where email = $1', [em]);
    if (ex.rows.length) fail(409, 'That email is already registered.');
    const id = 'B' + (await nextId(q, 'buyer'));
    await q('insert into users(id,email,name,role,status,password_hash,created_at) values ($1,$2,$3,$4,$5,$6,$7)',
      [id, em, name, 'buyer', 'Active', hashPassword(pw), iso()]);
    return { ok: true };
  });
}

async function login(body) {
  const em = email(body.email);
  const pw = typeof body.password === 'string' ? body.password : '';
  const r = await db.query('select * from users where email = $1', [em]);
  const u = r.rows[0];
  const bad = () => fail(401, 'Email or password is incorrect.');
  if (!u || !u.password_hash) { hashPassword('x'); return bad(); } // keeps timing similar
  if (u.locked_until && u.locked_until > iso()) fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  if (!verifyPassword(pw, u.password_hash)) {
    const n = Number(u.fail_count) + 1;
    await db.query('update users set fail_count = $1, locked_until = $2 where id = $3',
      [n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, u.id]);
    return bad();
  }
  if (u.status !== 'Active') fail(403, 'This account is ' + u.status.toLowerCase() + '. Contact the Super Admin.');
  await db.query('update users set fail_count = 0, locked_until = null where id = $1', [u.id]);
  return u;
}

async function activate(body) {
  const token = S(body.token, 20, 200, 'Activation link');
  const pw = password(body.password);
  const name = S(body.name, 2, 100, 'Your name');
  const shop = S(body.shop, 2, 100, 'Shop name');
  return db.tx(async (q) => {
    const r = await q("select * from users where invite_hash = $1 and status = 'Invited'", [sha(token)]);
    const u = r.rows[0];
    if (!u || !u.invite_exp || u.invite_exp < iso()) fail(400, 'This activation link is invalid or expired. Ask the admin for a new one.');
    await q("update users set password_hash=$1, status='Active', name=$2, shop=$3, invite_hash=null, invite_exp=null, token_version=token_version+1 where id=$4",
      [hashPassword(pw), name, shop, u.id]);
    await notify(q, 'admin', null, 'Owner activated', u.email, { v: 'owners' });
    await notify(q, 'owner', u.id, 'Welcome', 'Your owner account is active.');
    return userById(u.id, q);
  });
}

/* ---------------- state for the browser ---------------- */
const imgUrl = (kind, id, v, i) => `/api/img?${kind}=${encodeURIComponent(id)}${i != null ? '&i=' + i : ''}&v=${encodeURIComponent(v || '')}`;

function prodOut(p, withLog) {
  const items = P(p.items, null);
  return clean({
    id: p.id, oid: p.owner_id, t: p.type, n: p.name, cat: p.category, d: p.description, pt: p.ptype,
    pr: Number(p.price), stock: Number(p.stock), ps: Number(p.pkg_size), pu: p.pkg_unit, u: p.unit,
    exp: p.expiry, br: p.brand, dc: Number(p.discount), st: p.status, loc: p.location,
    cr: p.created_at, up: p.updated_at, q0: Number(p.qty0),
    img: p.image ? imgUrl('p', p.id, p.updated_at) : null,
    items: items ? items.map((it, i) => clean({ n: it.n, d: it.d, cat: it.cat, q: it.q, u: it.u, img: it.img ? imgUrl('p', p.id, p.updated_at, i) : null })) : null,
    log: withLog ? P(p.log, []) : null,
  });
}
const ordOut = (o) => clean({
  id: o.id, bid: o.buyer_email, oid: o.owner_id, lines: P(o.lines, []), sub: Number(o.sub), del: Number(o.del), tot: Number(o.tot),
  pm: o.pm, pay: o.pay, st: o.st, addr: P(o.addr, {}), hist: P(o.hist, []), rate: o.rate == null ? null : Number(o.rate),
  cr: o.created_at, done: o.done_at, cx: o.cancelled_at, recvB: o.recv_at, paidAt: o.paid_at, paidBy: o.paid_by,
  utr: o.utr, settled: o.settled_at,
});
const bpOut = (b) => clean({
  id: b.id, oid: b.order_id, own: b.owner_id, uid: b.buyer_email, kind: b.kind, amt: Number(b.amt), method: b.method,
  ref: b.ref, proof: b.proof ? imgUrl('bp', b.id, b.at) : null, t: b.at, st: b.status, vt: b.verified_at,
});
const cpOut = (c) => clean({
  id: c.id, oid: c.owner_id, amt: Number(c.amt), t: c.at, ref: c.ref,
  proof: c.proof ? imgUrl('cp', c.id, c.at) : null, st: c.status, vt: c.verified_at, vby: c.verified_by,
});

async function buildState(user) {
  const q = db.query;
  const role = user.role;
  const rows = async (sql, p) => (await q(sql, p)).rows;
  let owners = [], prods = [], orders = [], bps = [], cps = [], auds = [], stores = [], hist = [], notes = [];

  if (role === 'admin') {
    owners = await rows("select * from users where role = 'owner' order by created_at");
    prods = await rows('select * from products order by created_at desc');
    orders = await rows('select * from orders order by created_at desc');
    bps = await rows('select * from buyer_payments order by at desc');
    cps = await rows('select * from commission_payments order by at desc');
    auds = await rows('select * from audit order by at');
    stores = await rows('select * from store_status');
    hist = await rows('select * from store_history order by paused_at desc');
    notes = await rows("select * from notifications where role = 'admin' order by id desc limit 200");
  } else if (role === 'owner') {
    owners = [user];
    prods = await rows('select * from products where owner_id = $1 order by created_at desc', [user.id]);
    orders = await rows('select * from orders where owner_id = $1 order by created_at desc', [user.id]);
    bps = await rows('select * from buyer_payments where owner_id = $1 order by at desc', [user.id]);
    cps = await rows('select * from commission_payments where owner_id = $1 order by at desc', [user.id]);
    auds = await rows('select * from audit where owner_ref = $1 or owner_ref = $2 order by at', [user.id, 'ALL']);
    stores = await rows('select * from store_status where owner_id = $1', [user.id]);
    hist = await rows('select * from store_history where owner_id = $1 order by paused_at desc', [user.id]);
    notes = await rows("select * from notifications where role = 'owner' and user_ref = $1 order by id desc limit 200", [user.id]);
  } else {
    orders = await rows('select * from orders where buyer_id = $1 order by created_at desc', [user.id]);
    bps = await rows('select * from buyer_payments where buyer_email = $1 order by at desc', [user.email]);
    prods = await rows("select p.* from products p join users u on u.id = p.owner_id where p.status = 'Active' and u.status = 'Active'");
    const need = new Set();
    orders.forEach((o) => P(o.lines, []).forEach((l) => need.add(l.pid)));
    const have = new Set(prods.map((p) => p.id));
    for (const id of need) if (!have.has(id)) { const r = await rows('select * from products where id = $1', [id]); if (r[0]) prods.push(r[0]); }
    const ownerIds = new Set(prods.map((p) => p.owner_id));
    orders.forEach((o) => ownerIds.add(o.owner_id));
    for (const id of ownerIds) { const u = await userById(id); if (u) owners.push(u); }
    stores = await rows('select * from store_status');
    notes = await rows("select * from notifications where role = 'buyer' and user_ref = $1 order by id desc limit 200", [user.email]);
  }

  const U = [pubUser(user)];
  owners.forEach((o) => {
    if (o.id === user.id) return;
    const u = pubUser(o);
    if (role !== 'admin') { delete u.e; delete u.m; delete u.a; delete u.c; delete u.s; delete u.p; }
    U.push(u);
  });
  const STORE = {};
  stores.forEach((s) => { STORE[s.owner_id] = { st: s.status, msg: s.msg, since: s.since || null, resumedAt: s.resumed_at || null }; });
  const cfg = { upiId: process.env.UPI_ID || '', upiName: process.env.UPI_PAYEE_NAME || '' };
  return {
    me: pubUser(user), U, PR: prods.map((p) => prodOut(p, role !== 'buyer')), OR: orders.map(ordOut),
    BP: bps.map(bpOut), CP: cps.map(cpOut),
    AUD: auds.map((a) => ({ oid: a.owner_ref, orig: Number(a.orig), newV: Number(a.new_v), red: Number(a.red), reason: a.reason, admin: a.admin_email, t: a.at })),
    STORE, SH: hist.map((h) => clean({ id: h.id, oid: h.owner_id, n: h.name, msg: h.msg, pausedAt: h.paused_at, resumedAt: h.resumed_at })),
    N: notes.map((n) => ({ id: Number(n.id), r: n.role, u: n.user_ref, t: n.title, m: n.msg, go: P(n.go, undefined), at: n.at, read: Number(n.is_read) })),
    RATE: await getRate(q), cfg,
  };
}

/* ---------------- commission maths (server is the only authority) ---------------- */
async function outstanding(q, ownerId, rate) {
  const os = (await q("select * from orders where owner_id = $1 and st = 'Delivered'", [ownerId])).rows;
  let acc = 0;
  for (const o of os) {
    const lines = P(o.lines, []);
    const oamt = Math.round(lines.reduce((s, l) => s + amt(l.pr, l.q), 0) * 1000) / 1000;
    acc += +(oamt * (o.rate == null ? rate : Number(o.rate)) / 100).toFixed(2);
  }
  const red = (await q('select coalesce(sum(red),0) as s from audit where owner_ref = $1', [ownerId])).rows[0].s;
  const paid = (await q("select coalesce(sum(amt),0) as s from commission_payments where owner_id = $1 and status = 'Paid'", [ownerId])).rows[0].s;
  const pend = (await q("select coalesce(sum(amt),0) as s from commission_payments where owner_id = $1 and status = 'Pending Verification'", [ownerId])).rows[0].s;
  const out = Math.max(0, +(acc - Number(red) - Number(paid)).toFixed(2));
  return { out, pend: Number(pend), avail: Math.max(0, +(out - Number(pend)).toFixed(2)) };
}
async function dupRef(q, ref) {
  const l = ref.toLowerCase();
  const a = await q("select id from buyer_payments where lower(ref) = $1 and status <> 'Rejected'", [l]);
  const b = await q("select id from commission_payments where lower(ref) = $1 and status <> 'Rejected'", [l]);
  return a.rows.length + b.rows.length > 0;
}
async function storeInfo(q, ownerId) {
  const r = await q('select * from store_status where owner_id = $1', [ownerId]);
  return r.rows[0] || { status: 'active', msg: '' };
}
function productLog(p, k, x, d) {
  const log = P(p.log, []);
  log.push({ t: iso(), k, x, d: d || 0 });
  return J(log);
}
const requireActiveOwner = (u) => { if (u.status !== 'Active') fail(403, 'Your account is not active.'); };

/* ---------------- actions ---------------- */
const A = { buyer: {}, owner: {}, admin: {}, any: {} };

/* ===== shared ===== */
A.any.markRead = async ({ q, user }, d) => {
  const nid = NUM(d.id, 'notification', { int: true });
  if (user.role === 'admin') await q("update notifications set is_read = 1 where id = $1 and role = 'admin' and user_ref is null", [nid]);
  else await q('update notifications set is_read = 1 where id = $1 and role = $2 and user_ref = $3', [nid, user.role, user.role === 'owner' ? user.id : user.email]);
  return {};
};
A.any.markAllRead = async ({ q, user }) => {
  if (user.role === 'admin') await q("update notifications set is_read = 1 where role = 'admin' and user_ref is null");
  else await q('update notifications set is_read = 1 where role = $1 and user_ref = $2', [user.role, user.role === 'owner' ? user.id : user.email]);
  return {};
};
A.any.changePassword = async ({ q, user }, d) => {
  if (!verifyPassword(String(d.oldPassword || ''), user.password_hash)) fail(400, 'Current password is incorrect');
  const pw = password(d.newPassword, 'New password');
  await q('update users set password_hash = $1, token_version = token_version + 1 where id = $2', [hashPassword(pw), user.id]);
  return { reissue: true };
};

/* ===== buyer ===== */
A.buyer.saveProfile = async ({ q, user }, d) => {
  const n = S(d.n, 2, 100, 'Name');
  const m = String(d.m || '').trim(); if (!/^\d{10}$/.test(m)) fail(400, 'Enter a 10-digit mobile number');
  const a = S(d.a, 8, 300, 'Address'), c = S(d.c, 2, 100, 'City'), s = S(d.s, 2, 100, 'State');
  const p = String(d.p || '').trim(); if (!/^\d{6}$/.test(p)) fail(400, 'Enter a 6-digit PIN code');
  await q('update users set name=$1, mobile=$2, address=$3, city=$4, state=$5, pin=$6 where id=$7', [n, m, a, c, s, p, user.id]);
  return {};
};

function addrOk(a, needLoc) {
  if (!a || typeof a !== 'object') fail(400, 'Delivery details are required');
  const out = {
    n: S(a.n, 2, 100, 'Name'), m: String(a.m || '').trim(), e: email(a.e), a: S(a.a, 8, 300, 'Address'),
    c: S(a.c, 2, 100, 'City'), s: S(a.s, 2, 100, 'State'), p: String(a.p || '').trim(),
    i: typeof a.i === 'string' ? a.i.slice(0, 300) : '',
  };
  if (!/^\d{10}$/.test(out.m)) fail(400, 'Enter a 10-digit mobile number');
  if (!/^\d{6}$/.test(out.p)) fail(400, 'Enter a 6-digit PIN code');
  out.loc = needLoc ? S(a.loc, 8, 300, 'Delivery location') : (typeof a.loc === 'string' ? a.loc.slice(0, 300) : '');
  return out;
}

A.buyer.placeOrder = async ({ q, user }, d) => {
  const pm = d.pm === 'on' ? 'on' : d.pm === 'cod' ? 'cod' : fail(400, 'Choose a payment method');
  const addr = addrOk(d.addr, true);
  if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 50) fail(400, 'Your cart is empty');
  const want = new Map();
  for (const l of d.lines) {
    if (!l || typeof l.pid !== 'string') fail(400, 'Invalid item');
    want.set(l.pid, r3((want.get(l.pid) || 0) + NUM(l.q, 'quantity', { gt0: true, max: 100000 })));
  }
  let utr = null, proof = null;
  if (pm === 'on') {
    utr = String(d.utr || '').trim();
    if (!REF.test(utr)) fail(400, 'Enter the 8–22 character UTR / reference');
    proof = IMG(d.proof, 'Payment screenshot');
    if (await dupRef(q, utr)) fail(409, 'This reference was already submitted');
  }
  // validate products, group by owner
  const groups = new Map();
  for (const [pid, qty] of want) {
    const r = await q('select * from products where id = $1', [pid]);
    const p = r.rows[0];
    if (!p || p.status !== 'Active' || Number(p.stock) <= 0) fail(409, (p ? p.name : 'An item') + ' is no longer available');
    const ow = await userById(p.owner_id, q);
    if (!ow || ow.status !== 'Active') fail(409, p.name + ' is no longer available');
    const st = await storeInfo(q, p.owner_id);
    if (st.status === 'paused') fail(409, 'This Store Is Temporarily Paused. ' + (st.msg || ''));
    const loose = isLoose(p.ptype);
    if (loose) { if (Math.abs(qty * 1000 - Math.round(qty * 1000)) > 1e-6) fail(400, 'Invalid quantity for ' + p.name); }
    else if (!Number.isInteger(qty)) fail(400, 'Quantity for ' + p.name + ' must be a whole number');
    if (qty > Number(p.stock)) fail(409, `${p.name}: only ${loose ? qtxt(p.unit, Number(p.stock)) : p.stock} in stock`);
    const pr = r2(Number(p.price) * (1 - Number(p.discount || 0) / 100));
    const line = clean({
      pid: p.id, n: p.name, q: qty, pr, em: '📦', img: p.image ? imgUrl('p', p.id, p.updated_at) : null,
      ty: loose ? 'loose' : p.ptype === 'Packaged' ? 'packaged' : '', u: p.unit,
      ps: p.ptype === 'Packaged' && Number(p.pkg_size) ? nf(p.pkg_size) + ' ' + p.pkg_unit : '',
      qd: loose ? qtxt(p.unit, qty) : '',
    });
    if (!groups.has(p.owner_id)) groups.set(p.owner_id, []);
    groups.get(p.owner_id).push({ line, p });
  }
  const ids = [];
  const now = iso();
  for (const [ownerId, items] of groups) {
    const lines = items.map((x) => x.line);
    const sub = Math.round(lines.reduce((s, l) => s + amt(l.pr, l.q), 0) * 1000) / 1000;
    const del = sub < 999 ? 49 : 0;
    const tot = sub + del;
    const id = 'QM-' + (await nextId(q, 'order'));
    const on = pm === 'on';
    const st = on ? 'Awaiting Payment' : 'Placed';
    await q(`insert into orders(id,buyer_id,buyer_email,owner_id,lines,sub,del,tot,pm,pay,st,addr,hist,created_at,utr)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, user.id, user.email, ownerId, J(lines), sub, del, tot, pm, on ? 'Awaiting Verification' : 'Pending', st, J(addr), J([{ s: st, t: now }]), now, utr]);
    ids.push(id);
    for (const { line, p } of items) {
      const upd = await q('update products set stock = stock - $1, updated_at = $2 where id = $3 and stock >= $1', [line.q, now, p.id]);
      if (upd.rowCount !== 1) fail(409, p.name + ' just sold out. Please review your cart.');
      const fresh = (await q('select * from products where id = $1', [p.id])).rows[0];
      await q('update products set log = $1 where id = $2', [productLog(fresh, 'Quantity decreased', (on ? 'Reserved for order ' : 'Sold: order ') + id, -line.q), p.id]);
      const left = Number(fresh.stock);
      if (left === 0) await notify(q, 'owner', ownerId, 'Out of stock', p.name + ' is out of stock.', { v: 'hist' });
      else if (left <= 5) await notify(q, 'owner', ownerId, 'Low stock', `${p.name}: ${isLoose(p.ptype) ? qtxt(p.unit, left) : left} left.`, { v: 'hist' });
    }
    if (on) {
      const bid = 'BP-' + (await nextId(q, 'bp'));
      await q(`insert into buyer_payments(id,order_id,owner_id,buyer_email,kind,amt,method,ref,proof,at,status)
               values ($1,$2,$3,$4,'online',$5,'UPI QR',$6,$7,$8,'Pending Verification')`, [bid, id, ownerId, user.email, tot, utr, proof, now]);
      await notify(q, 'admin', null, 'Payment to verify', `${id} · ${money(tot)} · ref ${utr}`, { v: 'ver' });
      await notify(q, 'buyer', user.email, 'Payment proof submitted', id + ': awaiting verification. It is not marked paid yet.', { v: 'orders' });
    } else {
      await notify(q, 'buyer', user.email, 'Order Placed', `${id} · ${money(tot)} · Cash on Delivery`, { v: 'orders' });
      await notify(q, 'owner', ownerId, 'New order', `${id} · ${money(tot)} · COD`, { v: 'ord' });
      await notify(q, 'admin', null, 'New order', `${id} · ${money(tot)}`, { v: 'aord' });
    }
  }
  return { ids };
};

async function myOrder(q, user, id) {
  const o = (await q('select * from orders where id = $1 and buyer_id = $2', [String(id), user.id])).rows[0];
  if (!o) fail(404, 'Order not found');
  return o;
}
const pushHist = (o, s, t) => { const h = P(o.hist, []); h.push({ s, t }); return J(h); };

A.buyer.cancelOrder = async ({ q, user }, d) => {
  const o = await myOrder(q, user, d.id);
  if (!['Awaiting Payment', 'Placed', 'Confirmed'].includes(o.st)) fail(409, 'This order can no longer be cancelled');
  const now = iso();
  const res = await q("update orders set st = 'Cancelled', cancelled_at = $1, hist = $2 where id = $3 and st = $4", [now, pushHist(o, 'Cancelled', now), o.id, o.st]);
  if (res.rowCount !== 1) fail(409, 'This order can no longer be cancelled');
  for (const l of P(o.lines, [])) {
    await q('update products set stock = stock + $1, updated_at = $2 where id = $3', [l.q, now, l.pid]);
    const fresh = (await q('select * from products where id = $1', [l.pid])).rows[0];
    if (fresh) await q('update products set log = $1 where id = $2', [productLog(fresh, 'Quantity increased', 'Order cancelled: ' + o.id, l.q), l.pid]);
  }
  await q("update buyer_payments set status = 'Rejected', verified_at = $1 where order_id = $2 and status = 'Pending Verification'", [now, o.id]);
  await notify(q, 'owner', o.owner_id, 'Order cancelled', o.id + ' was cancelled by the buyer.', { v: 'ord' });
  await notify(q, 'buyer', user.email, 'Order cancelled', o.id + (o.pay === 'Paid' ? ': refund will be reviewed.' : ''), { v: 'orders' });
  await notify(q, 'admin', null, o.pay === 'Paid' ? 'Refund review needed' : 'Order cancelled', o.id, { v: 'aord' });
  return {};
};

A.buyer.submitProof = async ({ q, user }, d) => {
  const o = await myOrder(q, user, d.id);
  if (o.pm !== 'on' || o.st === 'Cancelled' || !['Pending', 'Failed'].includes(o.pay)) fail(409, 'Payment already submitted or not needed');
  const ref = String(d.utr || '').trim();
  if (!REF.test(ref)) fail(400, 'Enter the 8–22 character reference');
  const proof = IMG(d.proof, 'Payment screenshot');
  if (await dupRef(q, ref)) fail(409, 'This reference was already submitted');
  const now = iso();
  const bid = 'BP-' + (await nextId(q, 'bp'));
  await q(`insert into buyer_payments(id,order_id,owner_id,buyer_email,kind,amt,method,ref,proof,at,status)
           values ($1,$2,$3,$4,'online',$5,'UPI QR',$6,$7,$8,'Pending Verification')`, [bid, o.id, o.owner_id, user.email, o.tot, ref, proof, now]);
  await q("update orders set pay = 'Awaiting Verification', utr = $1 where id = $2", [ref, o.id]);
  await notify(q, 'admin', null, 'Payment to verify', `${o.id} · ${money(Number(o.tot))} · ref ${ref}`, { v: 'ver' });
  await notify(q, 'buyer', user.email, 'Payment submitted', o.id + ': awaiting verification. It is not marked paid yet.', { v: 'orders' });
  return {};
};

A.buyer.receiveOrder = async ({ q, user }, d) => {
  const o = await myOrder(q, user, d.id);
  if (o.st !== 'Placed' || o.recv_at) fail(409, 'Already recorded');
  const now = iso(), rate = await getRate(q);
  const res = await q("update orders set st = 'Delivered', done_at = $1, recv_at = $1, rate = $2, hist = $3 where id = $4 and st = 'Placed'", [now, rate, pushHist(o, 'Delivered', now), o.id]);
  if (res.rowCount !== 1) fail(409, 'Already recorded');
  const ow = await userById(o.owner_id, q);
  const oamt = P(o.lines, []).reduce((s, l) => s + amt(l.pr, l.q), 0);
  await notify(q, 'owner', o.owner_id, 'Order delivered', o.id + ': the buyer confirmed collection.', { v: 'ord' });
  await notify(q, 'buyer', user.email, 'Order delivered', o.id, { v: 'orders' });
  await notify(q, 'admin', null, 'Commission accrued', `${o.id}: ${money(+(oamt * rate / 100).toFixed(2))} for ${ow ? ow.name : o.owner_id}`, { v: 'aord' });
  return {};
};

A.buyer.confirmCash = async ({ q, user }, d) => {
  const o = await myOrder(q, user, d.id);
  if (o.pm !== 'cod' || o.st !== 'Delivered') fail(409, 'Not available for this order');
  if (o.pay === 'Paid') fail(409, 'Already marked as paid');
  const now = iso();
  await q("update orders set pay = 'Paid', paid_at = $1, paid_by = 'Buyer confirmation' where id = $2", [now, o.id]);
  const bid = 'BP-' + (await nextId(q, 'bp'));
  await q(`insert into buyer_payments(id,order_id,owner_id,buyer_email,kind,amt,method,ref,proof,at,status,verified_at)
           values ($1,$2,$3,$4,'cod',$5,'Cash (buyer confirmed)',$6,null,$7,'Paid',$7)`, [bid, o.id, o.owner_id, user.email, o.tot, 'CASH-' + o.id, now]);
  await notify(q, 'owner', o.owner_id, 'Payment received', `${o.id}: buyer confirmed cash payment of ${money(Number(o.tot))}.`, { v: 'ord' });
  await notify(q, 'buyer', user.email, 'Payment recorded', o.id + ' is marked Paid.', { v: 'history' });
  await notify(q, 'admin', null, 'Cash payment confirmed by buyer', `${o.id} · ${money(Number(o.tot))}`, { v: 'aord' });
  return {};
};

/* ===== owner ===== */
function baseProductFields(d) {
  const status = d.status === 'Inactive' || d.status === 'Disabled' ? 'Disabled' : 'Active';
  return {
    status,
    location: typeof d.loc === 'string' && d.loc.trim() ? d.loc.trim().slice(0, 100) : 'Main store',
  };
}
A.owner.addProduct = async ({ q, user }, d) => {
  requireActiveOwner(user);
  const name = S(d.n, 2, 150, 'Product name');
  const cat = CATS.includes(d.cat) ? d.cat : fail(400, 'Choose a valid category');
  const img = IMG(d.img, 'Product image');
  const desc = S(d.d, 10, 2000, 'Description');
  const pt = PTYPES.includes(d.pt) ? d.pt : fail(400, 'Choose a product type');
  const price = NUM(d.pr, 'price', { gt0: true, max: 10000000 });
  const loose = isLoose(pt);
  let stock = NUM(d.stock, 'stock', { max: 10000000 });
  if (loose) { if (Math.abs(stock * 1000 - Math.round(stock * 1000)) > 1e-6) fail(400, 'Stock can have up to 3 decimals'); stock = r3(stock); }
  else if (!Number.isInteger(stock)) fail(400, 'Stock must be a whole number');
  let unit = S(d.u, 1, 20, 'Unit');
  if (loose && !UF[unit]) fail(400, 'Choose kg, g, L or ml');
  let ps = 0, pu = '';
  if (pt === 'Packaged') { ps = NUM(d.ps, 'package size', { gt0: true, max: 1e7 }); pu = S(d.pu, 1, 20, 'Package unit'); }
  const exp = d.exp ? String(d.exp).slice(0, 10) : '';
  if (exp && !(new Date(exp) > new Date())) fail(400, 'Expiry date must be in the future');
  const dc = d.dc ? NUM(d.dc, 'discount', { max: 90 }) : 0;
  const b = baseProductFields(d);
  const id = 'P' + (await nextId(q, 'product'));
  const now = iso();
  const log = J([{ t: now, k: 'Created', x: 'Added with quantity ' + stock, d: stock }]);
  await q(`insert into products(id,owner_id,type,name,category,description,ptype,price,stock,unit,pkg_size,pkg_unit,expiry,brand,discount,status,location,image,log,qty0,created_at,updated_at)
           values ($1,$2,'single',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$8,$19,$19)`,
  [id, user.id, name, cat, desc, pt, price, stock, unit, ps, pu, exp || null, typeof d.br === 'string' ? d.br.slice(0, 80) : null, dc, b.status, b.location, img, log, now]);
  await notify(q, 'owner', user.id, 'Product added', `${name} is ${b.status === 'Active' ? 'active' : 'inactive'}.`, { v: 'hist' });
  return { id };
};

A.owner.addCombo = async ({ q, user }, d) => {
  requireActiveOwner(user);
  const name = S(d.n, 2, 150, 'Combo name');
  const desc = S(d.d, 10, 2000, 'Combo description');
  const img = IMG(d.img, 'Combo image');
  const price = NUM(d.pr, 'price', { gt0: true, max: 10000000 });
  const stock = NUM(d.stock, 'stock', { gt0: true, int: true, max: 10000000 });
  if (!Array.isArray(d.items) || d.items.length < 2 || d.items.length > 8) fail(400, 'A combo needs 2 to 8 products');
  const items = d.items.map((it, i) => ({
    n: S(it.n, 2, 150, `Product ${i + 1} name`), img: IMG(it.img, `Product ${i + 1} image`), d: S(it.d, 5, 1000, `Product ${i + 1} description`),
    cat: S(it.cat, 1, 60, `Product ${i + 1} category`), q: NUM(it.q, 'item quantity', { gt0: true, int: true, max: 100000 }), u: S(it.u, 1, 20, `Product ${i + 1} unit`),
  }));
  const id = 'P' + (await nextId(q, 'product'));
  const now = iso();
  const log = J([{ t: now, k: 'Created', x: 'Added with quantity ' + stock, d: stock }]);
  await q(`insert into products(id,owner_id,type,name,category,description,ptype,price,stock,unit,status,location,image,items,log,qty0,created_at,updated_at)
           values ($1,$2,'combo',$3,'Combos',$4,null,$5,$6,'package','Active','Main store',$7,$8,$9,$6,$10,$10)`,
  [id, user.id, name, desc, price, stock, img, J(items), log, now]);
  await notify(q, 'owner', user.id, 'Combo added', name + ' is live.', { v: 'hist' });
  return { id };
};

async function myProduct(q, user, id) {
  const p = (await q('select * from products where id = $1 and owner_id = $2', [String(id), user.id])).rows[0];
  if (!p) fail(404, 'Product not found');
  return p;
}
A.owner.editProduct = async ({ q, user }, d) => {
  requireActiveOwner(user);
  const p = await myProduct(q, user, d.id);
  const loose = isLoose(p.ptype);
  const n = S(d.n, 2, 150, 'Product name'), desc = S(d.d, 10, 2000, 'Description');
  const price = NUM(d.pr, 'price', { gt0: true, max: 10000000 });
  let stock = NUM(d.stock, 'stock', { max: 10000000 });
  if (loose) stock = r3(stock); else if (!Number.isInteger(stock)) fail(400, 'Stock must be a whole number');
  const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
  const loc = S(d.loc, 2, 100, 'Location');
  const status = d.status === 'Inactive' || d.status === 'Disabled' ? 'Disabled' : 'Active';
  const log = P(p.log, []);
  const now = iso();
  let changes = 0;
  const L = (k, x, dd) => { log.push({ t: now, k, x, d: dd || 0 }); changes++; };
  if (n !== p.name) L('Edited', `Name: ${p.name} → ${n}`);
  if (desc !== p.description) L('Edited', 'Description updated');
  let image = p.image;
  if (d.img) { image = IMG(d.img, 'Image'); L('Edited', 'Image replaced'); }
  if (price !== Number(p.price)) L('Edited', `Price: ${money(Number(p.price))} → ${money(price)}`);
  const diff = r3(stock - Number(p.stock));
  if (diff) {
    if (reason.length < 3) fail(400, 'Give a reason for the quantity change');
    L(diff > 0 ? 'Quantity increased' : 'Quantity decreased', `Quantity ${p.stock} → ${stock}. Reason: ${reason}`, diff);
  }
  if (loc !== p.location) L('Edited', `Location: ${p.location} → ${loc}`);
  if (status !== p.status) {
    if (status === 'Active' && stock <= 0) fail(400, 'Cannot activate: no stock available');
    L('Status', 'Status changed to ' + (status === 'Disabled' ? 'Inactive' : 'Active'));
  }
  if (!changes) fail(400, 'No changes to save');
  await q('update products set name=$1, description=$2, image=$3, price=$4, stock=$5, location=$6, status=$7, log=$8, updated_at=$9 where id=$10',
    [n, desc, image, price, stock, loc, status, J(log), now, p.id]);
  await notify(q, 'owner', user.id, 'Product updated', `${n}: ${changes} change(s) saved.`, { v: 'hist' });
  return {};
};

A.owner.setProductStatus = async ({ q, user }, d) => {
  const p = await myProduct(q, user, d.id);
  const s = ['Active', 'Disabled', 'Deleted'].includes(d.status) ? d.status : fail(400, 'Invalid status');
  if (p.status === 'Deleted') fail(409, 'This product was deleted');
  if (s === 'Active') {
    requireActiveOwner(user);
    if (Number(p.stock) <= 0) fail(409, 'Cannot resume: no stock available');
  }
  await q('update products set status = $1, log = $2, updated_at = $3 where id = $4',
    [s, productLog(p, 'Status', 'Status changed to ' + (s === 'Disabled' ? 'Inactive' : s)), iso(), p.id]);
  return {};
};

async function ownerOrder(q, user, id) {
  const o = (await q('select * from orders where id = $1 and owner_id = $2', [String(id), user.id])).rows[0];
  if (!o) fail(404, 'Order not found');
  return o;
}
A.owner.advanceOrder = async ({ q, user }, d) => {
  requireActiveOwner(user);
  const o = await ownerOrder(q, user, d.id);
  if (o.st !== 'Placed') fail(409, 'This order cannot be advanced');
  const now = iso(), rate = await getRate(q);
  const res = await q("update orders set st = 'Delivered', done_at = $1, rate = $2, hist = $3 where id = $4 and st = 'Placed'", [now, rate, pushHist(o, 'Delivered', now), o.id]);
  if (res.rowCount !== 1) fail(409, 'This order cannot be advanced');
  const oamt = P(o.lines, []).reduce((s, l) => s + amt(l.pr, l.q), 0);
  await notify(q, 'admin', null, 'Commission pending', `${o.id}: ${money(+(oamt * rate / 100).toFixed(2))} awaiting settlement.`, { v: 'ahist', p: 'commission' });
  await notify(q, 'buyer', o.buyer_email, 'Delivery completed', o.id + ' is now Delivered.', { v: 'history' });
  return {};
};
A.owner.collectCash = async ({ q, user }, d) => {
  const o = await ownerOrder(q, user, d.id);
  if (o.pm !== 'cod' || o.st !== 'Delivered') fail(409, 'Not available for this order');
  if (String(o.pay).startsWith('Paid')) fail(409, 'Already marked as paid');
  await q("update orders set pay = 'Paid (cash collected)', paid_at = $1 where id = $2", [iso(), o.id]);
  await notify(q, 'buyer', o.buyer_email, 'Payment received', o.id + ': cash collected.', { v: 'history' });
  return {};
};
A.owner.submitCommission = async ({ q, user }, d) => {
  const a = NUM(d.amt, 'amount', { gt0: true, max: 1e8 });
  const ref = String(d.ref || '').trim();
  if (!REF.test(ref)) fail(400, 'Enter the 8–22 character reference');
  const proof = IMG(d.proof, 'Payment screenshot');
  if (await dupRef(q, ref)) fail(409, 'This reference was already submitted');
  const o = await outstanding(q, user.id, await getRate(q));
  if (a > o.avail + 1e-9) fail(409, 'Amount exceeds what you can pay now');
  const id = 'CP-' + (await nextId(q, 'cp'));
  await q("insert into commission_payments(id,owner_id,amt,ref,proof,at,status) values ($1,$2,$3,$4,$5,$6,'Pending Verification')", [id, user.id, r2(a), ref, proof, iso()]);
  await notify(q, 'admin', null, 'Commission payment to verify', `${user.name} · ${money(a)} · ref ${ref}`, { v: 'ver' });
  await notify(q, 'owner', user.id, 'Payment submitted', `${id}: ${money(a)} is pending verification.`, { v: 'today' });
  return { id };
};
A.owner.pauseStore = async ({ q, user }, d) => {
  const msg = S(d.msg, 1, 500, 'Announcement');
  const cur = await storeInfo(q, user.id);
  if (cur.status === 'paused') fail(409, 'Your store is already paused');
  const now = iso();
  await q('delete from store_status where owner_id = $1', [user.id]);
  await q("insert into store_status(owner_id,status,msg,since,resumed_at) values ($1,'paused',$2,$3,null)", [user.id, msg, now]);
  const id = 'SP-' + (await nextId(q, 'sp')) + '-' + Date.now();
  await q('insert into store_history(id,owner_id,name,msg,paused_at,resumed_at) values ($1,$2,$3,$4,$5,null)', [id, user.id, user.name, msg, now]);
  await notify(q, 'owner', user.id, 'Store paused', 'Your store is paused. New orders are blocked until you resume.', { v: 'ord' });
  await notify(q, 'admin', null, 'Store paused', user.name + ' paused their store.', { v: 'ahist', p: 'store' });
  return {};
};
A.owner.resumeStore = async ({ q, user }) => {
  const cur = await storeInfo(q, user.id);
  if (cur.status !== 'paused') fail(409, 'Your store is already active');
  const now = iso();
  await q('delete from store_status where owner_id = $1', [user.id]);
  await q("insert into store_status(owner_id,status,msg,since,resumed_at) values ($1,'active','',null,$2)", [user.id, now]);
  await q('update store_history set resumed_at = $1 where owner_id = $2 and resumed_at is null', [now, user.id]);
  await notify(q, 'owner', user.id, 'Store active', 'Your store is active again.', { v: 'ord' });
  await notify(q, 'admin', null, 'Store resumed', user.name + ' resumed their store.', { v: 'ahist', p: 'store' });
  return {};
};

/* ===== admin ===== */
const newInvite = () => { const token = crypto.randomBytes(32).toString('hex'); return { token, hash: sha(token), exp: new Date(Date.now() + 7 * 864e5).toISOString() }; };
const linkFor = (origin, token) => `${origin}/#activate=${token}`;

A.admin.inviteOwner = async ({ q, origin }, d) => {
  const em = email(d.email);
  if ((await q('select id from users where email = $1', [em])).rows.length) fail(409, 'This email already has an account');
  const id = 'O' + (await nextId(q, 'owner'));
  const inv = newInvite();
  await q("insert into users(id,email,name,role,shop,status,invite_hash,invite_exp,created_at) values ($1,$2,$3,'owner','New shop','Invited',$4,$5,$6)",
    [id, em, em.split('@')[0].slice(0, 100), inv.hash, inv.exp, iso()]);
  await notify(q, 'admin', null, 'Owner invited', em, { v: 'create' });
  return { id, link: linkFor(origin, inv.token) };
};
A.admin.newInviteLink = async ({ q, origin }, d) => {
  const u = (await q("select * from users where id = $1 and role = 'owner' and status = 'Invited'", [String(d.id)])).rows[0];
  if (!u) fail(404, 'Invitation not found');
  const inv = newInvite();
  await q('update users set invite_hash = $1, invite_exp = $2 where id = $3', [inv.hash, inv.exp, u.id]);
  return { link: linkFor(origin, inv.token) };
};
A.admin.setOwnerStatus = async ({ q }, d) => {
  const s = ['Active', 'Suspended', 'Deleted'].includes(d.status) ? d.status : fail(400, 'Invalid status');
  const o = (await q("select * from users where id = $1 and role = 'owner'", [String(d.id)])).rows[0];
  if (!o) fail(404, 'Owner not found');
  if (o.status === 'Deleted') fail(409, 'This owner was deleted');
  if (o.status === 'Invited') fail(409, 'This owner has not activated yet');
  if (s === 'Deleted') {
    await q("update users set status='Deleted', name='Deleted owner', email=$1, shop='Closed shop', password_hash=null, token_version=token_version+1 where id=$2", ['deleted-' + o.id + '@anonymized.invalid', o.id]);
    await q("update products set status = 'Disabled', updated_at = $1 where owner_id = $2", [iso(), o.id]);
  } else {
    await q('update users set status = $1, token_version = token_version + 1 where id = $2', [s, o.id]);
  }
  await notify(q, 'owner', o.id, 'Account ' + s.toLowerCase(), 'Your owner account is now ' + s.toLowerCase() + '.');
  await notify(q, 'admin', null, 'Owner account ' + s.toLowerCase(), o.id, { v: 'owners' });
  return {};
};
A.admin.setRate = async ({ q, user }, d) => {
  const cur = await getRate(q);
  const v = NUM(d.rate, 'rate', { max: 100 });
  if (v > cur) fail(400, `Rate can only be reduced (current ${cur}%)`);
  const id = 'AU-' + (await nextId(q, 'audit'));
  await q("insert into audit(id,owner_ref,orig,new_v,red,reason,admin_email,at) values ($1,'ALL',$2,$3,0,'Commission rate reduced',$4,$5)", [id, cur, v, user.email, iso()]);
  await q("update settings set value = $1 where key = 'commission_rate'", [String(v)]);
  return {};
};
A.admin.adjustCommission = async ({ q, user }, d) => {
  const ownerId = String(d.owner);
  if (!(await q("select id from users where id = $1 and role = 'owner'", [ownerId])).rows.length) fail(404, 'Owner not found');
  const reason = S(d.reason, 2, 300, 'Reason');
  const nv = NUM(d.value, 'amount');
  const cur = (await outstanding(q, ownerId, await getRate(q))).out;
  if (nv > cur) fail(400, `Rejected: commission can only be reduced (current ${money(cur)})`);
  if (nv === cur) fail(400, 'No reduction entered');
  const id = 'AU-' + (await nextId(q, 'audit'));
  await q('insert into audit(id,owner_ref,orig,new_v,red,reason,admin_email,at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [id, ownerId, cur, nv, +(cur - nv).toFixed(2), reason, user.email, iso()]);
  await notify(q, 'owner', ownerId, 'Commission reduced', 'Your outstanding commission is now ' + money(nv) + '.', { v: 'today' });
  return {};
};
A.admin.settleOrder = async ({ q }, d) => {
  const o = (await q('select * from orders where id = $1', [String(d.id)])).rows[0];
  if (!o || o.st !== 'Delivered') fail(404, 'Delivered order not found');
  if (o.settled_at) fail(409, 'Already settled');
  await q('update orders set settled_at = $1 where id = $2', [iso(), o.id]);
  return {};
};
A.admin.verifyCommission = async ({ q, user }, d) => {
  const c = (await q('select * from commission_payments where id = $1', [String(d.id)])).rows[0];
  if (!c || c.status !== 'Pending Verification') fail(409, 'Already processed');
  const ok = !!d.ok, now = iso();
  const rate = await getRate(q);
  const before = (await outstanding(q, c.owner_id, rate)).out;
  if (ok && Number(c.amt) > before + 1e-9) {
    await q("update commission_payments set status='Rejected', verified_at=$1, verified_by=$2 where id=$3", [now, user.name, c.id]);
    return { msg: 'Rejected: amount exceeds the outstanding balance' };
  }
  await q('update commission_payments set status=$1, verified_at=$2, verified_by=$3 where id=$4', [ok ? 'Paid' : 'Rejected', now, user.name, c.id]);
  const after = (await outstanding(q, c.owner_id, rate)).out;
  await notify(q, 'owner', c.owner_id, ok ? 'Commission payment verified' : 'Commission payment rejected',
    `${c.id}: ${money(Number(c.amt))}` + (ok ? ' deducted. Outstanding: ' + money(after) : ' was not verified.'), { v: 'today' });
  return { msg: c.id + ': ' + (ok ? 'Paid' : 'Rejected') };
};
A.admin.verifyBuyerPayment = async ({ q }, d) => {
  const b = (await q('select * from buyer_payments where id = $1', [String(d.id)])).rows[0];
  if (!b || b.status !== 'Pending Verification') fail(409, 'Already processed');
  const o = (await q('select * from orders where id = $1', [b.order_id])).rows[0];
  const ok = !!d.ok && o && o.st !== 'Cancelled', now = iso();
  await q('update buyer_payments set status = $1, verified_at = $2 where id = $3', [ok ? 'Paid' : 'Rejected', now, b.id]);
  if (ok) {
    let st = o.st, hist = o.hist;
    if (o.st === 'Awaiting Payment') { st = 'Placed'; hist = pushHist(o, 'Placed', now); }
    await q("update orders set pay = 'Paid', paid_at = $1, st = $2, hist = $3 where id = $4", [now, st, hist, o.id]);
    await notify(q, 'owner', o.owner_id, 'Payment completed', `${o.id}: ${money(Number(o.tot))} is paid. Order is pending delivery.`, { v: 'ord' });
    await notify(q, 'buyer', o.buyer_email, 'Payment Completed', o.id + ' is verified and placed.', { v: 'orders' });
  } else if (o && o.st !== 'Cancelled') {
    await q("update orders set pay = 'Failed' where id = $1", [o.id]);
    await notify(q, 'buyer', o.buyer_email, 'Payment not verified', o.id + ': we could not verify it. Please pay again.', { v: 'orders' });
  }
  return { msg: b.id + ': ' + (ok ? 'Paid' : 'Rejected') };
};

/* ---------------- dispatcher ---------------- */
async function runAction(user, name, data, origin) {
  const table = A[user.role] || {};
  const fn = (Object.prototype.hasOwnProperty.call(table, name) && table[name])
    || (Object.prototype.hasOwnProperty.call(A.any, name) && A.any[name]);
  if (!fn) fail(403, 'Not allowed');
  return db.tx((q) => fn({ q, user, origin }, data || {}));
}

module.exports = { register, login, activate, userById, pubUser, buildState, runAction, hashPassword, verifyPassword, nextId, iso, outstanding, getRate };
