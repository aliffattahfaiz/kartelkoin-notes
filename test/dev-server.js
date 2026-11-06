'use strict';

// Local preview server: serves the static app and routes /api/notes to the
// real serverless handler with an in-memory GitHub stub.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createGitHubStub } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4173);

const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/notes.json'), 'utf8'));
const stub = createGitHubStub(seed);
global.fetch = stub.fetchStub;

process.env.GITHUB_REPO = 'local/preview';
process.env.GITHUB_TOKEN = 'stub-token';
process.env.NOTES_WRITE_KEY = process.env.NOTES_WRITE_KEY || 'preview-key-0123456789';

const handler = require('../api/notes.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Mirrors the header block in vercel.json so the preview fails the same way
// production would if a change broke the CSP.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (err) { resolve(undefined); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/notes') {
    const body = await readBody(req);
    const shim = {
      method: req.method,
      headers: req.headers,
      body,
      socket: req.socket,
    };
    const shimRes = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        res.writeHead(this.statusCode, { ...this.headers, 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return this;
      },
      end() {
        res.writeHead(this.statusCode, this.headers);
        res.end();
        return this;
      },
    };
    try {
      await handler(shim, shimRes);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Mirror production: `.vercelignore` keeps data/ out of the deployment, so the
  // note store must not be reachable over HTTP here either.
  if (url.pathname.startsWith('/data/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`preview on http://localhost:${PORT}  key=${process.env.NOTES_WRITE_KEY}`);
});
