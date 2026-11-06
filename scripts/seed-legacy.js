'use strict';

// One-off migration: copies the old committed store (data/notes.json) into the
// private blob the app now reads. Run it once, with the production blob token:
//
//   vercel env pull .env.local
//   node scripts/seed-legacy.js                 # prints what it would do
//   node scripts/seed-legacy.js --apply         # writes board.json
//
// It refuses to touch a board that already has notes, so a second run cannot
// duplicate anything. Titles that were literally "Untitled" are replaced with
// the first line of the note, which is what the old board rendered as 36 cards
// with no name.

require('./test-env');

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { put } = require('@vercel/blob');

const LEGACY = join(__dirname, '..', 'data', 'notes.json');
const TARGET = process.env.SEED_BLOB_PATH || 'board.json';
const apply = process.argv.includes('--apply');

function deriveTitle(content) {
  const firstLine = String(content || '')
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'Untitled note';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

function titleOf(note) {
  const title = String(note.title || '').trim();
  if (!title || title.toLowerCase() === 'untitled') return deriveTitle(note.content);
  return title.slice(0, 120);
}

function convert(note, index) {
  const createdAt = note.createdAt || new Date().toISOString();
  return {
    id: String(note.id || `legacy-${index}`),
    title: titleOf(note),
    content: String(note.content || ''),
    tags: [],
    pinned: false,
    author: '',
    createdAt,
    updatedAt: note.updatedAt || createdAt,
    version: 1,
    deletedAt: null,
  };
}

async function main() {
  const legacy = JSON.parse(readFileSync(LEGACY, 'utf8'));
  if (!Array.isArray(legacy)) throw new Error('data/notes.json is not an array');

  const notes = legacy
    .filter((note) => note && typeof note.content === 'string' && note.content.trim())
    .map(convert);

  const ids = new Set();
  for (const note of notes) {
    if (ids.has(note.id)) note.id = `${note.id}-${ids.size}`;
    ids.add(note.id);
  }

  console.log(`legacy notes: ${legacy.length}`);
  console.log(`importable:   ${notes.length} (empty notes skipped)`);
  console.log(`target blob:  ${TARGET}`);
  console.log(`renamed:      ${notes.filter((n, i) => n.title !== (legacy[i]?.title || '')).length}`);

  if (!apply) {
    console.log('\ndry run — pass --apply to write');
    return;
  }

  const payload = JSON.stringify({ version: 1, notes });
  const written = await put(TARGET, payload, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  console.log(`\nwrote ${payload.length} bytes to ${written.pathname} (etag ${written.etag})`);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
