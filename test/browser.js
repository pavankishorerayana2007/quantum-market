'use strict';
// Fake browser that runs the real public/index.html script, with fetch() wired to the real API handlers.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { Client } = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await tick(10); } assert.fail('timed out: ' + label); }

function makeBrowser(hash = '') {
  const els = {}; const jar = new Client();
  const el = () => ({ value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, files: [], disabled: false, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, parentNode: { style: {} }, className: '', addEventListener() {}, setSelectionRange() {}, select() {}, focus() {}, setAttribute() {}, removeAttribute() {}, getAttribute: () => null, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, blur() {}, click() {} });
  const toasts = [];
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, Date, Math, JSON, Object, Array, Promise, Number, String, RegExp, Set, Map, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    document: { getElementById: (id) => (els[id] = els[id] || el()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, hidden: false, createElement: () => ({}), execCommand() {} },
    location: { hash, pathname: '/' }, history: { replaceState() {} }, scrollTo() {}, navigator: {}, Image: function () {},
    fetch: async (url, opt = {}) => {
      const name = url.startsWith('/api/auth') ? 'auth' : url.startsWith('/api/act') ? 'act' : 'state';
      const r = await jar.call(name, { method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : undefined, url });
      return { ok: r.status < 400, status: r.status, json: async () => r.json };
    },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(script, ctx);
  const run = (c) => vm.runInContext(c, ctx);
  const set = (o) => Object.entries(o).forEach(([k, v]) => { ctx.document.getElementById(k).value = v; });
  return { ctx, run, set, jar, els, toast: () => run('$("toast").textContent') };
}

module.exports = { makeBrowser, tick, until };
