# KartelKoin Notes

A private, single-board notes ledger. No framework, no build step, no third-party
requests, no analytics.

Live: https://notes.kartelkoin.xyz/

## How it works

```
browser ──PIN or passphrase──▶ /api/session ──▶ signed HttpOnly cookie
   │
   └──cookie──▶ /api/notes ──▶ Vercel Blob (one JSON document, private)
```

| Path | Purpose |
|------|---------|
| `index.html` | Markup: gate, ledger, editor sheet, trash, one toast region |
| `style.css` | All styling, dark "quiet ledger", responsive at 820px |
| `app.js` | Segmented gate, ledger, editor sheet, search/sort/tag filter, done state, delete confirm, export |
| `toast-queue.js` | One notice at a time, with a "+N" counter for a burst |
| `api/session.js` | PIN or passphrase → signed session cookie, and the in-app credential change |
| `api/notes.js` | Authenticated GET/POST/PATCH/DELETE over the board |
| `lib/session.js` | HMAC-signed cookie, origin allowlist, fixed-window rate limit |
| `lib/auth.js` | scrypt hash, credential kind, epoch, durable lockout |
| `lib/store.js` | Blob document, ETag-guarded writes, in-process serialisation |
| `lib/notes.js` | Input normalisation, derived titles, limits, trash retention |
| `scripts/guard.mjs` | Regression guard for defects that shipped once |
| `scripts/test-api.js` | End-to-end checks against the real handlers |
| `scripts/test-toast.js` | Queue behaviour without a DOM |
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
| `BOARD_PASSPHRASE` | bootstrap | First credential: a 4-12 digit PIN, or a passphrase of 8+ characters. Once someone changes it in the app, the stored hash takes over and this value is ignored. |
| `BOARD_PASSPHRASE_MIN_LENGTH` | no | Passphrase floor. Defaults to 12, never below 8. A PIN is validated by its own 4-12 digit rule. |
| `SESSION_SECRET` | yes | 32+ random characters. Signs the session cookie. Rotate it to sign every device out. |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob store, private. Set by the Vercel integration. |
| `ALLOWED_ORIGINS` | no | Comma-separated origin allowlist. Defaults to the host that served the request, which is what keeps preview deployments working. |
| `BOARD_BLOB_PATH` | no | Defaults to `board.json`. Tests point it at a scratch path. |

The API fails closed with `503` when `SESSION_SECRET` is missing, or when there
is no credential from either source. There is no default credential and no
anonymous read.

### PIN or passphrase

Both are supported, and the gate asks for whichever the board currently stores.

| Shape | Rule |
|-------|------|
| PIN | 4 to 12 digits, numbers only |
| Passphrase | at least 12 characters (8 is the hard floor) |

A four-digit PIN is ten thousand combinations, which is only safe because of the
lockout: every failed attempt is counted across all clients and instances in
`attempts.json` beside the credential. Five failures start a 30 second lock,
seven five minutes, ten fifteen minutes, twelve thirty minutes, and every
failure after that keeps it at thirty minutes. Only a successful sign-in resets
the counter, so a distributed attacker cannot wait it out, and the thirty-minute
cap means someone else's guesses cannot shut the owner out for a day. The lock
is checked before the credential, so a locked client learns nothing by guessing.

### Changing it

The gate has a **Change the PIN or passphrase** link. It asks for the current
credential, then the replacement, and stores a salted scrypt hash
(`lib/auth.js`, N=16384) in a private blob beside the board — `auth.json` in
production, `preview/auth.json` everywhere else. No agent or admin ever needs
to see the value, and nothing has to be redeployed.

Every session token carries the credential *epoch*. Changing it bumps the
epoch, so cookies minted before the change stop working immediately; the
response sets a fresh cookie so the person who changed it stays signed in. A
stolen cookie therefore cannot survive a rotation, and cannot itself change the
credential, because the current one is required.

## Interface

The board is a quiet ledger: a 64 px date gutter, the note, and its status in a
hairline row. Done notes sink under a **Done** divider. **New note** or `N` opens
a sheet (right drawer on desktop, bottom sheet at 390 px), `Esc` closes it and
`⌘/Ctrl + Enter` saves. Delete confirms in place — the button becomes
**Confirm?** for four seconds — and the toast offers Undo. Notices share one
region, one at a time, with a `+N` counter for a burst.

The gate draws one cell per stored digit when the PIN is four to six digits
(`GET /api/session` reports only the count, `pinLength`, never the value). A
seven-to-twelve digit PIN uses one masked field, and a passphrase uses the same
field. Typing, paste, arrows and backspace are the real input's behaviour: the
cells are painted from it, not a separate control. Failures shake the cells and
put the lockout copy beside them.

The PIN cell pattern is from [Rare UI](https://rareui.com); the credit stays in
the footer as the licence requires. No component library or framework is
loaded.

## Local development

```bash
npm install
vercel env pull .env.local        # BLOB_READ_WRITE_TOKEN
printf 'BOARD_PASSPHRASE=%s\nSESSION_SECRET=%s\n' "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" >> .env.local
vercel dev
```

## Checks

```bash
npm test                   # 6 queue checks + 30 end-to-end checks against a scratch blob
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
  8 per 15 minutes per instance, and the credential is compared in constant
  time.
- Failed sign-ins also feed a durable counter beside the credential, so the
  lockout survives a cold start and is shared across instances.
- All rendering is `textContent`; there is no `innerHTML` and no HTML string
  concatenation of user data anywhere in the client.
- Deletes are soft, kept 30 days in the trash, and undoable from the toast.
- `pinLength` is a digit count for the gate's layout. It is not the PIN, and the
  API never returns the value.

## License

MIT
