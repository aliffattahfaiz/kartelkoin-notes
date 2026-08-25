const API_URL = '/api/notes';
const POLL_MS = 2000;

const elements = {
  titleInput: document.getElementById('note-title'),
  editor: document.getElementById('note-editor'),
  charCount: document.getElementById('char-count'),
  saveBtn: document.getElementById('post-btn'),
  newBtn: document.getElementById('new-btn'),
  composerForm: document.getElementById('composer-form'),
  errorBanner: document.getElementById('error-banner'),
  notesGrid: document.getElementById('notes-grid'),
  notesCount: document.getElementById('notes-count'),
  loadingState: document.getElementById('loading-state'),
  emptyState: document.getElementById('empty-state'),
};

let notes = [];
let currentId = null;      // id of the note open in the editor (null = new draft)
let lastRemoteVersion = null; // { id, updatedAt } of the open note as last seen remotely
let isSubmitting = false;
let firstLoadDone = false;

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
  article.className = `note-card${note.id === currentId ? ' current-note' : ''}`;
  article.dataset.id = note.id;

  const shortContent = truncateText(note.content);
  const hasMore = note.content.length > 300;

  article.innerHTML = `
    <header class="note-card-header">
      <div class="note-card-heading">
        <h3 class="note-card-title">${escapeHtml(note.title)}</h3>
        <div class="note-card-tools">
          <time class="note-card-time" datetime="${note.createdAt}">${formatDate(note.updatedAt || note.createdAt)}</time>
          <button class="note-icon-btn copy-btn" data-action="copy" aria-label="Copy body text" title="Copy body text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="note-icon-btn delete-btn" data-action="delete" aria-label="Delete note" title="Delete note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </header>
    <div class="note-card-content">${escapeHtml(shortContent)}</div>
    ${hasMore ? `<button class="note-card-expand" data-action="expand" aria-label="Show full note">Show more</button>` : ''}
    <div class="note-card-open-hint">Click to open & edit</div>
  `;

  // Clicking anywhere on the card opens it in the main editor
  article.addEventListener('click', () => openNote(note.id));

  const expandBtn = article.querySelector('.note-card-expand');
  if (expandBtn) {
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      article.querySelector('.note-card-content').textContent = note.content;
      expandBtn.remove();
      article.classList.add('expanded');
    });
  }
  article.querySelector('.copy-btn').addEventListener('click', (e) => { e.stopPropagation(); copyNote(note); });
  article.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteNote(note); });

  return article;
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
  notes.forEach(note => fragment.appendChild(createNoteCard(note)));
  elements.notesGrid.appendChild(fragment);
}

function showLoading(show) {
  elements.loadingState.classList.toggle('hidden', !show);
  elements.notesGrid.classList.toggle('hidden', show);
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove('hidden');
  setTimeout(() => elements.errorBanner.classList.add('hidden'), 4000);
}

function toast(message) {
  showError(message);
}

function updateCharCount() {
  const count = elements.editor.value.length;
  elements.charCount.textContent = `${count.toLocaleString()} / 10,000 characters`;
}

function setEditorFor(note) {
  currentId = note ? note.id : null;
  lastRemoteVersion = note ? { id: note.id, updatedAt: note.updatedAt || note.createdAt } : null;
  elements.titleInput.value = note ? note.title : '';
  elements.editor.value = note ? note.content : '';
  updateCharCount();
  elements.saveBtn.innerHTML = note
    ? 'Save'
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Save`;
  renderNotes();
  elements.titleInput.focus();
}

function openNote(id) {
  const note = notes.find(n => n.id === id);
  if (!note) return;
  setEditorFor(note);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function startNewDraft() {
  setEditorFor(null);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function fetchNotes(showSpinner = true) {
  if (showSpinner && !firstLoadDone) showLoading(true);
  try {
    const response = await fetch(API_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load notes');
    const data = await response.json();
    notes = data.notes || [];

    // Live sync for the note open in the editor:
    // adopt remote changes only if the user isn't actively typing in it.
    if (currentId) {
      const remote = notes.find(n => n.id === currentId);
      const localStamp = lastRemoteVersion && lastRemoteVersion.id === currentId ? lastRemoteVersion.updatedAt : null;
      const remoteStamp = remote ? (remote.updatedAt || remote.createdAt) : null;
      const remoteChanged = remoteStamp && localStamp && remoteStamp !== localStamp;
      const editorTouched =
        elements.titleInput.value !== '' || elements.editor.value !== '';

      if (remoteChanged && !editorTouched) {
        elements.titleInput.value = remote.title;
        elements.editor.value = remote.content;
        updateCharCount();
        lastRemoteVersion = { id: remote.id, updatedAt: remoteStamp };
      } else if (!remoteChanged && lastRemoteVersion === null && remote) {
        lastRemoteVersion = { id: remote.id, updatedAt: remoteStamp };
      }
    }

    renderNotes();
    firstLoadDone = true;
  } catch (err) {
    console.error('Fetch notes error:', err);
    if (showSpinner) showError('Failed to load notes. Retrying…');
  } finally {
    if (showSpinner && !firstLoadDone) showLoading(false);
  }
}

async function saveCurrent() {
  if (isSubmitting) return;
  const title = elements.titleInput.value.trim();
  const content = elements.editor.value.trim();

  if (!content) {
    showError('Write something before saving');
    elements.editor.focus();
    return;
  }

  isSubmitting = true;
  elements.saveBtn.disabled = true;
  try {
    let response;
    if (currentId) {
      response = await fetch(API_URL, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentId, title, content })
      });
    } else {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
      });
    }

    if (response.status === 429) throw new Error('Rate limited. Please wait.');
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to save note');
    }

    const data = await response.json();

    if (data.note) {
      // Optimistic: put the saved version at the top of the list
      notes = notes.filter(n => n.id !== data.note.id);
      notes.unshift(data.note);
      currentId = data.note.id;
      lastRemoteVersion = { id: data.note.id, updatedAt: data.note.updatedAt || data.note.createdAt };
    }

    renderNotes();
    toast(currentId ? 'Saved ✓' : 'Saved ✓');
  } catch (err) {
    console.error('Save error:', err);
    showError(err.message);
  } finally {
    isSubmitting = false;
    elements.saveBtn.disabled = false;
  }
}

async function copyNote(note) {
  try {
    await navigator.clipboard.writeText(note.content);
    toast('Body text copied to clipboard');
  } catch (err) {
    console.error('Copy error:', err);
    showError('Failed to copy note');
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
    notes = notes.filter(n => n.id !== note.id);
    if (currentId === note.id) startNewDraft();
    renderNotes();
    toast('Deleted');
  } catch (err) {
    console.error('Delete note error:', err);
    showError(err.message);
  }
}

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
    toast(`${notes.length} notes copied to clipboard`);
  } catch (err) {
    console.error('Copy all error:', err);
    showError('Failed to copy notes');
  }
}

// Ctrl/Cmd+S saves the working note
function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrent();
  }
}

// Live streaming: poll for remote changes
setInterval(() => fetchNotes(false), POLL_MS);

function init() {
  updateCharCount();
  fetchNotes();

  elements.editor.addEventListener('input', updateCharCount);
  elements.composerForm.addEventListener('submit', (e) => { e.preventDefault(); saveCurrent(); });
  elements.saveBtn.addEventListener('click', (e) => { e.preventDefault(); saveCurrent(); });
  if (elements.newBtn) elements.newBtn.addEventListener('click', startNewDraft);
  const copyAllBtn = document.getElementById('copy-all-btn');
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyAllNotes);
  document.addEventListener('keydown', handleKeydown);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
