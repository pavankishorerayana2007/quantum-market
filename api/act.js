'use strict';
const core = require('../lib/core');
const { handler, send, readJson, checkPost, startSession, fail } = require('../lib/http');
const { requireUser, originOf } = require('../lib/session');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') fail(405, 'Method not allowed');
  checkPost(req);
  const u = await requireUser(req);
  const d = await readJson(req);
  if (typeof d.a !== 'string') fail(400, 'Unknown request');
  const out = await core.runAction(u, d.a, d, originOf(req));
  if (out && out.reissue) { // password changed: old sessions die, give this browser a new one
    startSession(res, await core.userById(u.id));
    delete out.reissue;
  }
  send(res, 200, out || {});
});
