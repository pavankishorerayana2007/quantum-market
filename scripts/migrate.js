'use strict';
// Creates the empty tables. Safe to run many times. Inserts NO demo data.
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first (see README).'); process.exit(1); }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const stmts = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await db.query(s);
  console.log('Database tables are ready. No demo data was added.');
  await db.close();
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
