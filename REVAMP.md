# Revamp plan

State of `notes.kartelkoin.xyz` on 2026-11-06, and the order the work has to
happen in. Written after the live audit, the security review and the QA pass.

## Why order matters

`main` deploys straight to production, has no branch protection, no rulesets and
no workflows. Every push is a release. So the sequence below is not a preference:
the code fixes cannot be merged safely until the store no longer holds live
credentials, and they cannot be verified until there is a gate.

## 0. Owner actions — only you can do these

| # | Action | Why |
|---|--------|-----|
| 0.1 | Rotate `GITHUB_TOKEN` on the Vercel project | The same PAT backs this API and, per the security review, is reachable from the `tasks` repo. Treat it as burned. |
| 0.2 | Rotate the third-party email + password in note `mtbfudl9` | `camila.collins5318@partypinpai.com` / a password, public since 2026-08-27. That account is not yours, so tell the owner rather than rotating it. |
| 0.3 | Check `authorized_keys` on the M910S and the Lubuntu VM | Notes `mt984omm` and `mt983pt4` contain `ssh-ed25519` **public** keys being appended to `authorized_keys`. A public key is not a secret, but if you ran those commands, someone else holds a working login to that machine. Notes `mvyqcsk8` / `mvyq9nzv` are sudo shell transcripts with no password value. |
| 0.4 | Decide whether the board is public-read or private | Everything downstream changes with this answer. |

Deleting the notes is **not** enough — `git log` keeps them, and `/data/notes.json`
is still served. The history rewrite in step 2 is required.

## 1. Gate (this branch)

- `scripts/guard.mjs` — ratchet over defects that already shipped: wildcard CORS,
  unauthenticated write handlers, missing CSP / nosniff / frame-ancestors /
  referrer policy, `.hidden` with no CSS rule, success routed through the error
  banner, third-party assets without SRI, static files under `data/`,
  credential-shaped notes.
- `.github/workflows/guard.yml` — runs it on every PR and on push to `main`.
- `scripts/guard-baseline.json` — the 12 defects that exist today. Green now,
  red on anything new. Shrinking this file is the progress metric.

Enable branch protection on `main` requiring this check. Without that the
workflow reports but does not block.

## 2. Store — before any UI work

1. Move the store off GitHub commits to Vercel KV, Postgres or Blob. One commit
   per save is what produced 102 commits, 77 of them titled `KartelKoin: undefined`,
   and it loses writes on a 409.
2. Delete `data/notes.json` from the deploy so `/data/notes.json` 404s.
3. Purge the credential note `mtbfudl9` and rewrite history (`git filter-repo`),
   then force-push `main` with the owner's explicit approval — this is the one
   force-push the plan allows.
4. Fix the commit-message bug while the store is being replaced:
   `mutator.commitMessage` is read off the function, not its return value.

## 3. Access

1. Caller authentication on every mutating route. Today anonymous `POST` and
   `DELETE` return `200 {"ok":true}`.
2. Per-note ownership so one visitor cannot delete another's note.
3. Replace `Access-Control-Allow-Origin: *` with an origin allowlist from an env
   var. This is also the reason `OPTIONS` currently advertises every method to
   every origin.
4. Rate limiting per IP and per session. Return `413` for an oversized body
   (currently `429`, which tells the client to retry a request that will never
   succeed) and `409` with the current `sha` for a lost write.
5. If the board is private: client-side AES-GCM with PBKDF2 at 600k iterations,
   server stores ciphertext only, and drop the unused `lz-string` bundle.

## 4. Headers

One global block in `vercel.json`: CSP (`default-src 'self'`, no `unsafe-inline`
for scripts), `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`,
`Referrer-Policy: no-referrer`, `Permissions-Policy`. Self-host the three Google
Fonts files and remove the preconnect — that also clears the missing-SRI finding.

## 5. UI — the ten design defects

Each is small and independent; they can land as one PR or five.

| # | Defect | Fix |
|---|--------|-----|
| 1 | 36 of 45 cards titled "Untitled" | Derive a title from the first 60 characters when the title is empty |
| 2 | Opening a card discards unsaved edits | Dirty flag + confirm, plus `beforeunload` |
| 3 | Delete is a 26×26 target on every card, `confirm()` only, no undo | Move it into the open note; 44×44 minimum; 5s undo |
| 4 | Save is clipped off-screen at 390px | Let the button row wrap; the `.btn` is 100% wide inside a row |
| 5 | Cards are mouse-only (`tabIndex -1`, no role) | `role="button"`, `tabindex="0"`, Enter/Space, visible focus ring |
| 6 | No search, sort or filter; 45 × 415px cards = 5,814px | Search box with `/` focus, sort by updated, tag filter |
| 7 | Composer always open, pushing the board 520px down | Collapse to a single line until focused |
| 8 | `.hidden` has no CSS rule — the loader never disappears | `firstLoadDone` is set inside `try`, so `showLoading(false)` is skipped; add the rule and move the flag |
| 9 | `--text-muted: #6a6a5a` is 3.59:1 | `#8f8f80` |
| 10 | "New" has no styling; Save keeps the wrong label while editing | Define `.btn-secondary`; switch the label to "Update" |

Plus: 104 touch targets under 44×44, no skip link, no meta description, no OG
tags, no favicon, no footer.

## 6. Behaviour

- Remove the 2s poll. It is ~6 KB every 2 seconds with no backoff and no
  focus-awareness. Use refresh-on-focus, or SSE if it must be live.
- Replace `Date.now().toString(36)` IDs — two saves in the same millisecond
  collide. Use `crypto.randomUUID()`.
- Separate success from failure in the UI. `toast()` is currently
  `showError()`, so "Saved ✓" renders in red.
- Guard the live-sync branch: `editorTouched` is always true, so remote updates
  are never adopted. That branch is dead code today.

## Acceptance for the next pass

1. `GET /api/notes` unauthenticated returns `401` (private) or a read-only
   projection with no credential-shaped content (public).
2. `POST` / `DELETE` unauthenticated return `401`.
3. `OPTIONS` does not return `ACAO: *`.
4. `/data/notes.json` returns `404`.
5. Response headers include CSP, nosniff, frame-ancestors and referrer policy.
6. Save shows a success style; the loader disappears; a draft survives a card
   click.
7. A keyboard-only user can open, edit and save a note.
8. `scripts/guard-baseline.json` is empty.
