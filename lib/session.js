'use strict';

const crypto = require('node:crypto');
const auth = require('./auth');

const COOKIE_NAME = 'kk_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * The board is protected by one shared passphrase, so there are no user
 * accounts. What we can do without an identity provider is prove that the
 * caller knows the passphrase, and bind that proof to a signed, HttpOnly
 * cookie so the passphrase itself is never stored in the browser.
 *
 * SESSION_SECRET signs the cookie and must be set in the environment; we fail
 * closed without it. The passphrase itself is either the bootstrap
 * BOARD_PASSPHRASE or the hash the owner set from inside the app (see auth.js),
 * and the token carries the passphrase epoch so rotating it signs every other
 * device out.
 */
function secret() {
  return process.env.SESSION_SECRET || '';
}

async function configured() {
  if (secret().length < 32) return false;
  return auth.hasPassphrase();
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** Constant-time comparison that tolerates unequal lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still burn a comparison so the timing does not leak the length.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function issueToken(epoch = 0) {
  const body = base64url(
    JSON.stringify({
      sid: crypto.randomUUID(),
      e: Number(epoch) || 0,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    })
  );
  return `${body}.${sign(body)}`;
}

function verifyToken(token, epoch = 0) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(body))) return false;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return false;
    // A token minted before the passphrase changed is no longer valid, even
    // though its signature still checks out.
    return (Number(claims.e) || 0) === (Number(epoch) || 0);
  } catch {
    return false;
  }
}

function checkPassphrase(candidate) {
  return auth.verifyPassphrase(candidate);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionCookie(token, { clear = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    clear ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  return parts.join('; ');
}

async function isAuthenticated(req) {
  if (secret().length < 32) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;
  return verifyToken(token, await auth.epoch());
}

/**
 * Cookie auth plus an Origin check on every mutating request. SameSite=Strict
 * already blocks cross-site sends in modern browsers; the Origin check is the
 * second lock, and it also covers clients that ignore SameSite.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl do not send it
  const allowed = new Set(
    String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  if (allowed.size === 0) {
    // Fall back to "whatever host served this request", which cannot be forged
    // by a browser but keeps preview deployments working.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return Boolean(host) && new URL(origin).host === host;
  }
  return allowed.has(origin);
}

/**
 * Fixed-window limiter. Serverless instances do not share memory, so this is
 * best effort per instance, not a durable quota. It exists to make passphrase
 * guessing and write floods expensive; the durable control is the Blob store's
 * own limits plus Vercel's edge.
 */
const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, resetAt: now + windowMs };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }
  return { ok: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

/** Test hook: the limiter is process memory, so a suite must be able to clear it. */
function resetRateLimits() {
  buckets.clear();
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function json(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  return json(res, 405, { error: 'Method not allowed' });
}

/** Reads the JSON body with a hard byte cap, so an oversized POST is 413. */
async function readJson(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  let body = req.body;
  if (body === undefined || body === null || typeof body !== 'object') {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return { ok: true, value: {} };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return { ok: false, status: 400, error: 'Body must be valid JSON' };
    }
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Body must be a JSON object' };
  }
  if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) {
    return { ok: false, status: 413, error: 'Request body is too large' };
  }
  return { ok: true, value: body };
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  configured,
  checkPassphrase,
  issueToken,
  verifyToken,
  sessionCookie,
  isAuthenticated,
  originAllowed,
  rateLimit,
  resetRateLimits,
  clientIp,
  json,
  methodNotAllowed,
  readJson,
};
