'use strict';

const { put, get, head, BlobNotFoundError, BlobPreconditionFailedError } = require('@vercel/blob');

// Overridable so tests and previews can point at a scratch document instead of
// the live board. Production never sets it.
const BOARD_PATH = process.env.BOARD_BLOB_PATH || 'board.json';
const RETRIES = 10;
const ACCESS = 'private';

const EMPTY_BOARD = Object.freeze({ version: 0, notes: [] });

function isMissing(err) {
  return err instanceof BlobNotFoundError || err?.name === 'BlobNotFoundError';
}

/**
 * `get` answers with a weak validator (`W/"abc"`) while `put` only accepts the
 * strong one. Passing the weak form as ifMatch never matches, so every save
 * would retry ten times and then report a conflict that never happened.
 */
function strongEtag(etag) {
  if (!etag) return null;
  return String(etag).replace(/^W\//, '');
}

function isPrecondition(err) {
  if (err instanceof BlobPreconditionFailedError || err?.name === 'BlobPreconditionFailedError') {
    return true;
  }
  // The SDK throws a plain Error whose `name` is "Error" for a lost ETag race,
  // so matching on the class or the name alone silently misses every conflict
  // and turns a retryable race into a 500. The service also words the same lost
  // race three different ways depending on which side moved first:
  //   "precondition failed"
  //   "the conditional request cannot succeed due to a conflicting operation
  //    against this resource"
  //   "the specified key does not exist" (the document was created or removed
  //    between our read and our write, so there was no ETag to match)
  // Every one of those is recoverable by re-reading the board and retrying.
  return /precondition|etag mismatch|conflicting operation|specified key does not exist/i.test(
    String(err?.message || '')
  );
}

async function streamToJson(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return { ...EMPTY_BOARD };
  return JSON.parse(text);
}

/**
 * One JSON document holds the whole board. That is deliberate: a note board is
 * small, and a single document is the only way to keep "read, decide, write"
 * atomic without a database. Optimistic concurrency comes from the blob ETag —
 * a write only lands if nobody else moved the board since we read it, and a
 * lost race retries against the fresh copy instead of silently dropping a note
 * (which is what the old read-sha/PUT loop did on a 409).
 *
 * Reads are eventually consistent: a `get` straight after a `put` can still
 * return the previous document, and its ETag. Chaining ifMatch off that stale
 * ETag makes two saves in quick succession fail a race that never happened.
 * So a committed write caches the board together with the ETag the write
 * returned, and the next write mutates from that. A precondition failure drops
 * the cache and goes back to the store, so cross-instance writes still see the
 * real document before deciding anything.
 */
let committed = null;

async function readBoard() {
  try {
    const result = await get(BOARD_PATH, { access: ACCESS, useCache: false });
    // The SDK resolves to null for a pathname that has never been written.
    if (!result) return { board: { ...EMPTY_BOARD }, etag: null };
    if (result.statusCode === 304) return { board: { ...EMPTY_BOARD }, etag: null };
    const board = await streamToJson(result.stream);
    return {
      board: {
        version: Number(board.version) || 0,
        notes: Array.isArray(board.notes) ? board.notes : [],
      },
      etag: strongEtag(result.blob?.etag),
    };
  } catch (err) {
    if (isMissing(err)) return { board: { ...EMPTY_BOARD }, etag: null };
    throw err;
  }
}

async function readEtag() {
  try {
    const meta = await head(BOARD_PATH);
    return strongEtag(meta.etag);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Applies `mutate` to the freshest board and commits it. `mutate` receives a
 * copy and returns the next board; throwing inside it aborts without writing.
 * Returns the value `mutate` returned in `result`, plus the committed board.
 *
 * Two saves that arrive together on the same instance would otherwise read the
 * same board, and every loser would burn its retries and hand the user a 409
 * for a write that was never in conflict. The queue serialises them so the
 * second save starts from the board the first one committed. Cross-instance
 * races are still real, and the ETag retry covers those.
 */
let queue = Promise.resolve();

function updateBoard(mutate) {
  const run = queue.then(
    () => commitBoard(mutate),
    () => commitBoard(mutate)
  );
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function commitBoard(mutate) {
  let lastError = null;

  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const current = attempt === 0 && committed ? committed : await readBoard();
    const board = current.board;
    const etag = current.etag;
    const draft = {
      version: board.version + 1,
      notes: board.notes.map((note) => ({ ...note })),
    };

    const result = mutate(draft);
    if (result === false) {
      return { board, result: null, changed: false };
    }

    const payload = JSON.stringify({ version: draft.version, notes: draft.notes });
    try {
      const written = await put(BOARD_PATH, payload, {
        access: ACCESS,
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : {}),
      });
      committed = { board: draft, etag: strongEtag(written.etag) };
      return {
        board: draft,
        result: result ?? null,
        changed: true,
        etag: strongEtag(written.etag),
      };
    } catch (err) {
      if (!isPrecondition(err)) throw err;
      lastError = err;
      committed = null;
      // Someone else wrote between our read and our write. Back off so two
      // writers do not keep colliding, then retry against the new board.
      // Exponential with jitter, because the store is read-through-cached: an
      // immediate re-read can still hand back the ETag we just lost on, and a
      // fixed 15ms step burns all ten tries inside one cache window.
      const backoff = Math.min(400, 25 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.floor(Math.random() * 25)));
    }
  }

  const conflict = new Error('Board changed too often, try again');
  conflict.statusCode = 409;
  conflict.cause = lastError;
  throw conflict;
}

module.exports = { BOARD_PATH, readBoard, readEtag, updateBoard, EMPTY_BOARD, strongEtag };
