'use strict';
const db = require('../lib/db');
const { handler, send } = require('../lib/http');

// Shows whether the server is configured. Never shows secrets or data.
module.exports = handler(async (req, res) => {
  const env = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    AUTH_SECRET: !!process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32,
    UPI_ID: !!process.env.UPI_ID,
  };
  let database = 'not configured';
  if (env.DATABASE_URL) {
    try { await db.query('select 1 as ok'); database = 'connected'; } catch (e) { database = 'error'; }
  }
  const ready = env.DATABASE_URL && env.AUTH_SECRET && database === 'connected';
  send(res, ready ? 200 : 503, { ready, database, env });
});
