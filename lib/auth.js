'use strict';

const crypto = require('node:crypto');
const { get, put, BlobNotFoundError } = require('@vercel/blob');

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
const CACHE_MS = 60 * 1000;
const KEY_LENGTH = 64;
const DEFAULT_MIN_LENGTH = 12;
const HARD_MIN_LENGTH = 8;
const MAX_LENGTH = 256;
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

  const stored = await readAuth();
  if (stored) {
    const { hash } = await hashPassphrase(candidate, stored.salt, stored.iterations);
    return timingSafeMatch(hash, stored.hash);
  }

  const bootstrap = envPassphrase();
  if (bootstrap.length === 0) return false;
  return timingSafeMatch(candidate, bootstrap);
}

/** True when this deployment has a usable passphrase from either source. */
async function hasPassphrase() {
  if (await readAuth()) return true;
  return envPassphrase().length >= minLength();
}

/**
 * Stores a new passphrase. The epoch moves with it, and every session token
 * carries the epoch, so changing the passphrase signs out every other device
 * instead of leaving old cookies valid.
 */
async function setPassphrase(next) {
  const current = await readAuth({ fresh: true });
  const hashed = await hashPassphrase(next, crypto.randomBytes(16).toString('base64'));
  const record = {
    v: 1,
    epoch: (current ? current.epoch : 0) + 1,
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

async function epoch() {
  const stored = await readAuth();
  return stored ? stored.epoch : 0;
}

module.exports = {
  AUTH_PATH,
  DEFAULT_MIN_LENGTH,
  HARD_MIN_LENGTH,
  MAX_LENGTH,
  minLength,
  readAuth,
  verifyPassphrase,
  hasPassphrase,
  setPassphrase,
  epoch,
  clearCache,
};
