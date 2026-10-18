'use strict';
// One-time setup: creates the first administrator from ADMIN_EMAIL and ADMIN_PASSWORD.
// Refuses to run if an admin already exists. Nothing is created automatically anywhere else.
const db = require('../lib/db');
const core = require('../lib/core');

(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a real email address.');
  if (pw.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  const ex = await db.query("select id from users where role = 'admin'");
  if (ex.rows.length) throw new Error('An administrator already exists. Nothing was changed.');
  await db.query("insert into users(id,email,name,role,status,password_hash,created_at) values ('A1',$1,'Super Admin','admin','Active',$2,$3)",
    [email, core.hashPassword(pw), core.iso()]);
  console.log('Administrator created for ' + email + '. Now remove ADMIN_PASSWORD from your terminal history/environment.');
  await db.close();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
