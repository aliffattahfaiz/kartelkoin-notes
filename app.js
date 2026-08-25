const API_URL = '/api/notes';

const elements = {
  titleInput: document.getElementById('note-title'),
  editor: document.getElementById('note-editor'),
  charCount: document.getElementById('char-count'),
  postBtn: document.getElementById('post-btn'),
  composerForm: document.getElementById('composer-form'),
  errorBanner: document.getElementById('error-banner'),
  notesGrid: document.getElementById('notes-grid'),
  notesCount: document.getElementById('notes-count'),
  loadingState: document.getElementById('loading-state'),
  emptyState: document.getElementById('empty-state'),
};

let notes = [];
let editingId = null;
let isSubmitting = false;

function formatDate(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncateText(text, maxLength = 300) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + '…';
}

function createNoteCard(note) {
  const article = document.createElement('article');
  article.className = 'note-card';
  article.dataset.id = note.id;

  const shortContent = truncateText(note.content);
  const hasMore = note.content.length > 300;

  article.innerHTML = `
    <header class="note-card-header">
      <div class="note-card-heading">
        <h3 class="note-card-title">${escapeHtml(note.title)}</h3>
        <div class="note-card-tools">
          <time class="note-card-time" datetime="${note.createdAt}">${formatDate(note.updatedAt || note.createdAt)}</time>
          <button class="note-icon-btn copy-btn" data-action="copy" aria-label="Copy note" title="Copy note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="note-icon-btn edit-btn" data-action="edit" aria-label="Edit note" title="Edit note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="note-icon-btn delete-btn" data-action="delete" aria-label="Delete note" title="Delete note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </header>
    <div class="note-card-content">${escapeHtml(shortContent)}</div>
    ${hasMore ? `<button class="note-card-expand" data-action="expand" aria-label="Show full note">Show more</button>` : ''}
  `;

  const expandBtn = article.querySelector('.note-card-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      article.querySelector('.note-card-content').textContent = note.content;
      expandBtn.remove();
      article.classList.add('expanded');
    });
  }
  article.querySelector('.copy-btn').addEventListener('click', () => copyNote(note));
  article.querySelector('.edit-btn').addEventListener('click', () => startEdit(note));
  article.querySelector('.delete-btn').addEventListener('click', () => deleteNote(note));

  return article;
}

function createEditForm(note) {
  const form = document.createElement('form');
  form.className = 'note-card note-edit-form';
  form.innerHTML = `
    <input type="text" class="edit-title-input" value="${escapeHtml(note.title)}" maxlength="120" aria-label="Edit title">
    <textarea class="edit-content-input" maxlength="10000" aria-label="Edit content">${escapeHtml(note.content)}</textarea>
    <div class="edit-actions">
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <button type="button" class="btn btn-ghost btn-sm cancel-edit-btn">Cancel</button>
    </div>
  `;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = form.querySelector('.edit-title-input').value.trim();
    const content = form.querySelector('.edit-content-input').value.trim();
    if (!content) { showError('Note content is required'); return; }
    saveEdit(note.id, title, content);
  });
  form.querySelector('.cancel-edit-btn').addEventListener('click', () => {
    editingId = null;
    renderNotes(notes);
  });
  return form;
}

