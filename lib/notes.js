'use strict';

const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  title: 120,
  content: 10000,
  tags: 8,
  tag: 24,
  notes: 2000,
});

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** First meaningful line of the body, used when the author leaves the title blank. */
function deriveTitle(content) {
  const firstLine = String(content || '')
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'Untitled note';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Strip control characters except newline and tab, then cap the length.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, LIMITS.tag);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

/**
 * Validates and normalises a note payload. Returns a plain object, so the
 * caller never writes unknown keys into the store — a client cannot smuggle an
 * `author` or a `deletedAt` through the request body.
 */
function normalizeNoteInput(body) {
  const rawContent = typeof body.content === 'string' ? body.content : '';
  const content = cleanText(rawContent, LIMITS.content).trim();
  if (!content) return { ok: false, error: 'A note needs some text' };

  const title = cleanText(typeof body.title === 'string' ? body.title : '', LIMITS.title).trim();

  return {
    ok: true,
    value: {
      title: title || deriveTitle(content),
      content,
      tags: normalizeTags(body.tags),
      pinned: body.pinned === true,
    },
  };
}

function newNoteId() {
  return crypto.randomUUID();
}

/** Public shape of a note. Internal bookkeeping stays on the server. */
function toPublicNote(note) {
  return {
    id: note.id,
    // Derived on read as well as on write. Notes stored before the fix carry an
    // empty title, and 36 of the 45 notes on the live board are in that state:
    // rewriting history is not required to stop the board reading "Untitled".
    title: note.title || deriveTitle(note.content),
    content: note.content,
    tags: Array.isArray(note.tags) ? note.tags : [],
    pinned: note.pinned === true,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    author: note.author || '',
    version: Number(note.version) || 1,
  };
}

function toTrashEntry(note) {
  return {
    id: note.id,
    title: note.title,
    deletedAt: note.deletedAt,
    createdAt: note.createdAt,
  };
}

/** Drops notes that have sat in the trash past the retention window. */
function purgeExpired(notes, now = Date.now()) {
  return notes.filter((note) => {
    if (!note.deletedAt) return true;
    const deleted = Date.parse(note.deletedAt);
    return Number.isFinite(deleted) && now - deleted < TRASH_RETENTION_MS;
  });
}

module.exports = {
  LIMITS,
  TRASH_RETENTION_MS,
  deriveTitle,
  normalizeTags,
  normalizeNoteInput,
  newNoteId,
  toPublicNote,
  toTrashEntry,
  purgeExpired,
};
