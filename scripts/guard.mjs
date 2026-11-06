#!/usr/bin/env node
// Regression guard for kartelkoin-notes.
//
// Every check below maps to a defect that already shipped to production once.
// The guard is a ratchet: the current defects are recorded in
// scripts/guard-baseline.json, so the build stays green today, and any *new*
// instance fails the PR. When you fix one, delete its baseline entry.
//
//   node scripts/guard.mjs            # compare against baseline, exit 1 on new findings
//   node scripts/guard.mjs --update   # rewrite the baseline from the current tree
//   node scripts/guard.mjs --list     # print every finding, ignore the baseline

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts/guard-baseline.json');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'prototypes', 'scripts']);
const TEXT_EXT = new Set(['.js', '.mjs', '.html', '.css', '.json']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(entry.slice(entry.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const read = (f) => readFileSync(f, 'utf8');
const rel = (f) => relative(ROOT, f);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const findings = [];
const add = (id, file, line, message, fix, detail = '') =>
  findings.push({ id, file: rel(file), line, message, fix, detail });

// --- G1: wildcard CORS on an API surface -------------------------------
// Shipped: OPTIONS returned ACAO:* with every method allowed, so any origin
// could read and mutate the board.
for (const f of files.filter((f) => /(^|\/)(api|vercel\.json)/.test(rel(f)) && /\.(js|json)$/.test(f))) {
  const text = read(f);
  const re = /Access-Control-Allow-Origin[^\n]*\*/g;
  for (const m of text.matchAll(re)) {
    add('wildcard-cors', f, lineOf(text, m.index), 'Access-Control-Allow-Origin is *',
      'Allow only the app origin from an env var, and never on credentialed routes.');
  }
}

// --- G2: write handler with no caller authentication -------------------
// Shipped: anonymous POST and DELETE returned 200 {"ok":true}.
for (const f of files.filter((f) => /^api\/.*\.js$/.test(rel(f)))) {
  const text = read(f);
  const writes = /req\.method\s*===?\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(text);
  // Must read the *caller's* credentials, not an outbound service token.
  const hasAuth = /req\.headers(\.authorization|\[['"]authorization['"]\]|\.cookie|\[['"]cookie['"]\]|\.?\[['"]x-api-key['"]\]|\.?\[['"]x-notes-key['"]\])|req\.cookies|getServerSession|verifyToken|requireAuth|requireSession|checkAuth\s*\(/.test(text);
  if (writes && !hasAuth) {
    add('unauth-write', f, 1, 'handler accepts POST/PATCH/DELETE with no auth check',
      'Verify a session or signed token before mutating, and return 401 otherwise.');
  }
}

// --- G3: security headers missing from the deploy config ---------------
// Shipped: no CSP, nosniff, frame-ancestors or referrer policy.
const requiredHeaders = [
  ['content-security-policy', 'CSP'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'Referrer-Policy'],
];
const vercelPath = join(ROOT, 'vercel.json');
if (existsSync(vercelPath)) {
  const text = read(vercelPath).toLowerCase();
  for (const [key, label] of requiredHeaders) {
    if (!text.includes(key)) {
      add('missing-header', vercelPath, 1, `${label} header is not set`,
        `Add ${key} to the global headers block in vercel.json.`);
    }
  }
  if (!/frame-ancestors/.test(text) && !/x-frame-options/.test(text)) {
    add('missing-header', vercelPath, 1, 'no frame-ancestors / X-Frame-Options',
      'Add frame-ancestors \'none\' to the CSP.');
  }
}

// --- G4: .hidden used in markup but never defined in CSS ----------------
// Shipped: "Loading notes…" stayed on screen forever at 6,408px.
{
  const html = files.filter((f) => f.endsWith('.html')).map(read).join('\n');
  const css = files.filter((f) => f.endsWith('.css')).map(read).join('\n');
  if (/class="[^"]*\bhidden\b/.test(html) && !/\.hidden\s*[,{]/.test(css)) {
    const first = files.find((f) => f.endsWith('.html'));
    add('hidden-undefined', first, 1, '.hidden is used in HTML but has no CSS rule',
      'Add .hidden { display: none !important; } to the stylesheet.');
  }
}

// --- G5: success messages routed through the error channel -------------
// Shipped: "Saved ✓" rendered in the red error banner.
for (const f of files.filter((f) => f.endsWith('.js') && !rel(f).startsWith('api/'))) {
  const text = read(f);
  const m = /function\s+toast\s*\([^)]*\)\s*\{([^}]*)\}/.exec(text);
  if (m && /showError\s*\(/.test(m[1])) {
    add('toast-is-error', f, lineOf(text, m.index), 'toast() delegates to showError()',
      'Give success its own element and colour; keep showError for failures.');
  }
}

// --- G6: third-party asset without an integrity hash -------------------
// Shipped: Google Fonts stylesheet loaded with no SRI and no CSP.
for (const f of files.filter((f) => f.endsWith('.html'))) {
  const text = read(f);
  const tagRe = /<(script|link)\b[^>]*?(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g;
  for (const m of text.matchAll(tagRe)) {
    if (!/\bintegrity=/.test(m[0])) {
      add('cdn-no-sri', f, lineOf(text, m.index), `third-party asset without integrity: ${m[2]}`,
        'Self-host the asset, or add integrity + crossorigin, or allow it in the CSP.');
    }
  }
}

// --- G7: public note data reachable as a static file -------------------
// Shipped: /data/notes.json served 25 notes with a cache HIT.
// data/ may stay in the repo as the store, as long as the deploy excludes it.
const ignored = existsSync(join(ROOT, '.vercelignore'))
  ? read(join(ROOT, '.vercelignore')).split('\n').map((l) => l.trim())
  : [];
const dataExcluded = ignored.some((l) => l === 'data/' || l === 'data' || l === '/data/');
if (existsSync(join(ROOT, 'data')) && !dataExcluded) {
  const dataFiles = files.filter((f) => rel(f).startsWith('data/'));
  if (dataFiles.length) {
    add('static-data', dataFiles[0], 1, `${dataFiles.length} file(s) under data/ are publicly served`,
      'Move the store behind the API (KV/Postgres/Blob) and delete data/*.json from the deploy.');
  }
}

// --- G8: credential-shaped content in the public note store ------------
// Shipped: a third-party email + password sat in a public note. Note that an
// ssh-ed25519 *public* key is not a secret — those notes are fine — so this
// only flags material that is actually sensitive.
{
  const store = join(ROOT, 'data/notes.json');
  if (existsSync(store)) {
    const notes = JSON.parse(read(store));
    const patterns = [
      [/password\s*[:=]\s*\S|passwd\s*[:=]\s*\S/i, 'password value'],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
      [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
      [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
      [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
    ];
    for (const note of notes) {
      const blob = `${note.title || ''}\n${note.content || ''}`;
      for (const [re, label] of patterns) {
        if (re.test(blob)) {
          add('credential-content', store, 1,
            `note ${note.id} contains a ${label}`,
            'Purge the note, rotate the credential, and rewrite history.',
            String(note.id));
          break;
        }
      }
    }
  }
}

// --- report -----------------------------------------------------------
const key = (x) => `${x.id} ${x.file}${x.detail ? ` ${x.detail}` : ''}`;
const dedupe = (list) => {
  const seen = new Map();
  for (const x of list) if (!seen.has(key(x))) seen.set(key(x), x);
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
};

const all = dedupe(findings);
const args = new Set(process.argv.slice(2));

if (args.has('--list')) {
  for (const x of all) console.log(`  ${x.id.padEnd(16)} ${x.file}:${x.line}  ${x.message}`);
  console.log(`\n${all.length} finding(s).`);
  process.exit(0);
}

if (args.has('--update')) {
  writeFileSync(BASELINE, JSON.stringify(all.map(({ id, file, message, detail }) => ({ id, file, message, detail })), null, 2) + '\n');
  console.log(`Baseline written with ${all.length} finding(s).`);
  process.exit(0);
}

const baseline = existsSync(BASELINE)
  ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).map((x) => `${x.id} ${x.file}${x.detail ? ` ${x.detail}` : ''}`))
  : new Set();

const fresh = all.filter((x) => !baseline.has(key(x)));
const fixed = [...baseline].filter((k) => !all.some((x) => key(x) === k));

for (const x of all) {
  const mark = baseline.has(key(x)) ? 'known ' : 'NEW   ';
  console.log(`${mark} ${x.id.padEnd(16)} ${x.file}:${x.line}  ${x.message}`);
}

if (fixed.length) {
  console.log(`\n${fixed.length} baseline entr${fixed.length === 1 ? 'y' : 'ies'} no longer reproduce — drop them with --update:`);
  for (const k of fixed) console.log(`  ${k}`);
}

if (fresh.length) {
  console.error(`\nFAIL: ${fresh.length} new regression(s).`);
  for (const x of fresh) console.error(`  ${x.id} ${x.file}:${x.line} — ${x.fix}`);
  process.exit(1);
}

console.log(`\nOK: ${all.length} known finding(s), 0 new${fixed.length ? `, ${fixed.length} fixed` : ''}.`);
