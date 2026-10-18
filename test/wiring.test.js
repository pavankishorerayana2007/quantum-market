'use strict';
// Drives the REAL frontend functions (doL, mkO, saveS, confirmOrder...) in a fake browser whose
// fetch() is connected to the REAL API handlers. Catches any mismatch between page and server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, Client, PNG, db, core } = require('./helpers');

const { makeBrowser, tick, until } = require('./browser');
test('page -> API wiring for admin, owner and buyer flows', async () => {
  freshDb();
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Super Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);

  // --- admin logs in through the real login form and invites an owner
  const A = makeBrowser();
  await tick(30);
  A.set({ le1: 'admin@test.dev', lp1: 'wrong-password' }); A.run('LM="l"; doL()');
  await until(() => A.run('$("le").textContent') !== '', 'login error shown');
  assert.match(A.run('$("le").textContent'), /incorrect/i);
  A.set({ lp1: 'AdminPass-12345' }); A.run('doL()');
  await until(() => A.run('ME&&ME.r') === 'admin', 'admin logged in');
  A.set({ ow_e: 'shop@test.dev' }); A.run('mkO()');
  await until(() => /activate=/.test(A.run('$("mdl").innerHTML')), 'activation link shown');
  const link = /(https?:\/\/[^<\s]*#activate=[0-9a-f]+)/.exec(A.run('$("mdl").innerHTML'))[1];
  await until(() => A.run('U.some(u=>u.e=="shop@test.dev"&&u.st=="Invited")'), 'invited owner listed');

  // --- owner opens the link, activates, adds a product with the real form function
  const O = makeBrowser('#activate=' + link.split('#activate=')[1]);
  await tick(30);
  assert.equal(O.run('LM'), 'a');
  O.set({ an: 'Rajesh', as: 'Rajesh Stores', lp1: 'OwnerPass-123', lc1: 'OwnerPass-123' }); O.run('doL()');
  await until(() => O.run('ME&&ME.r') === 'owner', 'owner activated + logged in');
  O.set({ s_n: 'Basmati Rice', s_c: 'Groceries', s_d: 'Long grain aged rice', s_t: 'Packaged', s_p: '100', s_s: '12', s_ps: '5', s_pu: 'kg', s_u: 'pack', s_x: '', s_b: '', s_dc: '10', s_a: 'Active', s_l: '' });
  O.run('IMG.s_img=' + JSON.stringify(PNG) + '; saveS()');
  await until(() => O.run('PR.length') === 1, 'product saved via API');
  assert.equal(O.run('PR[0].n'), 'Basmati Rice');

  // --- buyer registers, logs in, buys with Cash on Delivery through confirmOrder()
  const B = makeBrowser(); await tick(30);
  B.set({ rn: 'Anita', le1: 'anita@test.dev', lp1: 'BuyerPass-123', lc1: 'BuyerPass-123' }); B.run('LM="r"; doL()');
  await until(() => /Account created/.test(B.toast()), 'registered');
  B.set({ le1: 'anita@test.dev', lp1: 'BuyerPass-123' }); B.run('LM="l"; doL()');
  await until(() => B.run('ME&&ME.r') === 'buyer', 'buyer logged in');
  assert.equal(B.run('PR.length'), 1);
  B.run('CK={lines:[{pid:PR[0].id,q:2}],step:"review",addr:{n:"Anita",m:"9000000001",e:"anita@test.dev",a:"12 Test Street",c:"Vizag",s:"AP",p:"530001",i:""}}');
  B.set({ cf_m: '9000000001', cf_l: '12 Test Street, Vizag' }); B.run('confirmOrder()');
  await until(() => B.run('OR.length') === 1, 'order created');
  assert.equal(B.run('OR[0].tot'), 229); // 2 x 90 + 49 delivery, computed by the server
  assert.equal(B.run('PR[0].stock'), 10);
  assert.equal(B.run('CK.step'), 'done');

  // --- owner sees the order and marks it delivered; buyer sees it and confirms cash
  await O.run('sync()');
  assert.equal(O.run('OR.length'), 1);
  O.run('adv(OR[0].id)');
  await until(() => O.run('OR[0].st') === 'Delivered', 'delivered');
  await B.run('sync()');
  B.run('payCash(OR[0].id)');
  await until(() => B.run('OR[0].pay') === 'Paid', 'cash confirmed');

  // --- logout clears everything in the page
  B.run('signOut()');
  await until(() => B.run('ME') === null, 'logged out');
  assert.equal(B.run('PR.length+OR.length'), 0);
});