function renderNotes() {
  elements.notesGrid.innerHTML = '';
  elements.notesCount.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;

  if (notes.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');

  const fragment = document.createDocumentFragment();
  notes.forEach(note => {
    fragment.appendChild(editingId === note.id ? createEditForm(note) : createNoteCard(note));
  });
  elements.notesGrid.appendChild(fragment);
}

function showLoading(show) {
  elements.loadingState.classList.toggle('hidden', !show);
  elements.notesGrid.classList.toggle('hidden', show);
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove('hidden');
  setTimeout(() => elements.errorBanner.classList.add('hidden'), 5000);
}

function updateCharCount() {
  const count = elements.editor.value.length;
  elements.charCount.textContent = `${count.toLocaleString()} / 10,000 characters`;
}

async function fetchNotes(showSpinner = true) {
  if (showSpinner) showLoading(true);
  try {
    const response = await fetch(API_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load notes');
    const data = await response.json();
    // Don't clobber an in-progress edit
    if (editingId === null) {
      notes = data.notes || [];
      renderNotes();
    } else {
      notes = data.notes || [];
    }
  } catch (err) {
    console.error('Fetch notes error:', err);
    if (showSpinner) showError('Failed to load notes. Please refresh.');
  } finally {
    if (showSpinner) showLoading(false);
  }
}

async function postNote(title, content) {
  elements.postBtn.disabled = true;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });

    if (response.status === 429) throw new Error('Rate limited. Please wait.');
    if (response.status === 400) {
      const data = await response.json();
      throw new Error(data.error || 'Invalid note');
    }
    if (!response.ok) throw new Error('Failed to post note');

    const data = await response.json();

    // Optimistic render — the server returns the saved note directly,
    // so we don't wait for GitHub to reflect the commit.
    if (data.note) {
      notes.unshift(data.note);
      renderNotes();
    }

    elements.titleInput.value = '';
    elements.editor.value = '';
    updateCharCount();
  } catch (err) {
    console.error('Post note error:', err);
    showError(err.message);
  } finally {
    elements.postBtn.disabled = false;
  }
}

async function copyNote(note) {
  try {
    await navigator.clipboard.writeText(note.content);
    showError('Note copied to clipboard'); // reuse banner as toast
  } catch (err) {
    console.error('Copy error:', err);
    showError('Failed to copy note');
  }
}

function startEdit(note) {
  editingId = note.id;
  renderNotes();
  const form = elements.notesGrid.querySelector('.note-edit-form .edit-title-input');
  if (form) form.focus();
}

async function saveEdit(id, title, content) {
  try {
    const response = await fetch(API_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, content })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to edit note');
    }
    const data = await response.json();
    editingId = null;
    if (data.note) {
      const idx = notes.findIndex(n => n.id === id);
      if (idx !== -1) notes[idx] = data.note;
      renderNotes();
    } else {
      await fetchNotes();
    }
  } catch (err) {
    console.error('Edit note error:', err);
    showError(err.message);
  }
}

async function deleteNote(note) {
  if (!confirm(`Delete "${note.title}"? This cannot be undone.`)) return;
  try {
    const response = await fetch(API_URL, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id })
    });
    if (!response.ok && response.status !== 404) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to delete note');
    }
    // Optimistic removal
    notes = notes.filter(n => n.id !== note.id);
    renderNotes();
  } catch (err) {
    console.error('Delete note error:', err);
    showError(err.message);
  }
}

function handleSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;

  const title = elements.titleInput.value.trim();
  const content = elements.editor.value.trim();

  if (!content) {
    showError('Note content is required');
    elements.editor.focus();
    return;
  }

  isSubmitting = true;
  postNote(title, content).finally(() => { isSubmitting = false; });
}

// Periodic refresh so other visitors' notes appear (~30s), unless editing
setInterval(() => {
  if (editingId === null) fetchNotes(false);
}, 30000);

async function copyAllNotes() {
  if (notes.length === 0) {
    showError('No notes to copy');
    return;
  }
  const text = notes
    .map(n => `## ${n.title}\n\n${n.content}`)
    .join('\n\n---\n\n');
  try {
    await navigator.clipboard.writeText(`# KartelKoin Notes (${notes.length} notes)\n\n${text}`);
    showError(`${notes.length} notes copied to clipboard`);
  } catch (err) {
    console.error('Copy all error:', err);
    showError('Failed to copy notes');
  }
}

function init() {
  updateCharCount();
  fetchNotes();

  elements.editor.addEventListener('input', updateCharCount);
  elements.composerForm.addEventListener('submit', handleSubmit);
  const copyAllBtn = document.getElementById('copy-all-btn');
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyAllNotes);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
