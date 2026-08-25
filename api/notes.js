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

async function writeAndPushNotes(notes) {
  // Get current file SHA so we can update it
  const metaRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/data/notes.json`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'kartelkoin-notes'
      }
    }
  );
  if (!metaRes.ok) throw new Error(`Failed to read file meta: ${metaRes.status}`);
  const meta = await metaRes.json();

  const putRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/data/notes.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'kartelkoin-notes'
      },
      body: JSON.stringify({
        message: `Add note ${notes[notes.length - 1].id}`,
        content: Buffer.from(JSON.stringify(notes, null, 2)).toString('base64'),
        sha: meta.sha
      })
    }
  );
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`Failed to write notes: ${putRes.status} ${t}`);
  }
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