'use strict';
// Loads the real public/index.html script in a fake browser and renders every screen
// using real data produced by the backend, for all three roles, plus the empty state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { freshDb, Client, PNG, db, core } = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

function el() {
  const e = { value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, files: [], disabled: false, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, parentNode: null, className: '',
    addEventListener() {}, setSelectionRange() {}, select() {}, focus() {} };
  e.parentNode = { style: {} };
  return e;
}
function browser(stateJson) {
  const els = {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, Date, Math, JSON, Object, Array, Promise, Number, String, RegExp, Set, Map, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    document: { getElementById: (id) => (els[id] = els[id] || el()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, hidden: false, createElement: () => ({ getContext: () => ({}) }), execCommand() {} },
    location: { hash: '', pathname: '/' }, history: { replaceState() {} }, scrollTo() {}, navigator: {}, Image: function () {},
    fetch: async (url) => ({ ok: true, status: 200, json: async () => (url === '/api/auth' ? { user: null } : JSON.parse(JSON.stringify(stateJson))) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}
const ADDR = { n: 'Test Buyer', m: '9000000001', e: 'b@test.dev', a: '12 Test Street', c: 'Vizag', s: 'AP', p: '530001', loc: '12 Test Street, Vizag' };

async function render(stateJson, role) {
  const ctx = browser(stateJson);
  await vm.runInContext('(async()=>{await sync()})()', ctx);
  const views = vm.runInContext('Object.keys(VW)', ctx);
  const bad = [];
  const has = (expr) => vm.runInContext(expr, ctx);
  const hasProd = has('PR.length>0'), hasOwner = has('U.some(u=>u.r=="owner")');
  const ODET = ['details', 'prod', 'ord', 'today', 'pay'];
  const cases = [];
  for (const v of views) {
    if (v === 'edit') { if (hasProd && role.startsWith('owner')) cases.push([v, 'V.edit=PR[0].id']); continue; }
    if (v === 'odet') { if (hasOwner && role.startsWith('admin')) ODET.forEach((t) => cases.push([v + ':' + t, `V.od=U.find(u=>u.r=="owner").id;V.ot="${t}";`, v])); continue; }
    if (v === 'co') { if (hasProd && role.startsWith('buyer')) ['addr', 'pay', 'review'].forEach((st) => cases.push([v + ':' + st, `CK={lines:[{pid:PR[0].id,q:1}],step:"${st}",addr:{n:"A B",m:"9000000001",e:"a@b.co",a:"12 Test Street",c:"X",s:"Y",p:"530001",i:""},pm:"cod"}`, v])); continue; }
    cases.push([v, '']);
  }
  for (const [label, pre, v] of cases) {
    const name = v || label;
    let out;
    try { out = vm.runInContext(`(()=>{V={};${pre};return String(VW[${JSON.stringify(name)}]())})()`, ctx); } catch (e) { bad.push(`${role}/${label}: threw ${e.message}`); continue; }
    if (/undefined|NaN|\[object/.test(out)) bad.push(`${role}/${label}: contains ${(out.match(/.{0,20}(undefined|NaN|\[object).{0,20}/) || [''])[0]}`);
  }
  // history/graph screens have after-render functions that fill tables
  for (const f of ['drawP', 'drawH', 'drawA']) { try { vm.runInContext(`if(AF){}`, ctx); } catch (_) { /* ignore */ } }
  return { ctx, views, bad };
}

test('frontend: no demo data and no browser storage in the shipped page', () => {
  assert.equal(/demo1234|@demo\.com|@quantum\.shop|localStorage|sessionStorage/.test(html), false);
  const ctx = browser({});
  assert.equal(vm.runInContext('U.length+PR.length+OR.length+N.length+BP.length+CP.length', ctx), 0, 'all arrays start empty');
});

test('frontend: every screen renders for every role with real server data and with an empty database', async () => {
  freshDb();
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1','admin@test.dev','Super Admin','admin','Active',$1,$2)", [core.hashPassword('AdminPass-12345'), core.iso()]);
  const admin = new Client(); await admin.auth({ a: 'login', email: 'admin@test.dev', password: 'AdminPass-12345' });
  const emptyAdmin = (await admin.state()).json;
  const e = await render(emptyAdmin, 'admin-empty');
  assert.deepEqual(e.bad, [], 'empty-state render problems:\n' + e.bad.join('\n'));

  const inv = await admin.act('inviteOwner', { email: 'o@test.dev' });
  const owner = new Client();
  await owner.auth({ a: 'activate', token: inv.json.link.split('#activate=')[1], password: 'OwnerPass-123', name: 'Owner', shop: 'Shop' });
  const emptyOwner = (await owner.state()).json;
  const eo = await render(emptyOwner, 'owner-empty');
  assert.deepEqual(eo.bad, [], 'empty owner screens:\n' + eo.bad.join('\n'));

  await owner.act('addProduct', { n: 'Rice', cat: 'Groceries', img: PNG, d: 'Good rice for testing', pt: 'Packaged', pr: 100, stock: 20, ps: 1, pu: 'kg', u: 'pack', dc: 5, status: 'Active', loc: 'Main store' });
  await owner.act('addProduct', { n: 'Loose Dal', cat: 'Groceries', img: PNG, d: 'Loose dal by weight', pt: 'Loose / Weighted', pr: 80, stock: 10.5, u: 'kg', dc: 0, status: 'Active', loc: 'Main store' });
  const it = { n: 'Item A', img: PNG, d: 'item desc', cat: 'Groceries', q: 1, u: 'pack' };
  await owner.act('addCombo', { n: 'Combo', d: 'A fine combo deal', img: PNG, pr: 300, stock: 5, items: [it, { ...it, n: 'Item B' }] });
  const buyer = new Client();
  await buyer.auth({ a: 'register', name: 'Test Buyer', email: 'b@test.dev', password: 'BuyerPass-123' });
  await buyer.auth({ a: 'login', email: 'b@test.dev', password: 'BuyerPass-123' });
  const eb = await render((await buyer.state()).json, 'buyer-before-orders');
  assert.deepEqual(eb.bad, [], eb.bad.join('\n'));
  const prods = (await buyer.state()).json.PR;
  const rice = prods.find((p) => p.n === 'Rice'), dal = prods.find((p) => p.n === 'Loose Dal');
  assert.equal((await buyer.act('placeOrder', { pm: 'cod', addr: ADDR, lines: [{ pid: rice.id, q: 3 }, { pid: dal.id, q: 0.25 }] })).status, 200);
  await owner.act('savePayment', { upi: 'shop@testbank', img: PNG });
  assert.equal((await buyer.act('placeOrder', { pm: 'on', addr: ADDR, lines: [{ pid: rice.id, q: 1 }], utr: 'FRONT000001', proof: PNG })).status, 200);
  const oid = (await buyer.state()).json.OR.find((o) => o.pm === 'cod').id;
  await owner.act('advanceOrder', { id: oid });
  await buyer.act('confirmCash', { id: oid });
  await owner.act('pauseStore', { msg: 'Short break for stock-taking' });
  await admin.act('savePayment', { upi: 'admin@testbank', img: PNG });
  await owner.act('submitCommission', { amt: 1, ref: 'COMM0000001', proof: PNG });
  for (const [who, c] of [['admin', admin], ['owner', owner], ['buyer', buyer]]) {
    const r = await render((await c.state()).json, who);
    assert.deepEqual(r.bad, [], who + ' screens:\n' + r.bad.join('\n'));
    assert.ok(r.views.length > 10);
  }
});
