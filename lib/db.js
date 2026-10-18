'use strict';
// Tiny database layer. Production = PostgreSQL via "pg". Tests swap in node:sqlite (same SQL).
// query(sql, params) -> { rows, rowCount }.  tx(fn) runs fn(q) inside a transaction.
let impl = null;

function useImpl(i) { impl = i; }

function pgImpl() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 10000 });
  const wrap = (c) => async (sql, p = []) => {
    const r = await c.query(sql, p);
    return { rows: r.rows, rowCount: r.rowCount };
  };
  return {
    query: wrap(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

function get() { if (!impl) impl = pgImpl(); return impl; }
module.exports = {
  useImpl,
  query: (s, p) => get().query(s, p),
  tx: (fn) => get().tx(fn),
  close: () => (impl && impl.close ? impl.close() : undefined),
};
