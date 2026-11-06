#!/usr/bin/env node
'use strict';

// Removes notes that match a set of secret patterns. Prints what it would
// remove and changes nothing unless --apply is passed.
//
//   node scripts/scrub-notes.js                # dry run
//   node scripts/scrub-notes.js --apply        # rewrite data/notes.json
//
// Rewriting the file does not remove the content from git history. Treat any
// credential found this way as already compromised and rotate it.

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'notes.json');
const apply = process.argv.includes('--apply');

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'github token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'password line', re: /\bpassword\s*[:=]\s*\S{4,}/i },
  { name: 'seed phrase', re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/ },
];

const notes = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const flagged = [];

for (const note of notes) {
  const hits = PATTERNS.filter((p) => p.re.test(note.content || '')).map((p) => p.name);
  if (hits.length) {
    flagged.push({ id: note.id, title: note.title, hits, bytes: (note.content || '').length });
  }
}

if (!flagged.length) {
  console.log('No credential-shaped notes found.');
  process.exit(0);
}

console.log(`${flagged.length} of ${notes.length} notes match a secret pattern:`);
for (const f of flagged) {
  console.log(`  ${f.id}  ${f.title}  [${f.hits.join(', ')}]  ${f.bytes}B`);
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to remove these notes.');
  console.log('Rotate the credentials first: git history still contains them.');
  process.exit(0);
}

const ids = new Set(flagged.map((f) => f.id));
const kept = notes.filter((n) => !ids.has(n.id));
fs.writeFileSync(FILE, `${JSON.stringify(kept, null, 2)}\n`);
console.log(`\nRemoved ${notes.length - kept.length} notes. ${kept.length} remain.`);
console.log('Next: rotate every credential that appeared, then purge history.');
