'use strict';

const { readBoard, updateBoard } = require('../lib/store');
const {
  normalizeNoteInput,
  newNoteId,
  toPublicNote,
  toTrashEntry,
  purgeExpired,
  LIMITS,
} = require('../lib/notes');
const {
  configured,
  isAuthenticated,
  originAllowed,
  rateLimit,
  clientIp,
  json,
  methodNotAllowed,
  readJson,
} = require('../lib/session');

const MAX_BODY_BYTES = 12 * 1024;
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60 * 1000;

function boardResponse(res, board, { notModified = false } = {}) {
  const etag = `"v${board.version}"`;
  if (notModified) {
    res.statusCode = 304;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  return json(
    res,
    200,
    {
      version: board.version,
      notes: board.notes
        .filter((note) => !note.deletedAt)
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
        })
        .map(toPublicNote),
      trash: board.notes.filter((note) => note.deletedAt).map(toTrashEntry),
      limits: LIMITS,
    },
    { ETag: etag }
  );
}

module.exports = async (req, res) => {
  if (!(await configured())) {
    return json(res, 503, { error: 'This board is not configured.' });
  }

  // Every route here is private. There is no anonymous read path: the board
  // holds whatever the owner typed, which in the old store included passwords.
  if (!(await isAuthenticated(req))) {
    return json(res, 401, { error: 'Sign in to read this board' });
  }

  if (req.method === 'GET') {
    const { board } = await readBoard();
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === `"v${board.version}"`) {
      return boardResponse(res, board, { notModified: true });
    }
    return boardResponse(res, board);
  }

  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  }

  if (!originAllowed(req)) return json(res, 403, { error: 'Origin not allowed' });

  const limit = rateLimit(`write:${clientIp(req)}`, WRITE_LIMIT, WRITE_WINDOW_MS);
  if (!limit.ok) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
    return json(res, 429, { error: 'Slow down a moment.' });
  }

  const parsed = await readJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) return json(res, parsed.status, { error: parsed.error });
  const body = parsed.value;

  try {
    if (req.method === 'POST') {
      if (body.action === 'restore') return await restoreNote(res, body);
      if (body.action === 'empty-trash') return await emptyTrash(res);
      return await createNote(res, body);
    }
    if (req.method === 'PATCH') return await updateNote(res, body);
    return await deleteNote(res, body);
  } catch (err) {
    if (err.statusCode === 409) {
      return json(res, 409, { error: 'Someone else changed the board. Reload and try again.' });
    }
    if (err.statusCode === 413) {
      return json(res, 413, { error: err.message });
    }
    console.error(`${req.method} /api/notes failed:`, err);
    return json(res, 500, { error: 'The board could not be saved' });
  }
};

async function createNote(res, body) {
  const normalised = normalizeNoteInput(body);
  if (!normalised.ok) return json(res, 400, { error: normalised.error });

  const now = new Date().toISOString();
  const note = {
    id: newNoteId(),
    ...normalised.value,
    createdAt: now,
    updatedAt: now,
    author: String(body.author || '').trim().slice(0, 40),
    version: 1,
    deletedAt: null,
  };

  const { board } = await updateBoard((draft) => {
    if (draft.notes.filter((n) => !n.deletedAt).length >= LIMITS.notes) {
      const full = new Error('Board is full');
      full.statusCode = 413;
      throw full;
    }
    draft.notes.push(note);
    return note;
  });

  return boardResponse(res, board);
}

async function updateNote(res, body) {
  if (typeof body.id !== 'string' || !body.id) {
    return json(res, 400, { error: 'Note id is required' });
  }

  let notFound = false;
  let conflict = false;
  let problem = null;

  const { board } = await updateBoard((draft) => {
    const index = draft.notes.findIndex((note) => note.id === body.id && !note.deletedAt);
    if (index === -1) {
      notFound = true;
      return false;
    }
    const existing = draft.notes[index];
    // Optimistic concurrency: if the caller edited a version that has since
    // moved, refuse instead of overwriting a newer body.
    if (body.version !== undefined && Number(body.version) !== Number(existing.version || 1)) {
      conflict = true;
      return false;
    }

    // A PATCH only needs the fields it changes. Merging first means a client
    // that sends { id, content } keeps its title and tags instead of having
    // them silently reset.
    const normalised = normalizeNoteInput({
      title: body.title === undefined ? existing.title : body.title,
      content: body.content === undefined ? existing.content : body.content,
      tags: body.tags === undefined ? existing.tags : body.tags,
      pinned: body.pinned === undefined ? existing.pinned : body.pinned,
      done: body.done === undefined ? existing.done : body.done,
    });
    if (!normalised.ok) {
      problem = normalised.error;
      return false;
    }

    draft.notes[index] = {
      ...existing,
      ...normalised.value,
      version: Number(existing.version || 1) + 1,
      updatedAt: new Date().toISOString(),
    };
    return draft.notes[index];
  });

  if (notFound) return json(res, 404, { error: 'Note not found' });
  if (conflict) {
    return json(res, 409, { error: 'This note changed while you were editing. Reload to see the latest.' });
  }
  if (problem) return json(res, 400, { error: problem });
  return boardResponse(res, board);
}

async function deleteNote(res, body) {
  if (typeof body.id !== 'string' || !body.id) {
    return json(res, 400, { error: 'Note id is required' });
  }

  let notFound = false;
  const { board } = await updateBoard((draft) => {
    const index = draft.notes.findIndex((note) => note.id === body.id && !note.deletedAt);
    if (index === -1) {
      notFound = true;
      return false;
    }
    // Soft delete: the note stays in the store for 30 days so the undo button
    // in the UI is honest, and so a misclick is not a data loss event.
    draft.notes[index] = {
      ...draft.notes[index],
      deletedAt: new Date().toISOString(),
      version: Number(draft.notes[index].version || 1) + 1,
    };
    return true;
  });

  if (notFound) return json(res, 404, { error: 'Note not found' });
  return boardResponse(res, board);
}

async function restoreNote(res, body) {
  if (typeof body.id !== 'string' || !body.id) {
    return json(res, 400, { error: 'Note id is required' });
  }
  let notFound = false;
  const { board } = await updateBoard((draft) => {
    const index = draft.notes.findIndex((note) => note.id === body.id && note.deletedAt);
    if (index === -1) {
      notFound = true;
      return false;
    }
    draft.notes[index] = {
      ...draft.notes[index],
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      version: Number(draft.notes[index].version || 1) + 1,
    };
    return true;
  });
  if (notFound) return json(res, 404, { error: 'Nothing to restore' });
  return boardResponse(res, board);
}

async function emptyTrash(res) {
  const { board } = await updateBoard((draft) => {
    const before = draft.notes.length;
    draft.notes = purgeExpired(draft.notes.filter((note) => !note.deletedAt));
    return before !== draft.notes.length;
  });
  return boardResponse(res, board);
}
