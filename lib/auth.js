'use strict';

const crypto = require('node:crypto');
const { get, put, del, BlobNotFoundError } = require('@vercel/blob');

// The passphrase can be changed from inside the app, so it cannot live only in
// an environment variable: a serverless function cannot rewrite its own env.
// The first passphrase comes from BOARD_PASSPHRASE; once the owner changes it,
// a salted scrypt hash in a private blob is authoritative and the env value is
// ignored. Same path rule as the board: production is board-shaped, every
// other deployment is preview-shaped, so a preview change cannot lock the real
// board.
function defaultPath() {
  if (process.env.AUTH_BLOB_PATH) return process.env.AUTH_BLOB_PATH;
  if (process.env.BOARD_BLOB_PATH) return process.env.BOARD_BLOB_PATH.replace(/[^/]*$/, 'auth.json');
  return process.env.VERCEL_ENV === 'production' ? 'auth.json' : 'preview/auth.json';
}

const AUTH_PATH = defaultPath();
// Failed attempts live beside the credential, not inside it: a bootstrap
// passphrase comes from the environment and has no record to write to.
const ATTEMPTS_PATH = AUTH_PATH.replace(/[^/]*$/, 'attempts.json');
// Ordinary requests only need the epoch, which is fine to read from a short
// cache. Sign-in and passphrase changes always read the blob fresh: a stale
// record there means "my new passphrase does not work" for up to a minute, and
// it also briefly accepts tokens that a rotation was supposed to kill.
const CACHE_MS = 10 * 1000;
const KEY_LENGTH = 64;
const DEFAULT_MIN_LENGTH = 12;
const HARD_MIN_LENGTH = 8;
const MAX_LENGTH = 256;
const PIN_MIN_LENGTH = 4;
const PIN_MAX_LENGTH = 12;
// A four-digit PIN is only ten thousand guesses, so it is allowed only with a
// lockout that outlives the request. The counter is consecutive failures across
// every client and every instance, and only a successful sign-in resets it: a
// distributed attacker cannot wait it out, and each lock is capped at thirty
// minutes so the owner is never shut out for a day by someone else's guesses.
const LOCK_STEPS = [
  { after: 12, ms: 30 * 60 * 1000 },
  { after: 10, ms: 15 * 60 * 1000 },
  { after: 7, ms: 5 * 60 * 1000 },
  { after: 5, ms: 30 * 1000 },
];
const MAXLOCK_MS = 30 * 60 * 1000;
// 128 * N * r bytes of memory: N=16384, r=8 is 16 MB, under Node's default
// 32 MB scrypt cap. Higher N needs an explicit maxmem.
const ITERATIONS = 16384;
const MAXMEM = 64 * 1024 * 1024;

function minLength() {
  const fromEnv = Number(process.env.BOARD_PASSPHRASE_MIN_LENGTH);
  if (Number.isFinite(fromEnv) && fromEnv >= HARD_MIN_LENGTH) return Math.floor(fromEnv);
  return DEFAULT_MIN_LENGTH;
}

function envPassphrase() {
  return process.env.BOARD_PASSPHRASE || '';
}

/** Digits only, four to twelve: the one shape that counts as a PIN. */
function isPin(value) {
  return typeof value === 'string' && value.length >= PIN_MIN_LENGTH && value.length <= PIN_MAX_LENGTH && /^\d+$/.test(value);
}

/**
 * The credential the value would become: 'pin' or 'passphrase', or null when it
 * is too weak for either. A passphrase keeps the longer floor; a PIN trades
 * length for the durable lockout in this file.
 */
function credentialKind(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return null;
  if (isPin(value)) return 'pin';
  if (value.length >= minLength()) return 'passphrase';
  return null;
}

/** The bootstrap value is usable when it is a PIN or a full-length passphrase. */
function bootstrapValid() {
  const value = envPassphrase();
  if (value.length === 0) return false;
  return isPin(value) || value.length >= HARD_MIN_LENGTH;
}

let cache = { at: 0, value: null };

function clearCache() {
  cache = { at: 0, value: null };
}

function isMissing(err) {
  return (
    err instanceof BlobNotFoundError ||
    err?.name === 'BlobNotFoundError' ||
    /not found|does not exist/i.test(String(err?.message || ''))
  );
}

