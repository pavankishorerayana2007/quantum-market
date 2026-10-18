'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, Client, PNG, db, core } = require('./helpers');

const count = async (t) => Number((await db.query(`select count(*) as n from ${t}`)).rows[0].n);
const ADDR = { n: 'Test Buyer', m: '9000000001', e: 'buyer1@test.dev', a: '12 Test Street', c: 'Vizag', s: 'Andhra Pradesh', p: '530001', loc: '12 Test Street, Vizag' };
let raw;

async function makeAdmin() {
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Super Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);
  const c = new Client();
  const r = await c.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  assert.equal(r.status, 200);
  return c;
}
async function makeOwner(admin, mail = 'owner1@test.dev') {
  const inv = await admin.act('inviteOwner', { email: mail });
  assert.equal(inv.status, 200);
  const token = inv.json.link.split('#activate=')[1];
  const c = new Client();
  const r = await c.auth({ a: 'activate', token, password: 'OwnerPass-123', name: 'Owner One', shop: 'Owner Shop' });
  assert.equal(r.status, 200);
  return { c, id: r.json.user.id, token };
}
const product = (o = {}) => ({ n: 'Test Rice', cat: 'Groceries', img: PNG, d: 'Good rice for testing', pt: 'Packaged', pr: 100, stock: 10, ps: 1, pu: 'kg', u: 'pack', dc: 0, status: 'Active', loc: 'Main store', ...o });
async function buyerClient(mail = 'buyer1@test.dev') {
  const c = new Client();
  assert.equal((await c.auth({ a: 'register', name: 'Test Buyer', email: mail, password: 'BuyerPass-123' })).status, 201);
  assert.equal((await c.auth({ a: 'login', email: mail, password: 'BuyerPass-123' })).status, 200);
  return c;
}

test('1. a brand-new database contains zero application records', async () => {
  raw = freshDb();
  for (const t of ['users', 'products', 'orders', 'buyer_payments', 'commission_payments', 'audit', 'notifications', 'store_status', 'store_history']) {
    assert.equal(await count(t), 0, t + ' must be empty');
  }
  // only system metadata exists
  assert.equal(await count('settings'), 1);
});

test('2. empty state: admin dashboard data is empty, not fake', async () => {
  const admin = await makeAdmin();
  const s = (await admin.state()).json;
  assert.equal(s.PR.length, 0); assert.equal(s.OR.length, 0); assert.equal(s.BP.length, 0); assert.equal(s.CP.length, 0); assert.equal(s.N.length, 0);
  assert.equal(s.U.length, 1); assert.equal(s.U[0].r, 'admin'); assert.equal(s.RATE, 5);
  assert.equal(JSON.stringify(s).includes('demo'), false);
  const b = await buyerClient('first@test.dev'); // a brand-new buyer sees an empty shop
  const bs = (await b.state()).json;
  assert.equal(bs.PR.length, 0); assert.equal(bs.OR.length, 0); assert.equal(bs.U.length, 1);
});

