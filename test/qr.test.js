'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, Client, PNG, db, core } = require('./helpers');

const ADDR = { n: 'Buyer', m: '9000000001', e: 'b@test.dev', a: '12 Test Street', c: 'Vizag', s: 'AP', p: '530001', loc: '12 Test Street, Vizag' };
const prod = (n) => ({ n, cat: 'Groceries', img: PNG, d: 'Good product for tests', pt: 'Packaged', pr: 100, stock: 10, ps: 1, pu: 'kg', u: 'pack', dc: 0, status: 'Active', loc: 'Main store' });
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]).toString('base64');
const WEBP = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(30)]).toString('base64');
const qrOf = async (c, id) => (await c.call('img', { method: 'GET', url: `/api/img?qr=${id}` })).status;
let admin, o1, o2, id1, id2, buyer;

test('setup: empty database, admin, two owners, one buyer, one product each', async () => {
  freshDb();
  for (const t of ['users', 'images', 'qr_access', 'products', 'orders']) assert.equal(Number((await db.query(`select count(*) as n from ${t}`)).rows[0].n), 0, t + ' starts empty');
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);
  admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const mk = async (mail) => {
    const inv = await admin.act('inviteOwner', { email: mail });
    const c = new Client();
    const r = await c.auth({ a: 'activate', token: inv.json.link.split('#activate=')[1], password: 'OwnerPass-123', name: 'Owner', shop: 'Shop ' + mail });
    return { c, id: r.json.user.id };
  };
  ({ c: o1, id: id1 } = await mk('o1@test.dev')); ({ c: o2, id: id2 } = await mk('o2@test.dev'));
  await o1.act('addProduct', prod('Item One')); await o2.act('addProduct', prod('Item Two'));
  buyer = new Client();
  await buyer.auth({ a: 'register', name: 'Buyer', email: 'b@test.dev', password: 'BuyerPass-123' });
  await buyer.auth({ a: 'login', email: 'b@test.dev', password: 'BuyerPass-123' });
});

test('QR upload: UPI format, image signature and size are enforced on the server', async () => {
  assert.equal((await o1.act('savePayment', { upi: 'not a upi', img: PNG })).status, 400);
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank' })).status, 400, 'first save needs an image');
  const fake = (b, m = 'png') => `data:image/${m};base64,` + Buffer.from(b).toString('base64');
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank', img: fake('this is not an image at all, just text') })).status, 400, 'wrong file signature');
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank', img: fake('GIF89a-------------------------', 'gif') })).status, 400, 'GIF not allowed');
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 + 10)]).toString('base64');
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank', img: big })).status, 400, 'over 2 MB');
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank', img: JPG })).status, 200, 'JPG ok');
  assert.equal((await o1.act('savePayment', { upi: 'o1@testbank', img: WEBP })).status, 200, 'WEBP ok, replaces old');
  assert.equal((await o1.act('savePayment', { upi: 'o1-new@testbank' })).status, 200, 'UPI can change without a new image');
  assert.equal(Number((await db.query("select count(*) as n from images where owner_id = $1", [id1])).rows[0].n), 1, 'old QR image is deleted on replace');
  assert.equal((await o2.act('savePayment', { upi: 'o2@testbank', img: PNG })).status, 200);
  assert.equal((await new Client().act('savePayment', { upi: 'x@testbank', img: PNG })).status, 401);
  assert.equal((await buyer.act('savePayment', { upi: 'x@testbank', img: PNG })).status, 403, 'buyers have no QR');
});

test('buyer cannot get the admin QR or any owner QR without an order / cart item', async () => {
  assert.equal((await admin.act('savePayment', { upi: 'admin@testbank', img: PNG })).status, 200);
  assert.equal(await qrOf(buyer, 'A1'), 404, 'admin QR hidden from buyers');
  assert.equal(await qrOf(buyer, id1), 404, 'owner 1 QR: no order or cart yet');
  assert.equal(await qrOf(buyer, id2), 404, 'owner 2 QR: no order or cart yet');
  assert.equal(await qrOf(new Client(), id1), 401, 'logged-out visitors get nothing');
  const s = (await buyer.state()).json;
  const ownersSeen = s.U.filter((u) => u.r === 'owner');
  assert.ok(ownersSeen.length >= 2);
  ownersSeen.forEach((u) => { assert.equal(u.pu, undefined); assert.equal(u.pq, undefined); assert.equal(u.qo, 1, 'buyer knows Pay Now is possible'); });
  assert.equal(s.U.some((u) => u.r === 'admin'), false, 'buyers never receive admin payment data');
  assert.equal(JSON.stringify(s).includes('admin@testbank'), false);
});

test('cart item or order from a shop unlocks only THAT shop QR for the buyer', async () => {
  const pid1 = (await buyer.state()).json.PR.find((p) => p.n === 'Item One').id;
  assert.equal((await buyer.act('payInfo', { pids: [pid1] })).status, 200);
  assert.equal(await qrOf(buyer, id1), 200);
  assert.equal(await qrOf(buyer, id2), 404, 'other shop stays hidden');
  const s = (await buyer.state()).json;
  const u1 = s.U.find((u) => u.id === id1), u2 = s.U.find((u) => u.id === id2);
  assert.equal(u1.pu, 'o1-new@testbank'); assert.match(u1.pq, /^\/api\/img\?qr=/);
  assert.equal(u2.pu, undefined);
  assert.equal(await qrOf(buyer, 'A1'), 404);
});

