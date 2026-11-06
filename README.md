# KartelKoin Notes

A small private notebook. Notes are stored in this repository (`data/notes.json`)
and read/written through one serverless function, so the store is never served
as a static file.

## Access model

- Every request, read included, needs the shared access key.
- The key lives only in the `NOTES_WRITE_KEY` environment variable. It is
  compared in constant time on the server; the browser keeps it in
  `localStorage` only if "Remember on this device" is ticked, otherwise in
  `sessionStorage`.
- If `NOTES_WRITE_KEY` is unset or shorter than 16 characters the API returns
  `503` for everything. It never falls open.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_REPO` | yes | `owner/repo` that holds `data/notes.json` |
| `GITHUB_TOKEN` | yes | fine-grained token, Contents: read+write on that repo only |
| `NOTES_WRITE_KEY` | yes | shared access key, 16+ characters (`openssl rand -base64 32`) |

Copy `.env.example` to `.env.local` for local work.

## Local development

```bash
node test/dev-server.js          # http://localhost:4173, in-memory GitHub stub
NOTES_WRITE_KEY=... node test/dev-server.js
```

The preview server never touches the real notes file; it seeds the stub from
`data/notes.json` and discards writes on exit.

## Tests

```bash
npm test
```

Twenty-five tests cover auth, fail-closed behaviour, validation, concurrent
writes, CORS and caching. They run against a GitHub stub, so they need no
network and no credentials.

## Design notes

- Two panes: note list on the left, editor on the right. Below 860px the list
  and editor become separate views with a back button.
- The editor never overwrites typing. A remote change is adopted only when the
  open note is clean; otherwise the "Unsaved" badge stays and you decide.
- Polling is every 15s and pauses while the tab is hidden or a save is in
  flight. The server caches reads for 5s so several tabs cost one GitHub call.
- `Ctrl/Cmd+S` saves, `Ctrl/Cmd+Enter` saves and starts a new note,
  `Ctrl/Cmd+K` focuses search.

## Deploy

Vercel picks this up as a static site plus one Node function. `data/` is listed
in `.vercelignore`, so the notes file is never part of the public bundle.

Set the three environment variables in the Vercel project before deploying.
