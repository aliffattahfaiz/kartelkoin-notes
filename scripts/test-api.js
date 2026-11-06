'use strict';

// End-to-end checks against the real handlers, using a scratch blob path.
// Run with: node scripts/test-api.js
// Requires BLOB_READ_WRITE_TOKEN (pulled from the project) and network access.

require('./test-env');

const assert = require('node:assert/strict');
const notesHandler = require('../api/notes');
const sessionHandler = require('../api/session');
const { del } = require('@vercel/blob');

const BOARD_PATH = process.env.BOARD_BLOB_PATH;

function makeReq({ method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
  req[Symbol.asyncIterator] = async function* iterate() {
    if (payload) yield Buffer.from(payload);
  };
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: undefined,
    ended: false,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    getHeader(key) {
      return this.headers[key.toLowerCase()];
    },
    end(chunk) {
      this.ended = true;
      if (chunk !== undefined) {
        try {
          this.payload = JSON.parse(String(chunk));
        } catch {
          this.payload = String(chunk);
        }
      }
      return this;
    },
    get json() {
      return this.payload;
    },
  };
  return res;
}

async function call(handler, options) {
  const res = makeRes();
  await handler(makeReq(options), res);
  return res;
}

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}

const cookie = () => ({ cookie: `kk_session=${token}` });
let token = '';

check('session status reports unauthenticated', async () => {
  const res = await call(sessionHandler, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.authenticated, false);
});

check('notes are not readable without a session', async () => {
  const res = await call(notesHandler, { method: 'GET' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json.notes, undefined);
});

check('writes are refused without a session', async () => {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const res = await call(notesHandler, { method, body: { title: 'x', content: 'y', id: 'x' } });
    assert.equal(res.statusCode, 401, `${method} must be 401`);
  }
});

