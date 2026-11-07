#!/usr/bin/env node
'use strict';

// Imports the legacy board (data/notes.json, 45 notes) into the Blob store.
//
// Dry run by default: it reads the legacy file, maps every note into the shape
// the new API serves, and prints what it would write. Nothing is written until
// you pass --apply, and --apply additionally requires BOARD_BLOB_PATH to be set
// explicitly, so a stray run cannot land on the production board by accident.
//
//   node scripts/migrate-legacy.js                  # plan only
//   BOARD_BLOB_PATH=board.json node scripts/migrate-legacy.js --apply
//
// Rule: every note is carried over except ones whose body matches a credential
// pattern (a password line, a private key block). Deleting such a note from the
// new store would still leave it in git history, so the history rewrite is
// still required — this only stops it from being copied forward.

require('./test-env');

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const LEGACY = join(__dirname, '..', 'data', 'notes.json');
const APPLY = process.argv.includes('--apply');

const CREDENTIAL_PATTERNS = [
  /pass(word|phrase)\s*[:=]/i,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b\s*[/|,]\s*\S{6,}/, // email + password on one line
  // An ssh-ed25519 *public* key is not a secret, so it is not a reason to drop
  // a note. Only a private key block is.
];

function looksSensitive(note) {
  const body = `${note.title || ''}\n${note.content || ''}`;
  return CREDENTIAL_PATTERNS.some((re) => re.test(body));
}

function toNoteShape(note, index) {
  const createdAt = note.createdAt || new Date().toISOString();
  return {
    id: typeof note.id === 'string' && note.id ? note.id : `legacy-${index}`,
    // 36 of the 45 legacy notes store the literal string "Untitled" rather than
    // a blank title. Blank it so the derived title applies.
    title: /^\s*untitled\s*$/i.test(String(note.title || '')) ? '' : String(note.title || '').slice(0, 120),
    content: String(note.content || '').slice(0, 10000),
    tags: Array.isArray(note.tags) ? note.tags.slice(0, 8) : [],
    pinned: note.pinned === true,
    createdAt,
    updatedAt: note.updatedAt || createdAt,
    author: '',
    version: 1,
    deletedAt: null,
  };
}

async function main() {
  if (!existsSync(LEGACY)) {
    console.error(`no legacy store at ${LEGACY}`);
    process.exit(1);
  }

  const legacy = JSON.parse(readFileSync(LEGACY, 'utf8'));
  const notes = Array.isArray(legacy) ? legacy : [];
  const keep = [];
  const skipped = [];
  const seen = new Set();

  notes.forEach((note, index) => {
    const mapped = toNoteShape(note, index);
    if (seen.has(mapped.id)) {
      skipped.push({ id: mapped.id, reason: 'duplicate id' });
      return;
    }
    seen.add(mapped.id);
    if (looksSensitive(mapped)) {
      skipped.push({ id: mapped.id, reason: 'credential-shaped, not carried forward' });
      return;
    }
    keep.push(mapped);
  });

  console.log(`legacy notes: ${notes.length}`);
  console.log(`would import: ${keep.length}`);
  console.log(`skipped:      ${skipped.length}`);
  for (const entry of skipped) console.log(`  - ${entry.id}: ${entry.reason}`);
  const untitled = keep.filter((n) => !n.title).length;
  console.log(`blank titles (derived on read): ${untitled}`);

  if (!APPLY) {
    console.log('\ndry run — nothing written. Re-run with --apply and BOARD_BLOB_PATH set.');
    return;
  }

  if (!process.env.BOARD_BLOB_PATH) {
    console.error('\nrefusing to write: set BOARD_BLOB_PATH explicitly for an --apply run.');
    process.exit(1);
  }

  const { updateBoard } = require('../lib/store');
  const { board } = await updateBoard((draft) => {
    const existing = new Set(draft.notes.map((n) => n.id));
    for (const note of keep) if (!existing.has(note.id)) draft.notes.push(note);
    return null;
  });

  console.log(`\nwrote ${board.notes.length} note(s) to ${process.env.BOARD_BLOB_PATH} (version ${board.version})`);
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
