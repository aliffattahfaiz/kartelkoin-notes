'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubStub, createRes, createReq } = require('./helpers');

const ORIGINAL_FETCH = global.fetch;
const KEY = 'test-write-key-0123456789';
const SEED = [
  { id: 'n1', title: 'First', content: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'n2', title: 'Second', content: 'beta', createdAt: '2026-01-02T00:00:00.000Z' },
];

function loadHandler(notes, writeKey = KEY) {
  const stub = createGitHubStub(notes);
  global.fetch = stub.fetchStub;
  process.env.GITHUB_REPO = 'owner/repo';
  process.env.GITHUB_TOKEN = 'test-token';
  if (writeKey === null) delete process.env.NOTES_WRITE_KEY;
  else process.env.NOTES_WRITE_KEY = writeKey;
  delete require.cache[require.resolve('../api/notes.js')];
  return { handler: require('../api/notes.js'), stub };
}

async function call(handler, method, body, headers = {}) {
  const res = createRes();
  const base = { 'x-notes-key': KEY };
  await handler(createReq(method, body, { ...base, ...headers }), res);
  return res;
}

test.afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

test('GET returns the notes', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.notes.length, 2);
});

test('GET is refused without a key (the store is not public)', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET', undefined, { 'x-notes-key': undefined });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.notes, undefined);
});

test('GET is refused with a wrong key', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET', undefined, { 'x-notes-key': 'nope' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.notes, undefined);
});

test('GET collapses repeat reads into one upstream call', async () => {
  const { handler, stub } = loadHandler(SEED);
  let gets = 0;
  const inner = stub.fetchStub;
  global.fetch = (url, opts) => {
    if (!opts || !opts.method || opts.method === 'GET') gets += 1;
    return inner(url, opts);
  };
  await call(handler, 'GET');
  await call(handler, 'GET');
  await call(handler, 'GET');
  assert.equal(gets, 1);
});

test('GET never exposes the server token', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET');
  assert.ok(!JSON.stringify(res.body).includes('test-token'));
});

test('POST without a body returns 400, not 500', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'POST', undefined);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), /content/i);
});

test('POST rejects a non-string content field', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'x', content: { evil: true } });
  assert.equal(res.statusCode, 400);
});

test('POST commits a message that names the new note', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'New', content: 'gamma' });
  assert.equal(res.statusCode, 200);
  assert.equal(stub.state.commits.length, 1);
  assert.doesNotMatch(stub.state.commits[0], /undefined/);
  assert.match(stub.state.commits[0], new RegExp(res.body.note.id));
});

test('PATCH commits a message that names the note', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'PATCH', { id: 'n1', title: 'First', content: 'alpha2' });
  assert.equal(res.statusCode, 200);
  assert.match(stub.state.commits[0], /n1/);
  assert.doesNotMatch(stub.state.commits[0], /undefined/);
});

test('DELETE commits a message that names the note', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'DELETE', { id: 'n2' });
  assert.equal(res.statusCode, 200);
  assert.match(stub.state.commits[0], /n2/);
  assert.doesNotMatch(stub.state.commits[0], /undefined/);
});

test('PATCH of a missing note returns 404', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'PATCH', { id: 'nope', title: 'x', content: 'y' });
  assert.equal(res.statusCode, 404);
});

test('DELETE of a missing note returns 404', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'DELETE', { id: 'nope' });
  assert.equal(res.statusCode, 404);
});

test('an id with path or shell metacharacters is rejected', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'DELETE', { id: '../../data/notes.json' });
  assert.equal(res.statusCode, 400);
  assert.equal(stub.state.puts, 0);
});

test('a concurrent write (sha conflict) is retried instead of failing the save', async () => {
  const { handler, stub } = loadHandler(SEED);
  stub.state.conflictOnce = true;
  const res = await call(handler, 'POST', { title: 'Race', content: 'delta' });
  assert.equal(res.statusCode, 200);
  assert.equal(stub.state.notes[0].title, 'Race');
  assert.equal(stub.state.notes.length, 3);
});

test('content over the 10000 character limit is rejected with 400', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'big', content: 'a'.repeat(10001) });
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.error), /10000/);
  assert.equal(stub.state.puts, 0);
});

test('a body over the transport limit is rejected with 413', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'big', content: 'a'.repeat(20000) });
  assert.equal(res.statusCode, 413);
  assert.equal(stub.state.puts, 0);
});

test('writes are refused when no write key is configured (fail closed)', async () => {
  const { handler, stub } = loadHandler(SEED, null);
  const res = await call(handler, 'POST', { title: 'x', content: 'y' });
  assert.equal(res.statusCode, 503);
  assert.equal(stub.state.puts, 0);
});

test('a short write key counts as unconfigured (fail closed)', async () => {
  const { handler, stub } = loadHandler(SEED, 'short');
  const res = await call(handler, 'POST', { title: 'x', content: 'y' }, { 'x-notes-key': 'short' });
  assert.equal(res.statusCode, 503);
  assert.equal(stub.state.puts, 0);
});

test('writes are refused with a wrong key', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'x', content: 'y' }, { 'x-notes-key': 'wrong' });
  assert.equal(res.statusCode, 401);
  assert.equal(stub.state.puts, 0);
});

test('writes are refused with no key at all', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'x', content: 'y' }, { 'x-notes-key': undefined });
  assert.equal(res.statusCode, 401);
  assert.equal(stub.state.puts, 0);
});

test('writes succeed with the right key', async () => {
  const { handler, stub } = loadHandler(SEED);
  const res = await call(handler, 'POST', { title: 'x', content: 'y' });
  assert.equal(res.statusCode, 200);
  assert.equal(stub.state.puts, 1);
});

test('two notes created in the same millisecond get distinct, safe ids', async () => {
  const { handler } = loadHandler(SEED);
  const a = await call(handler, 'POST', { title: 'a', content: 'a' });
  const b = await call(handler, 'POST', { title: 'b', content: 'b' });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.notEqual(a.body.note.id, b.body.note.id);
  for (const note of [a.body.note, b.body.note]) {
    assert.match(note.id, /^[a-z0-9]{1,32}$/);
  }
});

test('CORS does not allow arbitrary origins', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET');
  assert.notEqual(res.headers['access-control-allow-origin'], '*');
});

test('a same-origin request gets its own origin echoed, not a wildcard', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'GET', undefined, { origin: 'https://notes.example', host: 'notes.example' });
  assert.equal(res.headers['access-control-allow-origin'], 'https://notes.example');
});

test('OPTIONS from a foreign origin grants no CORS header', async () => {
  const { handler } = loadHandler(SEED);
  const res = await call(handler, 'OPTIONS', undefined, { origin: 'https://evil.example' });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
