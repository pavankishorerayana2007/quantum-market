'use strict';
const core = require('../lib/core');
const { handler, send, readJson, checkPost, startSession, endSession, fail } = require('../lib/http');
const { currentUser } = require('../lib/session');

module.exports = handler(async (req, res) => {
  if (req.method === 'GET') {
    const u = await currentUser(req);
    return send(res, 200, { user: u ? core.pubUser(u) : null });
  }
  if (req.method !== 'POST') fail(405, 'Method not allowed');
  checkPost(req);
  const d = await readJson(req);
  switch (d.a) {
    case 'register':
      await core.register(d);
      return send(res, 201, { ok: true });
    case 'login': {
      const u = await core.login(d);
      startSession(res, u);
      return send(res, 200, { user: core.pubUser(u) });
    }
    case 'activate': {
      const u = await core.activate(d);
      startSession(res, u);
      return send(res, 200, { user: core.pubUser(u) });
    }
    case 'logout':
      endSession(res);
      return send(res, 200, { ok: true });
    default:
      return fail(400, 'Unknown request');
  }
});