test('3. auth: register, duplicate, bad login, cookie flags, logout, lockout', async () => {
  const c = new Client();
  assert.equal((await c.auth({ a: 'register', name: 'A B', email: 'x@test.dev', password: 'short' })).status, 400);
  assert.equal((await c.auth({ a: 'register', name: 'A B', email: 'x@test.dev', password: 'LongEnough-1' })).status, 201);
  assert.equal((await c.auth({ a: 'register', name: 'A B', email: 'X@test.dev', password: 'LongEnough-1' })).status, 409);
  assert.equal((await c.auth({ a: 'login', email: 'x@test.dev', password: 'wrongwrong' })).status, 401);
  assert.equal((await c.auth({ a: 'login', email: 'nobody@test.dev', password: 'wrongwrong' })).status, 401);
  const ok = await c.auth({ a: 'login', email: 'x@test.dev', password: 'LongEnough-1' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly/); assert.match(ok.headers['set-cookie'], /SameSite=Lax/);
  const hash = (await db.query("select password_hash from users where email='x@test.dev'")).rows[0].password_hash;
  assert.ok(hash.startsWith('s1$') && !hash.includes('LongEnough'));
  assert.equal((await c.call('auth', { method: 'GET' })).json.user.e, 'x@test.dev');
  await c.auth({ a: 'logout' });
  assert.equal((await c.call('auth', { method: 'GET' })).json.user, null);
  const l = new Client();
  for (let i = 0; i < 5; i++) await l.auth({ a: 'login', email: 'x@test.dev', password: 'nope-nope-1' });
  assert.equal((await l.auth({ a: 'login', email: 'x@test.dev', password: 'LongEnough-1' })).status, 429);
});

test('4. protected endpoints and CSRF checks', async () => {
  const anon = new Client();
  assert.equal((await anon.state()).status, 401);
  assert.equal((await anon.act('markAllRead')).status, 401);
  const b = await buyerClient('csrf@test.dev');
  const bad = await b.call('act', { body: { a: 'markAllRead' }, headers: { origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
  const ct = await b.call('act', { body: '{"a":"markAllRead"}', headers: { 'content-type': 'text/plain' } });
  assert.equal(ct.status, 415);
  const tampered = new Client(); tampered.cookie = b.cookie.slice(0, -3) + 'abc';
  assert.equal((await tampered.state()).status, 401);
});

test('5. owner invite/activation: single-use link, no default password', async () => {
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const o = await makeOwner(admin);
  const again = new Client();
  assert.equal((await again.auth({ a: 'activate', token: o.token, password: 'Another-Pass-1', name: 'Hacker', shop: 'Evil' })).status, 400);
  const row = (await db.query("select password_hash,status from users where email='owner1@test.dev'")).rows[0];
  assert.equal(row.status, 'Active');
  assert.equal((await new Client().auth({ a: 'login', email: 'owner1@test.dev', password: 'demo1234' })).status, 401);
});

test('6. roles: buyers/owners cannot use admin actions or other owners\' data', async () => {
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const buyer = await buyerClient('roles@test.dev');
  assert.equal((await buyer.act('setRate', { rate: 1 })).status, 403);
  assert.equal((await buyer.act('addProduct', product())).status, 403);
  const o1 = new Client(); await o1.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  assert.equal((await o1.act('setOwnerStatus', { id: 'O1', status: 'Suspended' })).status, 403);
  assert.equal((await o1.act('constructor')).status, 403);
  assert.equal((await o1.act('__proto__')).status, 403);
  const o2 = await makeOwner(admin, 'owner2@test.dev');
  const p = (await o1.act('addProduct', product({ n: 'Owner1 Item' }))).json;
  assert.equal((await o2.c.act('editProduct', { id: p.id, n: 'Hacked', d: 'long enough text', pr: 1, stock: 1, loc: 'x1', status: 'Active' })).status, 404);
  assert.equal((await o2.c.act('setProductStatus', { id: p.id, status: 'Deleted' })).status, 404);
  assert.equal((await o2.c.state()).json.PR.length, 0);
});

test('7. products: validation, empty shop listing then real listing', async () => {
  const buyer = await buyerClient('shopper@test.dev');
  const base = (await buyer.state()).json.PR.length;
  const o1 = new Client(); await o1.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  assert.equal((await o1.act('addProduct', product({ pr: -5 }))).status, 400);
  assert.equal((await o1.act('addProduct', product({ img: 'not-an-image' }))).status, 400);
  assert.equal((await o1.act('addProduct', product({ cat: 'Weapons' }))).status, 400);
  const r = await o1.act('addProduct', product({ n: 'Basmati', stock: 5, dc: 10 }));
  assert.equal(r.status, 200);
  const s = (await buyer.state()).json;
  const bas = s.PR.find((p) => p.n === 'Basmati');
  assert.equal(s.PR.length, base + 1); assert.equal(bas.log, undefined, 'buyers do not get stock logs');
  assert.match(bas.img, /^\/api\/img\?p=/);
  const img = await new Client().call('img', { method: 'GET', url: bas.img });
  assert.equal(img.status, 200); assert.equal(img.headers['content-type'], 'image/png');
  // inactive products are hidden from buyers
  const p2 = (await o1.act('addProduct', product({ n: 'Hidden', status: 'Inactive' }))).json.id;
  assert.equal((await buyer.state()).json.PR.length, base + 1);
  assert.equal((await o1.act('setProductStatus', { id: p2, status: 'Active' })).status, 200);
  assert.equal((await buyer.state()).json.PR.length, base + 2);
});

test('8. combos need 2-8 items with images', async () => {
  const o1 = new Client(); await o1.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  const it = { n: 'Item A', img: PNG, d: 'item desc', cat: 'Groceries', q: 1, u: 'pack' };
  assert.equal((await o1.act('addCombo', { n: 'Combo', d: 'A fine combo deal', img: PNG, pr: 300, stock: 5, items: [it] })).status, 400);
  assert.equal((await o1.act('addCombo', { n: 'Combo', d: 'A fine combo deal', img: PNG, pr: 300, stock: 5, items: [it, { ...it, n: 'Item B' }] })).status, 200);
});

test('9. COD order: server sets prices, stock drops, tampering/overselling/paused store blocked, cancel restores', async () => {
  const buyer = await buyerClient('cod@test.dev');
  const pr = (await buyer.state()).json.PR.find((p) => p.n === 'Basmati');
  const owner = new Client(); await owner.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  // client-sent price is ignored
  const r = await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: pr.id, q: 2, pr: 1 }] });
  assert.equal(r.status, 200);
  const st = (await buyer.state()).json;
  const o = st.OR[0];
  assert.equal(o.lines[0].pr, 90, '100 less 10% discount, computed by server');
  assert.equal(o.sub, 180); assert.equal(o.del, 49); assert.equal(o.tot, 229);
  assert.equal(st.PR.find((p) => p.id === pr.id).stock, 3);
  assert.equal((await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: pr.id, q: 4 }] })).status, 409, 'oversell blocked');
  assert.equal((await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: pr.id, q: 1.5 }] })).status, 400, 'fraction of a packaged item blocked');
  assert.equal((await buyer.act('placeOrder', { pm: 'cod', addr: { ...ADDR, m: '123' }, lines: [{ pid: pr.id, q: 1 }] })).status, 400);
  // paused store
  assert.equal((await owner.act('pauseStore', { msg: 'Closed for a day' })).status, 200);
  const paused = await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: pr.id, q: 1 }] });
  assert.equal(paused.status, 409); assert.match(paused.json.error, /Paused/i);
  assert.equal((await owner.act('resumeStore')).status, 200);
  // another buyer cannot cancel it; owner cannot cancel as buyer
  const other = await buyerClient('other@test.dev');
  assert.equal((await other.act('cancelOrder', { id: o.id })).status, 404);
  assert.equal((await other.state()).json.OR.length, 0, 'other buyers cannot see this order');
  assert.equal((await buyer.act('cancelOrder', { id: o.id })).status, 200);
  assert.equal((await buyer.state()).json.PR.find((p) => p.id === pr.id).stock, 5, 'stock restored');
  assert.equal((await buyer.act('cancelOrder', { id: o.id })).status, 409);
});