check('wrong passphrase is rejected', async () => {
  const res = await call(sessionHandler, { method: 'POST', body: { passphrase: 'nope' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.getHeader('set-cookie'), undefined);
});

check('correct passphrase issues an HttpOnly, Secure, SameSite cookie', async () => {
  const res = await call(sessionHandler, {
    method: 'POST',
    body: { passphrase: process.env.BOARD_PASSPHRASE },
  });
  assert.equal(res.statusCode, 200);
  const setCookie = res.getHeader('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Domain=/);
  token = /kk_session=([^;]+)/.exec(setCookie)[1];
  assert.ok(token.length > 20);
});

check('a forged cookie is rejected', async () => {
  const res = await call(notesHandler, {
    method: 'GET',
    headers: { cookie: 'kk_session=eyJzaWQiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5fQ.deadbeef' },
  });
  assert.equal(res.statusCode, 401);
});

check('an expired token is rejected', async () => {
  const { issueToken, verifyToken } = require('../lib/session');
  const real = Date.now;
  const past = Math.floor(real() / 1000) - 60 * 60 * 24 * 400;
  Date.now = () => past * 1000;
  const oldToken = issueToken();
  Date.now = real;
  assert.equal(verifyToken(oldToken), false);
});

check('OPTIONS is not answered with a wildcard origin', async () => {
  const res = await call(notesHandler, { method: 'OPTIONS' });
  assert.notEqual(res.getHeader('access-control-allow-origin'), '*');
  assert.equal(res.getHeader('access-control-allow-origin'), undefined);
});

check('a cross-origin write is refused', async () => {
  const res = await call(notesHandler, {
    method: 'POST',
    body: { title: 'x', content: 'y' },
    headers: { ...cookie(), origin: 'https://evil.example' },
  });
  assert.equal(res.statusCode, 403);
});

check('an oversized body is 413, not 429', async () => {
  const res = await call(notesHandler, {
    method: 'POST',
    body: { content: 'a'.repeat(20000) },
    headers: cookie(),
  });
  assert.equal(res.statusCode, 413);
});

check('a blank note is rejected', async () => {
  const res = await call(notesHandler, {
    method: 'POST',
    body: { title: 'empty', content: '   ' },
    headers: cookie(),
  });
  assert.equal(res.statusCode, 400);
});

let createdId = '';

check('a note can be created, with a derived title and uuid id', async () => {
  const res = await call(notesHandler, {
    method: 'POST',
    body: { title: '', content: 'First line of the note\nsecond line', tags: ['Infra', 'keys', 'keys'] },
    headers: cookie(),
  });
  assert.equal(res.statusCode, 200);
  const note = res.json.notes.find((n) => n.content.startsWith('First line'));
  assert.ok(note, 'the new note is in the returned board');
  assert.equal(note.title, 'First line of the note');
  assert.deepEqual(note.tags, ['infra', 'keys']);
  assert.match(note.id, /^[0-9a-f-]{36}$/);
  assert.equal(note.version, 1);
  createdId = note.id;
  assert.ok(res.getHeader('etag'));
});

check('the board is sorted and carries no internal fields', async () => {
  const res = await call(notesHandler, { method: 'GET', headers: cookie() });
  assert.equal(res.statusCode, 200);
  const note = res.json.notes.find((n) => n.id === createdId);
  assert.deepEqual(Object.keys(note).sort(), [
    'author', 'content', 'createdAt', 'id', 'pinned', 'tags', 'title', 'updatedAt', 'version',
  ]);
  assert.equal(note.deletedAt, undefined);
});

check('a stale version is a 409, a matching one succeeds', async () => {
  const stale = await call(notesHandler, {
    method: 'PATCH',
    body: { id: createdId, title: 'Changed', content: 'Changed body', version: 99 },
    headers: cookie(),
  });
  assert.equal(stale.statusCode, 409);

  const ok = await call(notesHandler, {
    method: 'PATCH',
    body: { id: createdId, title: 'Changed', content: 'Changed body', version: 1 },
    headers: cookie(),
  });
  assert.equal(ok.statusCode, 200);
  const note = ok.json.notes.find((n) => n.id === createdId);
  assert.equal(note.title, 'Changed');
  assert.equal(note.version, 2);
});

check('delete is a soft delete that can be undone', async () => {
  const removed = await call(notesHandler, {
    method: 'DELETE',
    body: { id: createdId },
    headers: cookie(),
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json.notes.some((n) => n.id === createdId), false);
  assert.equal(removed.json.trash.some((n) => n.id === createdId), true);

  const restored = await call(notesHandler, {
    method: 'POST',
    body: { action: 'restore', id: createdId },
    headers: cookie(),
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json.notes.some((n) => n.id === createdId), true);
});

check('unknown ids are 404, unsupported methods are 405', async () => {
  const missing = await call(notesHandler, {
    method: 'PATCH',
    body: { id: 'nope', title: 'x', content: 'y' },
    headers: cookie(),
  });
  assert.equal(missing.statusCode, 404);

  const method = await call(notesHandler, { method: 'PUT', headers: cookie() });
  assert.equal(method.statusCode, 405);
  assert.match(method.getHeader('allow'), /GET/);
});

check('control characters are stripped from stored text', async () => {
  const res = await call(notesHandler, {
    method: 'POST',
    body: { title: 'bell\u0007', content: 'text\u0000with\u0007control' },
    headers: cookie(),
  });
  const note = res.json.notes.find((n) => n.content.startsWith('text'));
  assert.equal(note.content, 'textwithcontrol');
});

check('concurrent writes do not lose notes', async () => {
  const before = (await call(notesHandler, { method: 'GET', headers: cookie() })).json.notes.length;
  const writers = Array.from({ length: 6 }, (_, index) =>
    call(notesHandler, {
      method: 'POST',
      body: { title: `race ${index}`, content: `race body ${index}` },
      headers: cookie(),
    })
  );
  const responses = await Promise.all(writers);
  for (const res of responses) assert.equal(res.statusCode, 200);

  const after = (await call(notesHandler, { method: 'GET', headers: cookie() })).json.notes;
  assert.equal(after.length, before + 6, 'every concurrent note survived');
});

(async () => {
  // Reset the scratch document *before* the run, not after it. A failed store
  // write can still be retrying when the process tries to clean up, and the
  // retry then recreates the document with every note the run added — which
  // quietly poisons the next run instead of this one.
  if (BOARD_PATH && BOARD_PATH.startsWith('test/')) {
    await del(BOARD_PATH).catch(() => {});
  }

  let failed = 0;
  for (const { name, fn } of results) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}`);
      console.log(`     ${err.message}`);
    }
  }

  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
