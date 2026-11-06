'use strict';

const {
  configured,
  checkPassphrase,
  issueToken,
  sessionCookie,
  isAuthenticated,
  originAllowed,
  rateLimit,
  clientIp,
  json,
  methodNotAllowed,
  readJson,
} = require('../lib/session');

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

module.exports = async (req, res) => {
  if (!configured()) {
    return json(res, 503, {
      error: 'This board is not configured. Set BOARD_PASSPHRASE and SESSION_SECRET.',
      configured: false,
    });
  }

  if (req.method === 'GET') {
    return json(res, 200, { authenticated: isAuthenticated(req) });
  }

  if (req.method === 'POST') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });

    const ip = clientIp(req);
    const limit = rateLimit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!limit.ok) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
      return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
    }

    const parsed = await readJson(req, 2048);
    if (!parsed.ok) return json(res, parsed.status, { error: parsed.error });

    if (!checkPassphrase(parsed.value.passphrase)) {
      // One message for every failure: a distinct "wrong passphrase" vs
      // "unconfigured" response would tell an attacker when to keep trying.
      return json(res, 401, { error: 'Wrong passphrase' });
    }

    const token = issueToken();
    return json(
      res,
      200,
      { authenticated: true },
      { 'Set-Cookie': sessionCookie(token) }
    );
  }

  if (req.method === 'DELETE') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};
