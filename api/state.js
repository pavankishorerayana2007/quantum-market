'use strict';
const core = require('../lib/core');
const { handler, send, fail } = require('../lib/http');
const { requireUser } = require('../lib/session');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') fail(405, 'Method not allowed');
  const u = await requireUser(req);
  send(res, 200, await core.buildState(u));
});
