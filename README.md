# KartelKoin Notes

A single-page note board. Notes are stored as one JSON file in this repository and
written back through a Vercel serverless function (`api/notes.js`) that commits to
GitHub.

Live: https://notes.kartelkoin.xyz/

## Status

The app is functional but not yet safe to expose as a public board. It has no
caller authentication, allows any origin, serves its data file statically, and its
`data/notes.json` currently holds credential-shaped notes. See
[REVAMP.md](REVAMP.md) for the ranked list and the owner actions that must happen
before any of the code fixes land.

## Layout

| Path | Purpose |
|------|---------|
| `index.html` | Markup: composer, board, loading and empty states |
| `style.css` | All styling, including the responsive breakpoints |
| `app.js` | Board rendering, editor, save/delete, polling |
| `api/notes.js` | GET/POST/PATCH/DELETE over `data/notes.json` via the GitHub API |
| `data/notes.json` | The note store (committed, therefore public) |
| `REVAMP.md` | Ranked revamp plan, owner actions, acceptance checks |
| `scripts/guard.mjs` | Regression guard — see below |
| `.github/workflows/guard.yml` | Runs the guard on every PR and push to `main` |

## The guard

`scripts/guard.mjs` encodes defects that already shipped once, so they cannot
come back unnoticed. It is a ratchet: `scripts/guard-baseline.json` records the
defects that exist today, so CI is green now and fails only on a **new**
instance.

```bash
node scripts/guard.mjs          # compare against baseline; exit 1 on new findings
node scripts/guard.mjs --list   # print every finding, ignore the baseline
node scripts/guard.mjs --update # rewrite the baseline from the current tree
```

Checks: wildcard CORS, unauthenticated write handlers, missing CSP / nosniff /
frame-ancestors / referrer policy, `.hidden` used without a CSS rule, success
messages routed through the error banner, third-party assets without an integrity
hash, static files under `data/`, and credential-shaped content in the note store.

When you fix something, run `--update` and commit the smaller baseline. The
diff is the progress report.

## Local development

```bash
npx serve .          # static only; the API needs `vercel dev`
vercel dev           # full app, needs GITHUB_REPO and GITHUB_TOKEN
```

## Environment

| Variable | Used by | Notes |
|----------|---------|-------|
| `GITHUB_REPO` | `api/notes.js` | `owner/repo` holding `data/notes.json` |
| `GITHUB_TOKEN` | `api/notes.js` | Needs contents read+write on this repo only |

## License

MIT
