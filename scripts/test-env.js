'use strict';

// Loads .env.local for local runs without adding a dependency. Vercel injects
// the same variables in the deployment, so this is a no-op there.
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const path = join(process.cwd(), '.env.local');
if (existsSync(path)) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const SESSION_SECRET = 'dev-session-secret-please-replace-me-32b';
const BOARD_PASSPHRASE = 'correct-horse-battery-staple';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || SESSION_SECRET;
process.env.BOARD_PASSPHRASE = process.env.BOARD_PASSPHRASE || BOARD_PASSPHRASE;
process.env.BOARD_BLOB_PATH = process.env.BOARD_BLOB_PATH || 'test/board.json';

module.exports = { SESSION_SECRET, BOARD_PASSPHRASE };
