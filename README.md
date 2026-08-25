# KartelKoin Notes

A zero-backend, privacy-first note-taking app where **everything lives in the URL**. Share a link, and the recipient gets the full note instantly — no server, no database, no account needed.

## Features

- **URL-based persistence**: Notes are compressed with LZ-string and stored in the URL hash
- **Zero backend**: Runs entirely in the browser — deploy anywhere static hosting works
- **localStorage backup**: Your last session persists on reload
- **Multiple notes**: History saved locally, one note per shareable link
- **Rich editor**: Dark-themed, Markdown-friendly, responsive
- **Copy link**: One-click shareable URLs
- **Shared note banner**: Alerts recipients they're viewing a shared note

## How It Works

1. Type a note → content is compressed (LZ-string) → encoded into URL hash
2. Share the URL → recipient opens it → note decompresses instantly from the hash
3. localStorage keeps a local history of your notes for quick access

## Deploy to Vercel (via GitHub Import)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project**
3. Import your GitHub repository
4. Vercel auto-detects static deployment — no config needed
5. Click **Deploy** → done

Your app will be live at `https://your-project.vercel.app`

## Local Development

```bash
# Serve locally (any static server works)
npx serve .
# or
python3 -m http.server 8000
# or
php -S localhost:8000
```

Open `http://localhost:8000` in your browser.

## Tech Stack

- Vanilla HTML/CSS/JS — no build step
- [LZ-string](https://github.com/pieroxy/lz-string) for compression (via CDN)
- localStorage for local history
- CSS Grid/Flexbox for responsive layout

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save current note |
| `Ctrl+Enter` | New note |
| `Esc` | Blur editor |

## License

MIT