test('10. delivery, cash confirmation, commission rules, payments verification', async () => {
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const owner = new Client(); await owner.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  const buyer = await buyerClient('flow@test.dev');
  const pr = (await buyer.state()).json.PR.find((p) => p.n === 'Basmati');
  await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: pr.id, q: 5 }] }); // 5 x 90 = 450
  const oid = (await buyer.state()).json.OR[0].id;
  assert.equal((await buyer.act('advanceOrder', { id: oid })).status, 403, 'buyers cannot deliver');
  assert.equal((await buyer.act('confirmCash', { id: oid })).status, 409, 'cash cannot be confirmed before delivery');
  assert.equal((await owner.act('advanceOrder', { id: oid })).status, 200);
  assert.equal((await owner.act('advanceOrder', { id: oid })).status, 409);
  assert.equal((await buyer.act('confirmCash', { id: oid })).status, 200);
  assert.equal((await buyer.act('confirmCash', { id: oid })).status, 409);
  // commission = 5% of 450 = 22.50
  const ow = (await owner.state()).json;
  assert.equal(ow.OR.find((o) => o.id === oid).rate, 5);
  const ref = 'UTR12345678';
  assert.equal((await owner.act('submitCommission', { amt: 30, ref, proof: PNG })).status, 409, 'more than owed');
  assert.equal((await owner.act('submitCommission', { amt: 10, ref, proof: PNG })).status, 200);
  assert.equal((await owner.act('submitCommission', { amt: 5, ref, proof: PNG })).status, 409, 'duplicate reference');
  const cpId = (await owner.state()).json.CP[0].id;
  assert.equal((await owner.act('verifyCommission', { id: cpId, ok: 1 })).status, 403, 'owner cannot verify own payment');
  const proof = await owner.call('img', { method: 'GET', url: `/api/img?cp=${cpId}` });
  assert.equal(proof.status, 200);
  const otherOwner = new Client();
  assert.equal((await otherOwner.call('img', { method: 'GET', url: `/api/img?cp=${cpId}` })).status, 401, 'proofs are private');
  assert.equal((await buyer.call('img', { method: 'GET', url: `/api/img?cp=${cpId}` })).status, 404);
  assert.equal((await admin.act('verifyCommission', { id: cpId, ok: 1 })).status, 200);
  assert.equal((await admin.act('verifyCommission', { id: cpId, ok: 1 })).status, 409, 'cannot process twice');
  const out = await core.outstanding(db.query, ow.me.id, 5);
  assert.equal(out.out, 12.5);
  // admin reductions only go down
  assert.equal((await admin.act('adjustCommission', { owner: ow.me.id, value: 99, reason: 'test' })).status, 400);
  assert.equal((await admin.act('adjustCommission', { owner: ow.me.id, value: 2.5, reason: 'goodwill' })).status, 200);
  assert.equal((await core.outstanding(db.query, ow.me.id, 5)).out, 2.5);
  assert.equal((await admin.act('setRate', { rate: 9 })).status, 400);
  assert.equal((await admin.act('setRate', { rate: 3 })).status, 200);
  assert.equal((await admin.state()).json.RATE, 3);
});

