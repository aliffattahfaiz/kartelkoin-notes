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
const { minLength, setPassphrase, epoch, MAX_LENGTH, HARD_MIN_LENGTH } = require('../lib/auth');

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const CHANGE_LIMIT = 5;
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

module.exports = async (req, res) => {
  if (!(await configured())) {
    return json(res, 503, {
      error: 'This board is not configured. Set BOARD_PASSPHRASE and SESSION_SECRET.',
      configured: false,
      minLength: minLength(),
    });
  }

  if (req.method === 'GET') {
    return json(res, 200, {
      authenticated: await isAuthenticated(req),
      configured: true,
      minLength: minLength(),
    });
  }

  if (req.method === 'POST') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });

    const parsed = await readJson(req, 2048);
    if (!parsed.ok) return json(res, parsed.status, { error: parsed.error });

    if (parsed.value.action === 'change') return changePassphrase(req, res, parsed.value);
    return signIn(req, res, parsed.value);
  }

  if (req.method === 'DELETE') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};

async function signIn(req, res, body) {
  const limit = rateLimit(`login:${clientIp(req)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
    return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
  }

  if (!(await checkPassphrase(body.passphrase))) {
    // One message for every failure: a distinct "wrong passphrase" vs
    // "unconfigured" response would tell an attacker when to keep trying.
    return json(res, 401, { error: 'Wrong passphrase' });
  }

  return json(
    res,
    200,
    { authenticated: true, minLength: minLength() },
    { 'Set-Cookie': sessionCookie(issueToken(await epoch())) }
  );
}

/**
 * Changing the passphrase needs the current one, so holding a session is not
 * enough: a stolen cookie cannot be turned into permanent access. A successful
 * change bumps the epoch, which invalidates every session minted before it,
 * and this response carries a fresh cookie so the person who changed it stays
 * signed in.
 */
async function changePassphrase(req, res, body) {
  const limit = rateLimit(`change:${clientIp(req)}`, CHANGE_LIMIT, CHANGE_WINDOW_MS);
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
    return json(res, 429, { error: 'Too many changes. Wait a few minutes.' });
  }

  if (!(await checkPassphrase(body.current))) {
    return json(res, 401, { error: 'That is not the current passphrase' });
  }

  const next = typeof body.next === 'string' ? body.next : '';
  const required = minLength();
  if (next.length < required) {
    return json(res, 400, {
      error: `Use at least ${required} characters. A short PIN only has a few thousand guesses.`,
      minLength: required,
    });
  }
  if (next.length > MAX_LENGTH) {
    return json(res, 400, { error: `Use at most ${MAX_LENGTH} characters.` });
  }
  if (next === body.current) {
    return json(res, 400, { error: 'That is the same passphrase. Choose a different one.' });
  }

  const record = await setPassphrase(next);
  return json(
    res,
    200,
    { authenticated: true, changed: true, minLength: required, hardMinLength: HARD_MIN_LENGTH },
    { 'Set-Cookie': sessionCookie(issueToken(record.epoch)) }
  );
}