test('owners: own QR + admin QR only; never another owner QR; admin sees all', async () => {
  assert.equal(await qrOf(o1, id1), 200); assert.equal(await qrOf(o1, 'A1'), 200);
  assert.equal(await qrOf(o1, id2), 404, 'owner cannot fetch another owner QR');
  assert.equal(await qrOf(o2, id1), 404);
  const s = (await o1.state()).json;
  assert.equal(s.U.some((u) => u.id === id2), false, 'owner state has no other owner');
  assert.deepEqual(s.U.filter((u) => u.r === 'admin').map((u) => u.pu), ['admin@testbank']);
  assert.equal(await qrOf(admin, id1), 200); assert.equal(await qrOf(admin, id2), 200); assert.equal(await qrOf(admin, 'A1'), 200);
  assert.equal((await admin.state()).json.U.filter((u) => u.r === 'owner').every((u) => u.pq), true);
});

test('online orders: one shop at a time, shop must have a QR, owner (not admin) approves', async () => {
  const st = (await buyer.state()).json.PR;
  const a = st.find((p) => p.n === 'Item One').id, b = st.find((p) => p.n === 'Item Two').id;
  const base = { pm: 'on', addr: ADDR, utr: 'TEST0000001', proof: PNG };
  assert.equal((await buyer.act('placeOrder', { ...base, lines: [{ pid: a, q: 1 }, { pid: b, q: 1 }] })).status, 400, 'two shops in one online payment');
  assert.equal((await buyer.act('placeOrder', { ...base, lines: [{ pid: a, q: 1 }] })).status, 200);
  assert.equal((await buyer.act('placeOrder', { ...base, utr: 'TEST0000002', lines: [{ pid: b, q: 1 }] })).status, 200, 'second shop paid separately with its own QR');
  const bps = (await admin.state()).json.BP;
  assert.equal(bps.length, 2, 'admin can see buyer payments');
  const bp1 = bps.find((x) => x.own === id1), bp2 = bps.find((x) => x.own === id2);
  assert.equal((await admin.act('verifyBuyerPayment', { id: bp1.id, ok: 1 })).status, 403, 'admin cannot approve');
  assert.equal((await o1.act('verifyBuyerPayment', { id: bp2.id, ok: 1 })).status, 404, 'owner cannot approve another owner payment');
  assert.equal((await o2.act('verifyBuyerPayment', { id: bp1.id, ok: 0 })).status, 404);
  assert.equal((await o1.act('verifyBuyerPayment', { id: bp1.id, ok: 1 })).status, 200);
  assert.equal((await o2.act('verifyBuyerPayment', { id: bp2.id, ok: 1 })).status, 200);
  assert.equal(JSON.stringify((await o1.state()).json.BP).includes(bp2.id), false, 'owners only see their own buyer payments');
  // the buyer now has orders from both shops, so both QR images are available
  assert.equal(await qrOf(buyer, id2), 200);
});

test('a shop with no QR cannot take online payment; Cash on Delivery still works', async () => {
  const inv = await admin.act('inviteOwner', { email: 'o3@test.dev' });
  const o3 = new Client();
  await o3.auth({ a: 'activate', token: inv.json.link.split('#activate=')[1], password: 'OwnerPass-123', name: 'Owner3', shop: 'No QR Shop' });
  await o3.act('addProduct', prod('Item Three'));
  const pid = (await buyer.state()).json.PR.find((p) => p.n === 'Item Three').id;
  const r = await buyer.act('placeOrder', { pm: 'on', addr: ADDR, utr: 'TEST0000009', proof: PNG, lines: [{ pid, q: 1 }] });
  assert.equal(r.status, 409); assert.match(r.json.error, /not set up online payment/);
  assert.equal((await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid, q: 1 }] })).status, 200);
  const u3 = (await buyer.state()).json.U.find((u) => u.shop === 'No QR Shop');
  assert.equal(u3.qo, 0);
});

test('commission: needs the admin QR; only the admin approves; buyers/owners cannot read it elsewhere', async () => {
  freshDbWithOrderForCommission: {
    const ow = (await o1.state()).json;
    const oid = ow.OR[0].id;
    assert.equal((await o1.act('advanceOrder', { id: oid })).status, 200);
  }
  const ref = 'COMM0000001';
  assert.equal((await o1.act('submitCommission', { amt: 1, ref, proof: PNG })).status, 200);
  const cp = (await o1.state()).json.CP[0];
  assert.equal((await o1.act('verifyCommission', { id: cp.id, ok: 1 })).status, 403, 'owner cannot approve own commission');
  assert.equal((await buyer.act('verifyCommission', { id: cp.id, ok: 1 })).status, 403);
  assert.equal((await admin.act('verifyCommission', { id: cp.id, ok: 1 })).status, 200);
});

test('no admin QR -> commission cannot be submitted (fresh database)', async () => {
  freshDb();
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);
  const ad = new Client(); await ad.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const inv = await ad.act('inviteOwner', { email: 'z@test.dev' });
  const ow = new Client(); await ow.auth({ a: 'activate', token: inv.json.link.split('#activate=')[1], password: 'OwnerPass-123', name: 'Zed', shop: 'Zed Shop' });
  const r = await ow.act('submitCommission', { amt: 5, ref: 'COMM0000009', proof: PNG });
  assert.equal(r.status, 409); assert.match(r.json.error, /not available yet/);
  assert.equal((await ow.state()).json.U.find((u) => u.r === 'admin').qo, 0);
});