/** `{ v, epoch, salt, iterations, hash }`, or null when nobody changed it yet. */
async function readAuth({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value = null;
  try {
    const result = await get(AUTH_PATH, { access: 'private', useCache: false });
    if (result && result.statusCode !== 304) {
      const chunks = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (parsed && typeof parsed.hash === 'string' && typeof parsed.salt === 'string') {
        value = {
          v: Number(parsed.v) || 1,
          epoch: Number(parsed.epoch) || 1,
          kind: parsed.kind === 'pin' ? 'pin' : 'passphrase',
          salt: parsed.salt,
          iterations: Number(parsed.iterations) || ITERATIONS,
          hash: parsed.hash,
          updatedAt: parsed.updatedAt || null,
        };
      }
    }
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  cache = { at: Date.now(), value };
  return value;
}

function derive(passphrase, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, KEY_LENGTH, { N: iterations, r: 8, p: 1, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassphrase(passphrase, salt, iterations) {
  const key = await derive(passphrase, salt, iterations || ITERATIONS);
  return { salt, iterations: iterations || ITERATIONS, hash: key.toString('base64') };
}

function timingSafeMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Burn a comparison anyway so the timing does not report the length.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Verifies a candidate against the stored hash, or the bootstrap env value. */
async function verifyPassphrase(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_LENGTH) return false;

  const stored = await readAuth({ fresh: true });
  if (stored) {
    const { hash } = await hashPassphrase(candidate, stored.salt, stored.iterations);
    return timingSafeMatch(hash, stored.hash);
  }

  const bootstrap = envPassphrase();
  if (bootstrap.length === 0) return false;
  return timingSafeMatch(candidate, bootstrap);
}

/** True when this deployment has a usable credential from either source. */
async function hasPassphrase() {
  if (await readAuth()) return true;
  return bootstrapValid();
}

/** What the gate should ask for: 'pin' or 'passphrase'. */
async function storedKind() {
  const stored = await readAuth();
  if (stored) return stored.kind;
  return isPin(envPassphrase()) ? 'pin' : 'passphrase';
}

/**
 * Stores a new credential. The epoch moves with it, and every session token
 * carries the epoch, so changing it signs out every other device instead of
 * leaving old cookies valid.
 */
async function setPassphrase(next, kind = credentialKind(next)) {
  const current = await readAuth({ fresh: true });
  const hashed = await hashPassphrase(next, crypto.randomBytes(16).toString('base64'));
  const record = {
    v: 1,
    epoch: (current ? current.epoch : 0) + 1,
    kind: kind === 'pin' ? 'pin' : 'passphrase',
    minLength: minLength(),
    salt: hashed.salt,
    iterations: hashed.iterations,
    hash: hashed.hash,
    updatedAt: new Date().toISOString(),
  };

  await put(AUTH_PATH, JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  clearCache();
  cache = { at: Date.now(), value: record };
  return record;
}

/* ------------------------------------------------------------- lockout */

function emptyAttempts() {
  return { count: 0, lockedUntil: 0 };
}

async function readAttempts() {
  try {
    const result = await get(ATTEMPTS_PATH, { access: 'private', useCache: false });
    if (!result || result.statusCode === 304) return emptyAttempts();
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return {
      count: Math.max(0, Number(parsed.count) || 0),
      lockedUntil: Math.max(0, Number(parsed.lockedUntil) || 0),
    };
  } catch (err) {
    // Availability beats a perfect lockout: the per-IP limiter still applies,
    // and the credential itself is never accepted because a counter read failed.
    if (isMissing(err)) return emptyAttempts();
    return emptyAttempts();
  }
}

/** Milliseconds the caller must wait, or 0 when sign-in is open. */
async function lockedFor() {
  const { lockedUntil } = await readAttempts();
  const remaining = lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Records one failed attempt and returns the new lock, in milliseconds. The
 * lock is written before the response, so another instance sees it too.
 */
async function noteFailure() {
  const now = Date.now();
  const current = await readAttempts();
  const count = current.count + 1;
  const step = LOCK_STEPS.find((entry) => count >= entry.after);
  const base = Math.max(current.lockedUntil, now);
  const lockedUntil = step ? Math.min(base + step.ms, now + MAXLOCK_MS) : current.lockedUntil;
  try {
    await put(
      ATTEMPTS_PATH,
      JSON.stringify({ v: 1, count, lockedUntil, updatedAt: new Date().toISOString() }),
      {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      }
    );
  } catch {
    /* The in-process limiter is still standing; see the comment above. */
  }
  return lockedUntil > now ? lockedUntil - now : 0;
}

/** A successful sign-in is the only thing that resets the counter. */
async function noteSuccess() {
  const current = await readAttempts();
  if (current.count === 0 && current.lockedUntil === 0) return;
  try {
    await del(ATTEMPTS_PATH);
  } catch {
    /* Leaving a stale counter would only delay the next sign-in. */
  }
}

async function clearAttempts() {
  await del(ATTEMPTS_PATH).catch(() => {});
}

async function epoch() {
  const stored = await readAuth();
  return stored ? stored.epoch : 0;
}

module.exports = {
  AUTH_PATH,
  ATTEMPTS_PATH,
  DEFAULT_MIN_LENGTH,
  HARD_MIN_LENGTH,
  MAX_LENGTH,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
  minLength,
  isPin,
  credentialKind,
  readAuth,
  verifyPassphrase,
  hasPassphrase,
  storedKind,
  setPassphrase,
  lockedFor,
  noteFailure,
  noteSuccess,
  clearAttempts,
  epoch,
  clearCache,
};