test('11. online payment: reference + screenshot required, duplicates blocked, admin approval places order', async () => {
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const buyer = await buyerClient('online@test.dev');
  const owner = new Client(); await owner.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  await owner.act('addProduct', product({ n: 'Online Item', stock: 10 })); // Basmati is sold out by now
  const pr = (await buyer.state()).json.PR.find((p) => p.n === 'Online Item');
  const base = { pm: 'on', addr: ADDR, lines: [{ pid: pr.id, q: 1 }] };
  assert.equal((await buyer.act('placeOrder', base)).status, 400, 'needs UTR');
  assert.equal((await buyer.act('placeOrder', { ...base, utr: 'UTR12345678', proof: PNG })).status, 409, 'reference used earlier');
  assert.equal((await buyer.act('placeOrder', { ...base, utr: 'ONLINE00001', proof: 'bad' })).status, 400);
  assert.equal((await buyer.act('placeOrder', { ...base, utr: 'ONLINE00001', proof: PNG })).status, 200);
  let o = (await buyer.state()).json.OR[0];
  assert.equal(o.st, 'Awaiting Payment'); assert.equal(o.pay, 'Awaiting Verification');
  const bp = (await admin.state()).json.BP.find((b) => b.oid === o.id);
  assert.equal((await buyer.act('verifyBuyerPayment', { id: bp.id, ok: 1 })).status, 403);
  assert.equal((await admin.act('verifyBuyerPayment', { id: bp.id, ok: 1 })).status, 200);
  o = (await buyer.state()).json.OR[0];
  assert.equal(o.st, 'Placed'); assert.equal(o.pay, 'Paid');
  // rejected proof -> buyer can pay again
  const pr2 = pr;
  await buyer.act('placeOrder', { ...base, lines: [{ pid: pr2.id, q: 1 }], utr: 'ONLINE00002', proof: PNG });
  const o2 = (await buyer.state()).json.OR[0];
  const bp2 = (await admin.state()).json.BP.find((b) => b.oid === o2.id);
  await admin.act('verifyBuyerPayment', { id: bp2.id, ok: 0 });
  assert.equal((await buyer.state()).json.OR[0].pay, 'Failed');
  assert.equal((await buyer.act('submitProof', { id: o2.id, utr: 'ONLINE00003', proof: PNG })).status, 200);
  assert.equal((await buyer.act('submitProof', { id: o2.id, utr: 'ONLINE00004', proof: PNG })).status, 409, 'already awaiting verification');
});

test('12. suspension/deletion immediately locks owners out and hides their products', async () => {
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const owner = new Client(); await owner.auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' });
  const id = (await owner.state()).json.me.id;
  const buyer = await buyerClient('susp@test.dev');
  assert.ok((await buyer.state()).json.PR.length > 0);
  assert.equal((await admin.act('setOwnerStatus', { id, status: 'Suspended' })).status, 200);
  assert.equal((await owner.state()).status, 401, 'existing session is dead');
  assert.equal((await new Client().auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' })).status, 403);
  assert.equal((await buyer.state()).json.PR.length, 0);
  assert.equal((await admin.act('setOwnerStatus', { id, status: 'Active' })).status, 200);
  assert.equal((await admin.act('setOwnerStatus', { id, status: 'Deleted' })).status, 200);
  assert.equal((await new Client().auth({ a: 'login', email: 'owner1@test.dev', password: 'OwnerPass-123' })).status, 401);
});

test('13. password change signs other sessions out; notifications are private', async () => {
  const b = await buyerClient('pw@test.dev');
  const second = new Client(); await second.auth({ a: 'login', email: 'pw@test.dev', password: 'BuyerPass-123' });
  assert.equal((await b.act('changePassword', { oldPassword: 'wrong', newPassword: 'NewPassword-1' })).status, 400);
  assert.equal((await b.act('changePassword', { oldPassword: 'BuyerPass-123', newPassword: 'NewPassword-1' })).status, 200);
  assert.equal((await b.state()).status, 200, 'this browser stays signed in');
  assert.equal((await second.state()).status, 401, 'other sessions are signed out');
  assert.equal((await new Client().auth({ a: 'login', email: 'pw@test.dev', password: 'NewPassword-1' })).status, 200);
  const n = (await b.state()).json.N;
  const other = await buyerClient('pw2@test.dev');
  assert.equal(JSON.stringify((await other.state()).json.N).includes('pw@test.dev'), false);
  assert.ok(Array.isArray(n));
});

test('14. health endpoint reports status without leaking secrets', async () => {
  const r = await new Client().call('health', { method: 'GET' });
  assert.equal(JSON.stringify(r.json).includes('test-secret'), false);
});
