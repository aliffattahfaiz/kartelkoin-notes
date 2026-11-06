'use strict';

const crypto = require('crypto');

const GITHUB_REPO = process.env.GITHUB_REPO;
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/notes.json`;

const MAX_CONTENT = 10000;
const MAX_TITLE = 120;
const MAX_BODY_BYTES = 16384;
const MAX_NOTES = 5000;
const MAX_RETRIES = 3;
const WRITE_WINDOW_MS = 60000;
const WRITE_LIMIT = 20;
const READ_WINDOW_MS = 60000;
const READ_LIMIT = 120;
// Collapses polling from several tabs into one GitHub call per window.
const READ_CACHE_MS = 5000;

let readCache = { at: 0, notes: null };
const writeHits = new Map();
const readHits = new Map();

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kartelkoin-notes',
    ...extra,
  };
}

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin, X-Notes-Key');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function configuredKey() {
  const key = process.env.NOTES_WRITE_KEY;
  return typeof key === 'string' && key.length >= 16 ? key : null;
}

// Fail closed: a deployment without a key refuses every request instead of
// serving the store to the internet.
function checkAuth(req) {
  const expected = configuredKey();
  if (!expected) {
    return { status: 503, error: 'This deployment is not configured' };
  }
  const supplied = req.headers['x-notes-key'];
  if (!safeEqual(supplied, expected)) {
    return { status: 401, error: 'Unauthorised' };
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function throttle(map, req, windowMs, limit) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.start > windowMs) {
    map.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (map.size > 10000) map.clear();
  return entry.count > limit;
}

function asText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

function validateNote(title, content) {
  const cleanContent = asText(content, MAX_CONTENT);
  if (!cleanContent) {
    return { valid: false, error: 'Content is required and must be 10000 characters or less' };
  }
  const rawTitle = title === undefined || title === null ? '' : asText(title, MAX_TITLE);
  if (rawTitle === null) {
    return { valid: false, error: 'Title must be 120 characters or less' };
  }
  return { valid: true, title: rawTitle || 'Untitled', content: cleanContent };
}

function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9]{1,32}$/.test(id);
}

// Sortable, collision-resistant, and inside the id charset above.
function newId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

async function readNotes() {
  const response = await fetch(GH_API, { headers: ghHeaders() });
  if (!response.ok) {
    throw new Error(`Failed to fetch notes: ${response.status}`);
  }
  const meta = await response.json();
  const decoded = Buffer.from(meta.content, 'base64').toString('utf8');
  const notes = JSON.parse(decoded);
  return { notes: Array.isArray(notes) ? notes : [], sha: meta.sha };
}

// Read-modify-write with retry. The old version committed once, so a
// concurrent edit (GitHub answers 409 on a stale sha) surfaced as a 500.
async function mutateNotes(mutator, commitMessage) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { notes, sha } = await readNotes();
    const result = mutator(notes);
    if (notes.length > MAX_NOTES) {
      throw Object.assign(new Error('Note limit reached'), { statusCode: 507 });
    }

    const putRes = await fetch(GH_API, {
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(JSON.stringify(notes, null, 2)).toString('base64'),
        sha,
      }),
    });

    if (putRes.ok) {
      readCache = { at: 0, notes: null };
      return result;
    }

    if (putRes.status === 409 || putRes.status === 422) {
      lastError = new Error(`Concurrent write (${putRes.status})`);
      continue;
    }

    const detail = await putRes.text();
    throw new Error(`Failed to write notes: ${putRes.status} ${detail.slice(0, 200)}`);
  }
  throw Object.assign(lastError || new Error('Failed to write notes'), { statusCode: 409 });
}

function bodyTooLarge(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return true;
  if (req.body === undefined || req.body === null) return false;
  try {
    return Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_BODY_BYTES;
  } catch (err) {
    return true;
  }
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && origin === `https://${host}`) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Notes-Key');
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const denied = checkAuth(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });

  if (req.method === 'GET') {
    if (throttle(readHits, req, READ_WINDOW_MS, READ_LIMIT)) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    const fresh = readCache.notes && Date.now() - readCache.at < READ_CACHE_MS;
    if (fresh) {
      return res.status(200).json({ notes: readCache.notes });
    }
    try {
      const { notes } = await readNotes();
      readCache = { at: Date.now(), notes };
      return res.status(200).json({ notes });
    } catch (err) {
      console.error('GET /api/notes error:', err.message);
      if (readCache.notes) return res.status(200).json({ notes: readCache.notes, stale: true });
      return res.status(502).json({ error: 'Failed to load notes' });
    }
  }

  if (throttle(writeHits, req, WRITE_WINDOW_MS, WRITE_LIMIT)) {
    return res.status(429).json({ error: 'Too many writes. Try again in a minute.' });
  }

  if (bodyTooLarge(req)) {
    return res.status(413).json({ error: 'Request too large' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (req.method === 'POST') {
    try {
      const validation = validateNote(body.title, body.content);
      if (!validation.valid) return res.status(400).json({ error: validation.error });

      const newNote = {
        id: newId(),
        title: validation.title,
        content: validation.content,
        createdAt: new Date().toISOString(),
      };

      await mutateNotes((notes) => {
        notes.unshift(newNote);
        return newNote;
      }, `Add note ${newNote.id}`);

      return res.status(200).json({ ok: true, note: newNote });
    } catch (err) {
      console.error('POST /api/notes error:', err.message);
      if (err.statusCode) return res.status(err.statusCode).json({ error: 'Note store is busy, retry' });
      return res.status(500).json({ error: 'Failed to save note' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      if (!isValidId(body.id)) return res.status(400).json({ error: 'Note id is required' });
      const validation = validateNote(body.title, body.content);
      if (!validation.valid) return res.status(400).json({ error: validation.error });

      const updated = await mutateNotes((notes) => {
        const idx = notes.findIndex((n) => n.id === body.id);
        if (idx === -1) throw Object.assign(new Error('Note not found'), { statusCode: 404 });
        notes[idx] = {
          ...notes[idx],
          title: validation.title,
          content: validation.content,
          updatedAt: new Date().toISOString(),
        };
        return notes[idx];
      }, `Edit note ${body.id}`);

      return res.status(200).json({ ok: true, note: updated });
    } catch (err) {
      console.error('PATCH /api/notes error:', err.message);
      if (err.statusCode === 404) return res.status(404).json({ error: 'Note not found' });
      if (err.statusCode === 409) return res.status(409).json({ error: 'Note store is busy, retry' });
      return res.status(500).json({ error: 'Failed to edit note' });
    }
  }

  try {
    if (!isValidId(body.id)) return res.status(400).json({ error: 'Note id is required' });

    await mutateNotes((notes) => {
      const idx = notes.findIndex((n) => n.id === body.id);
      if (idx === -1) throw Object.assign(new Error('Note not found'), { statusCode: 404 });
      notes.splice(idx, 1);
      return true;
    }, `Delete note ${body.id}`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/notes error:', err.message);
    if (err.statusCode === 404) return res.status(404).json({ error: 'Note not found' });
    if (err.statusCode === 409) return res.status(409).json({ error: 'Note store is busy, retry' });
    return res.status(500).json({ error: 'Failed to delete note' });
  }
};
