'use strict';
// Real page functions + real API: payment QR screens, per-shop paying, owner approval, admin commission QR.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, PNG, db, core } = require('./helpers');
const { makeBrowser, tick, until } = require('./browser');

test('page flows for payment QR: admin QR, owner QR, buyer pays the shop, owner approves', async () => {
  freshDb();
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Super Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);

  const A = makeBrowser(); await tick(30);
  A.set({ le1: 'admin@test.dev', lp1: 'AdminPass-12345' }); A.run('LM="l"; doL()');
  await until(() => A.run('ME&&ME.r') === 'admin', 'admin in');
  assert.match(A.run('VW.pqr()'), /No payment QR uploaded yet/);
  A.set({ q_u: 'bad upi' }); A.run('IMG.q_img=' + JSON.stringify(PNG) + '; savePay()');
  await tick(60); assert.equal(A.run('ME.pq'), undefined, 'invalid UPI is not saved');
  A.set({ q_u: 'admin@testbank' }); A.run('savePay()');
  await until(() => A.run('!!ME.pq'), 'admin QR saved');
  assert.match(A.run('VW.pqr()'), /admin@testbank/);
  assert.equal(/<h2[^>]*>Buyer payments/.test(A.run('VW.ver()')), false, 'admin Verify shows only commission payments');
  A.set({ ow_e: 'shop@test.dev' }); A.run('mkO()');
  await until(() => /activate=/.test(A.run('$("mdl").innerHTML')), 'link');
  const link = /#activate=([0-9a-f]+)/.exec(A.run('$("mdl").innerHTML'))[1];

  const O = makeBrowser('#activate=' + link); await tick(30);
  O.set({ an: 'Rajesh', as: 'Rajesh Stores', lp1: 'OwnerPass-123', lc1: 'OwnerPass-123' }); O.run('doL()');
  await until(() => O.run('ME&&ME.r') === 'owner', 'owner in');
  O.set({ s_n: 'Basmati Rice', s_c: 'Groceries', s_d: 'Long grain aged rice', s_t: 'Packaged', s_p: '100', s_s: '12', s_ps: '5', s_pu: 'kg', s_u: 'pack', s_x: '', s_b: '', s_dc: '0', s_a: 'Active', s_l: '' });
  O.run('IMG.s_img=' + JSON.stringify(PNG) + '; saveS()');
  await until(() => O.run('PR.length') === 1, 'product');
  assert.match(O.run('VW.pver()'), /Buyer payments to verify/);
  assert.equal(O.run('U.filter(u=>u.r=="owner").length'), 1, 'owner page only knows itself');

  const B = makeBrowser(); await tick(30);
  B.set({ rn: 'Anita', le1: 'anita@test.dev', lp1: 'BuyerPass-123', lc1: 'BuyerPass-123' }); B.run('LM="r"; doL()');
  await until(() => /Account created/.test(B.toast()), 'registered');
  B.set({ le1: 'anita@test.dev', lp1: 'BuyerPass-123' }); B.run('LM="l"; doL()');
  await until(() => B.run('ME&&ME.r') === 'buyer', 'buyer in');
  const oid = B.run('PR[0].oid');
  B.run('CK={cart:0,pm:"on",step:"pay",lines:[{pid:PR[0].id,q:1}],addr:{n:"Anita",m:"9000000001",e:"anita@test.dev",a:"12 Test Street",c:"Vizag",s:"AP",p:"530001",i:""}}');
  assert.match(B.run('VW.co()'), /not set up online payment/, 'Pay Now is blocked while the shop has no QR');
  assert.equal(B.run('U.some(u=>u.r=="admin")'), false, 'buyer never receives the admin entry');

  O.set({ q_u: 'rajesh@testbank' }); O.run('IMG.q_img=' + JSON.stringify(PNG) + '; savePay()');
  await until(() => O.run('!!ME.pq'), 'owner QR saved');
  await B.run('sync()');
  assert.equal(B.run('U.find(u=>u.id=="' + oid + '").qo'), 1);
  assert.equal(B.run('U.find(u=>u.id=="' + oid + '").pq'), undefined, 'QR not sent until the shop is in cart/orders');
  B.run('placeOn("' + oid + '")');
  await until(() => B.run('!!PSN'), 'pay screen opened');
  assert.match(B.run('VW.pay()'), /rajesh@testbank/);
  assert.match(B.run('VW.pay()'), /<img src="\/api\/img\?qr=/);
  B.set({ pn_r: 'FRONTQR0001' }); B.run('IMG.pn_img=' + JSON.stringify(PNG) + '; psSub()');
  await until(() => B.run('OR.length') === 1, 'order created');
  assert.equal(B.run('OR[0].pay'), 'Awaiting Verification');

  await O.run('sync()');
  assert.equal(O.run('BP.filter(b=>b.st=="Pending Verification").length'), 1);
  assert.match(O.run('VW.pver()'), /FRONTQR0001/);
  O.run('vbp(BP[0].id,1)');
  await until(() => O.run('OR[0].pay') === 'Paid', 'owner approved');
  await B.run('sync()'); assert.equal(B.run('OR[0].st'), 'Placed');

  // commission screen shows the ADMIN QR to the owner
  O.run('adv(OR[0].id)'); await until(() => O.run('OR[0].st') === 'Delivered', 'delivered');
  const pay = O.run('V={};VW.paycom()');
  assert.match(pay, /Pay Commission/);
  O.run('V.pcs=2;V.pca=1'); assert.match(O.run('VW.paycom()'), /admin@testbank/);
  assert.equal(O.run('adminU().pq').startsWith('/api/img?qr=A1'), true);
});
