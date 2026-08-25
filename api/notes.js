const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GITHUB_REPO = process.env.GITHUB_REPO;
const RAW_NOTES_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/data/notes.json`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function validateNote(title, content) {
  if (!content || !content.trim()) {
    return { valid: false, error: 'Content is required' };
  }
  if (title && title.length > 120) {
    return { valid: false, error: 'Title must be 120 characters or less' };
  }
  if (content.length > 10000) {
    return { valid: false, error: 'Content must be 10000 characters or less' };
  }
  return { valid: true };
}

async function fetchNotes() {
  const response = await fetch(`${RAW_NOTES_URL}?t=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch notes: ${response.status}`);
  }
  return response.json();
}

function writeAndPushNotes(notes) {
  const tmpDir = '/tmp/notes-repo';
  const keyPath = '/tmp/deploy-key';

  fs.writeFileSync(keyPath, process.env.GIT_SSH_KEY.replace(/\\n/g, '\n'), { mode: 0o600 });

  if (fs.existsSync(tmpDir)) {
    execSync(`rm -rf ${tmpDir}`, { stdio: 'ignore' });
  }

  execSync(`git clone git@github.com:${GITHUB_REPO}.git ${tmpDir}`, {
    env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` },
    stdio: 'inherit'
  });

  const notesPath = path.join(tmpDir, 'data', 'notes.json');
  fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));

  execSync('git config user.name "vercel-bot"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git config user.email "vercel-bot@kartelkoin.xyz"', { cwd: tmpDir, stdio: 'ignore' });
  execSync('git add data/notes.json', { cwd: tmpDir, stdio: 'ignore' });
  execSync(`git commit -m "Add note ${notes[notes.length - 1].id}"`, { cwd: tmpDir, stdio: 'ignore' });
  execSync('git push origin main', {
    cwd: tmpDir,
    env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` },
    stdio: 'inherit'
  });
}

module.exports = async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const notes = await fetchNotes();
      return res.status(200).json({ notes });
    } catch (err) {
      console.error('GET /api/notes error:', err);
      return res.status(500).json({ error: 'Failed to load notes' });
    }
  }

  if (req.method === 'POST') {
    try {
      if (JSON.stringify(req.body).length > 10240) {
        return res.status(429).json({ error: 'Request too large' });
      }

      const { title, content } = req.body || {};
      const validation = validateNote(title, content);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const notes = await fetchNotes();
      const newNote = {
        id: Date.now().toString(36),
        title: title?.trim() || 'Untitled',
        content: content.trim(),
        createdAt: new Date().toISOString()
      };
      notes.unshift(newNote);
      writeAndPushNotes(notes);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('POST /api/notes error:', err);
      return res.status(500).json({ error: 'Failed to save note' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Method not allowed' });
};