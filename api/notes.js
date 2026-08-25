const GITHUB_REPO = process.env.GITHUB_REPO;
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}/contents/data/notes.json`;

function ghHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kartelkoin-notes',
    ...extra
  };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
  const response = await fetch(GH_API, { headers: ghHeaders() });
  if (!response.ok) {
    throw new Error(`Failed to fetch notes: ${response.status}`);
  }
  const meta = await response.json();
  return JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
}

// Reads current notes, lets mutator produce the new array, commits it.
async function mutateNotes(mutator) {
  const metaRes = await fetch(GH_API, { headers: ghHeaders() });
  if (!metaRes.ok) throw new Error(`Failed to read file meta: ${metaRes.status}`);
  const meta = await metaRes.json();
  const notes = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));

  const result = mutator(notes);

  const putRes = await fetch(GH_API, {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: `KartelKoin: ${mutator.commitMessage}`,
      content: Buffer.from(JSON.stringify(notes, null, 2)).toString('base64'),
      sha: meta.sha
    })
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`Failed to write notes: ${putRes.status} ${t}`);
  }
  return result;
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

      const newNote = {
        id: Date.now().toString(36),
        title: title?.trim() || 'Untitled',
        content: content.trim(),
        createdAt: new Date().toISOString()
      };

      // Return the note itself so the client can render it immediately
      // without waiting for GitHub to reflect the commit.
      await mutateNotes((notes) => {
        notes.unshift(newNote);
        return { commitMessage: `Add note ${newNote.id}` };
      });

      return res.status(200).json({ ok: true, note: newNote });
    } catch (err) {
      console.error('POST /api/notes error:', err);
      return res.status(500).json({ error: 'Failed to save note' });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const { id, title, content } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Note id is required' });
      const validation = validateNote(title, content);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      let updated = null;
      await mutateNotes((notes) => {
        const idx = notes.findIndex(n => n.id === id);
        if (idx === -1) throw Object.assign(new Error('Note not found'), { statusCode: 404 });
        notes[idx] = { ...notes[idx], title: title?.trim() || 'Untitled', content: content.trim(), updatedAt: new Date().toISOString() };
        updated = notes[idx];
        return { commitMessage: `Edit note ${id}` };
      });

      return res.status(200).json({ ok: true, note: updated });
    } catch (err) {
      console.error('PATCH /api/notes error:', err);
      if (err.statusCode === 404) return res.status(404).json({ error: 'Note not found' });
      return res.status(500).json({ error: 'Failed to edit note' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Note id is required' });

      let existed = false;
      await mutateNotes((notes) => {
        const idx = notes.findIndex(n => n.id === id);
        if (idx !== -1) {
          notes.splice(idx, 1);
          existed = true;
        }
        return { commitMessage: `Delete note ${id}` };
      });

      if (!existed) return res.status(404).json({ error: 'Note not found' });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('DELETE /api/notes error:', err);
      if (err.statusCode === 404) return res.status(404).json({ error: 'Note not found' });
      return res.status(500).json({ error: 'Failed to delete note' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
  return res.status(405).json({ error: 'Method not allowed' });
};
