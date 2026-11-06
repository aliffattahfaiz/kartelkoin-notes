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
const {
  minLength,
  credentialKind,
  setPassphrase,
  storedKind,
  epoch,
  lockedFor,
  noteFailure,
  noteSuccess,
  MAX_LENGTH,
  HARD_MIN_LENGTH,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
} = require('../lib/auth');

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const CHANGE_LIMIT = 5;
const CHANGE_WINDOW_MS = 15 * 60 * 1000;

function policy(kind) {
  return {
    kind,
    minLength: minLength(),
    pinMinLength: PIN_MIN_LENGTH,
    pinMaxLength: PIN_MAX_LENGTH,
    hardMinLength: HARD_MIN_LENGTH,
  };
}

function retryJson(res, status, error, waitMs) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
  return json(res, status, { error, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) });
}

module.exports = async (req, res) => {
  if (!(await configured())) {
    return json(res, 503, {
      error: 'This board is not configured. Set BOARD_PASSPHRASE and SESSION_SECRET.',
      configured: false,
      ...policy('passphrase'),
    });
  }

  if (req.method === 'GET') {
    return json(res, 200, {
      authenticated: await isAuthenticated(req),
      configured: true,
      ...policy(await storedKind()),
    });
  }

  if (req.method === 'POST') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });

    const parsed = await readJson(req, 2048);
    if (!parsed.ok) return json(res, parsed.status, { error: parsed.error });

    if (parsed.value.action === 'change') return changeCredential(req, res, parsed.value);
    return signIn(req, res, parsed.value);
  }

  if (req.method === 'DELETE') {
    if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }

  return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
};

async function signIn(req, res, body) {
  // The durable lock is checked before the credential, so a client that wants
  // to keep guessing pays a Blob read and nothing else.
  const locked = await lockedFor();
  if (locked > 0) return retryJson(res, 429, 'Too many attempts. Try again shortly.', locked);

  const limit = rateLimit(`login:${clientIp(req)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
    return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
  }

  const kind = await storedKind();
  const candidate = typeof body.pin === 'string' && body.pin.length > 0 ? body.pin : body.passphrase;

  if (!(await checkPassphrase(candidate))) {
    const wait = await noteFailure();
    // One message for every failure: a distinct "wrong passphrase" vs
    // "unconfigured" response would tell an attacker when to keep trying.
    if (wait > 0) return retryJson(res, 429, 'Too many attempts. Try again shortly.', wait);
    return json(res, 401, { error: kind === 'pin' ? 'Wrong PIN' : 'Wrong passphrase' }, {});
  }

  await noteSuccess();
  return json(
    res,
    200,
    { authenticated: true, ...policy(kind) },
    { 'Set-Cookie': sessionCookie(issueToken(await epoch())) }
  );
}

/**
 * Changing the credential needs the current one, so holding a session is not
 * enough: a stolen cookie cannot be turned into permanent access. A successful
 * change bumps the epoch, which invalidates every session minted before it,
 * and this response carries a fresh cookie so the person who changed it stays
 * signed in.
 */
async function changeCredential(req, res, body) {
  const locked = await lockedFor();
  if (locked > 0) return retryJson(res, 429, 'Too many attempts. Try again shortly.', locked);

  const limit = rateLimit(`change:${clientIp(req)}`, CHANGE_LIMIT, CHANGE_WINDOW_MS);
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
    return json(res, 429, { error: 'Too many changes. Wait a few minutes.' });
  }

  if (!(await checkPassphrase(body.current))) {
    const wait = await noteFailure();
    if (wait > 0) return retryJson(res, 429, 'Too many attempts. Try again shortly.', wait);
    return json(res, 401, { error: 'That is not the current PIN or passphrase' });
  }

  const requested = body.kind === 'pin' || body.kind === 'passphrase' ? body.kind : null;
  const next = typeof body.next === 'string' ? body.next : '';
  const inferred = credentialKind(next);

  if (requested === 'pin' && !/^\d{4,12}$/.test(next)) {
    return json(res, 400, {
      error: `A PIN is ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits, numbers only.`,
      ...policy('pin'),
    });
  }
  if (requested === 'passphrase' && next.length < minLength()) {
    return json(res, 400, {
      error: `Use at least ${minLength()} characters, or switch to a PIN.`,
      ...policy('passphrase'),
    });
  }
  if (!requested && !inferred) {
    return json(res, 400, {
      error: `Use a ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digit PIN or at least ${minLength()} characters.`,
      ...policy(await storedKind()),
    });
  }
  if (next.length > MAX_LENGTH) {
    return json(res, 400, { error: `Use at most ${MAX_LENGTH} characters.` });
  }
  if (next === body.current) {
    return json(res, 400, { error: 'That is the same as the current one. Choose a different one.' });
  }

  const kind = requested || inferred;
  const record = await setPassphrase(next, kind);
  await noteSuccess();
  return json(
    res,
    200,
    { authenticated: true, changed: true, ...policy(record.kind) },
    { 'Set-Cookie': sessionCookie(issueToken(record.epoch)) }
  );
}