# KartelKoin Notes

A private, single-board notes ledger. No framework, no build step, no third-party
requests, no analytics.

Live: https://notes.kartelkoin.xyz/

## How it works

```
browser ──passphrase──▶ /api/session ──▶ signed HttpOnly cookie
   │
   └──cookie──▶ /api/notes ──▶ Vercel Blob (one JSON document, private)
```

| Path | Purpose |
|------|---------|
| `index.html` | Markup: gate, composer, board, trash, toasts |
| `style.css` | All styling, dark "quiet ledger", responsive at 900px and 620px |
| `app.js` | Gate, editor, search/sort/tag filter, undo-able delete, export |
| `api/session.js` | Passphrase → signed session cookie; the only unauthenticated write |
| `api/notes.js` | Authenticated GET/POST/PATCH/DELETE over the board |
| `lib/session.js` | HMAC-signed cookie, origin allowlist, fixed-window rate limit |
| `lib/store.js` | Blob document, ETag-guarded writes, in-process serialisation |
| `lib/notes.js` | Input normalisation, derived titles, limits, trash retention |
| `scripts/guard.mjs` | Regression guard for defects that shipped once |
| `scripts/test-api.js` | End-to-end checks against the real handlers |
| `REVAMP.md` | Ranked revamp plan and the owner actions still open |

The board is a single JSON document in a **private** Vercel Blob. A write only
lands if the ETag it read is still current, so two writers cannot silently
overwrite each other; a lost race retries against the fresh document, and a
genuine edit conflict returns `409` with the note's current `version`.

`data/notes.json` is the old store. It stays in git history until the owner
approves the purge, and `.vercelignore` keeps it out of every deployment.

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `BOARD_PASSPHRASE` | yes | Shared board secret, 12+ characters. Rotating it invalidates nothing except future sign-ins; existing cookies stay valid until `SESSION_SECRET` changes. |
| `SESSION_SECRET` | yes | 32+ random characters. Signs the session cookie. Rotate it to sign every device out. |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob store, private. Set by the Vercel integration. |
| `ALLOWED_ORIGINS` | no | Comma-separated origin allowlist. Defaults to the host that served the request, which is what keeps preview deployments working. |
| `BOARD_BLOB_PATH` | no | Defaults to `board.json`. Tests point it at a scratch path. |

The API fails closed with `503` when `BOARD_PASSPHRASE` or `SESSION_SECRET` is
missing or too short. There is no default passphrase and no anonymous read.

## Local development

```bash
npm install
vercel env pull .env.local        # BLOB_READ_WRITE_TOKEN
printf 'BOARD_PASSPHRASE=%s\nSESSION_SECRET=%s\n' "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" >> .env.local
vercel dev
```

## Checks

```bash
node scripts/test-api.js   # 18 end-to-end checks against a scratch blob; needs the token
node scripts/guard.mjs     # regression guard; exit 1 on a new defect
```

The guard runs in CI on every pull request and every push to `main`
(`.github/workflows/guard.yml`). It is a ratchet: `scripts/guard-baseline.json`
lists the defects that exist today, so CI is green now and only new ones fail.
Shrinking that file is the progress metric. It is currently down to one entry,
the credential in the old static store.

## Security posture

- Every read and write requires a signed session cookie; anonymous writes are `401`.
- No `Access-Control-Allow-Origin` is ever emitted; cross-origin writes are refused.
- Response headers: CSP without `unsafe-inline`, nosniff, `frame-ancestors 'none'`,
  no-referrer, COOP/CORP, Permissions-Policy, HSTS, `noindex`.
- Bodies are capped at 12 KB (`413`), writes at 60/minute per IP, sign-ins at
  8 per 15 minutes, and the passphrase is compared in constant time.
- All rendering is `textContent`; there is no `innerHTML` and no HTML string
  concatenation of user data anywhere in the client.
- Deletes are soft, kept 30 days in the trash, and undoable from the toast.

## License

MIT
