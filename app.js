const STORAGE_KEY = 'kartelkoin_notes';
const DEBOUNCE_MS = 800;

const state = {
  notes: [],
  currentNoteId: null,
  isSharedNote: false,
  saveTimeout: null,
  urlUpdateTimeout: null,
  isLoadingFromUrl: false,
};

const elements = {
  titleInput: document.getElementById('note-title'),
  editor: document.getElementById('note-editor'),
  charCount: document.getElementById('char-count'),
  urlIndicator: document.getElementById('url-indicator'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  newNoteBtn: document.getElementById('new-note-btn'),
  saveSharedBtn: document.getElementById('save-shared-btn'),
  clearHistoryBtn: document.getElementById('clear-history-btn'),
  notesList: document.getElementById('notes-list'),
  emptyState: document.getElementById('empty-state'),
  sharedBanner: document.getElementById('shared-banner'),
};

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function getCurrentTimestamp() {
  return new Date().toISOString();
}

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

function loadNotesFromStorage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      state.notes = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load notes from localStorage:', e);
    state.notes = [];
  }
}

function saveNotesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.notes));
  } catch (e) {
    console.error('Failed to save notes to localStorage:', e);
  }
}

function encodeNote(title, content) {
  const data = { t: title || 'Untitled', c: content || '', v: 1 };
  const json = JSON.stringify(data);
  return LZString.compressToEncodedURIComponent(json);
}

function decodeNote(hash) {
  try {
    const json = LZString.decompressFromEncodedURIComponent(hash);
    if (!json) return null;
    const data = JSON.parse(json);
    if (data.v !== 1) return null;
    return { title: data.t || 'Untitled', content: data.c || '' };
  } catch (e) {
    console.error('Failed to decode note from URL:', e);
    return null;
  }
}

function updateUrlIndicator(status) {
  elements.urlIndicator.className = 'url-indicator ' + status;
  if (status === 'synced') {
    elements.urlIndicator.textContent = 'Link updated';
  } else if (status === 'pending') {
    elements.urlIndicator.textContent = 'Updating...';
  } else {
    elements.urlIndicator.textContent = '';
  }
}

function updateUrlHash(title, content) {
  const hash = encodeNote(title, content);
  const newUrl = `${window.location.origin}${window.location.pathname}#${hash}`;
  history.replaceState(null, '', newUrl);
  updateUrlIndicator('synced');
}

function debouncedUpdateUrl(title, content) {
  clearTimeout(state.urlUpdateTimeout);
  updateUrlIndicator('pending');
  state.urlUpdateTimeout = setTimeout(() => {
    updateUrlHash(title, content);
  }, DEBOUNCE_MS);
}

function updateCharCount() {
  const text = elements.editor.value;
  const count = text.length;
  elements.charCount.textContent = `${count.toLocaleString()} character${count !== 1 ? 's' : ''}`;
}

function createNoteElement(note, isCurrent = false) {
  const li = document.createElement('li');
  li.className = `note-item${isCurrent ? ' current' : ''}`;
  li.dataset.id = note.id;

  li.innerHTML = `
    <div class="note-item-header">
      <span class="note-item-title" title="${escapeHtml(note.title)}">${escapeHtml(note.title)}</span>
      <div class="note-item-meta">
        <span>${formatDate(note.updatedAt)}</span>
        <span>${(note.content.length / 1024).toFixed(1)} KB</span>
      </div>
    </div>
    <div class="note-item-actions">
      <button class="note-item-btn open-btn" data-action="open" aria-label="Open note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        Open
      </button>
      <button class="note-item-btn delete-btn" data-action="delete" aria-label="Delete note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        Delete
      </button>
    </div>
  `;

  li.querySelector('.open-btn').addEventListener('click', () => openNote(note.id));
  li.querySelector('.delete-btn').addEventListener('click', () => deleteNote(note.id));

  return li;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderNotesList() {
  elements.notesList.innerHTML = '';

  if (state.notes.length === 0) {
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');

  const sortedNotes = [...state.notes].sort((a, b) =>
    new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  sortedNotes.forEach(note => {
    const isCurrent = note.id === state.currentNoteId && !state.isSharedNote;
    const el = createNoteElement(note, isCurrent);
    elements.notesList.appendChild(el);
  });
}

function setEditorContent(title, content, isShared = false) {
  state.isLoadingFromUrl = true;
  elements.titleInput.value = title;
  elements.editor.value = content;
  state.isLoadingFromUrl = false;

  updateCharCount();
  state.isSharedNote = isShared;

  if (isShared) {
    elements.sharedBanner.classList.remove('hidden');
  } else {
    elements.sharedBanner.classList.add('hidden');
  }
}

function getEditorContent() {
  return {
    title: elements.titleInput.value.trim() || 'Untitled',
    content: elements.editor.value
  };
}

function createNewNote() {
  const { title, content } = getEditorContent();

  if (content.trim() || title !== 'Untitled') {
    const existingIndex = state.notes.findIndex(n => n.id === state.currentNoteId);
    if (existingIndex >= 0) {
      state.notes[existingIndex] = {
        ...state.notes[existingIndex],
        title,
        content,
        updatedAt: getCurrentTimestamp()
      };
    } else {
      const newNote = {
        id: generateId(),
        title,
        content,
        createdAt: getCurrentTimestamp(),
        updatedAt: getCurrentTimestamp()
      };
      state.notes.unshift(newNote);
      state.currentNoteId = newNote.id;
    }
    saveNotesToStorage();
    renderNotesList();
  }

  setEditorContent('Untitled', '');
  state.currentNoteId = null;
  state.isSharedNote = false;
  history.replaceState(null, '', `${window.location.origin}${window.location.pathname}`);
  updateUrlIndicator('');
  elements.editor.focus();
}

function openNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;

  setEditorContent(note.title, note.content);
  state.currentNoteId = note.id;
  state.isSharedNote = false;
  elements.sharedBanner.classList.add('hidden');
  debouncedUpdateUrl(note.title, note.content);
  renderNotesList();
  elements.editor.focus();
}

function deleteNote(id) {
  if (!confirm('Delete this note? This cannot be undone.')) return;

  state.notes = state.notes.filter(n => n.id !== id);
  saveNotesToStorage();

  if (state.currentNoteId === id) {
    createNewNote();
  } else {
    renderNotesList();
  }
}

function saveSharedNote() {
  const { title, content } = getEditorContent();

  const existingIndex = state.notes.findIndex(n => n.id === state.currentNoteId);
  if (existingIndex >= 0 && !state.isSharedNote) {
    state.notes[existingIndex] = {
      ...state.notes[existingIndex],
      title,
      content,
      updatedAt: getCurrentTimestamp()
    };
  } else {
    const newNote = {
      id: generateId(),
      title,
      content,
      createdAt: getCurrentTimestamp(),
      updatedAt: getCurrentTimestamp()
    };
    state.notes.unshift(newNote);
    state.currentNoteId = newNote.id;
  }

  saveNotesToStorage();
  state.isSharedNote = false;
  elements.sharedBanner.classList.add('hidden');
  renderNotesList();
  debouncedUpdateUrl(title, content);
}

function clearAllNotes() {
  if (state.notes.length === 0) return;
  if (!confirm('Delete all saved notes? This cannot be undone.')) return;

  state.notes = [];
  saveNotesToStorage();
  renderNotesList();

  if (state.currentNoteId) {
    createNewNote();
  }
}

function copyShareLink() {
  const { title, content } = getEditorContent();
  const hash = encodeNote(title, content);
  const url = `${window.location.origin}${window.location.pathname}#${hash}`;

  navigator.clipboard.writeText(url).then(() => {
    const originalText = elements.copyLinkBtn.innerHTML;
    elements.copyLinkBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied!
    `;
    elements.copyLinkBtn.classList.add('btn-secondary');
    elements.copyLinkBtn.classList.remove('btn-primary');

    setTimeout(() => {
      elements.copyLinkBtn.innerHTML = originalText;
      elements.copyLinkBtn.classList.add('btn-primary');
      elements.copyLinkBtn.classList.remove('btn-secondary');
    }, 2000);
  }).catch(() => {
    alert('Failed to copy link. Please try manually.');
  });
}

function handleHashChange() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

  const decoded = decodeNote(hash);
  if (decoded) {
    setEditorContent(decoded.title, decoded.content, true);
    state.currentNoteId = null;
    renderNotesList();
  }
}

function handleEditorInput() {
  if (state.isLoadingFromUrl) return;

  updateCharCount();

  const { title, content } = getEditorContent();

  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(() => {
    if (state.currentNoteId && !state.isSharedNote) {
      const noteIndex = state.notes.findIndex(n => n.id === state.currentNoteId);
      if (noteIndex >= 0) {
        state.notes[noteIndex] = {
          ...state.notes[noteIndex],
          title,
          content,
          updatedAt: getCurrentTimestamp()
        };
        saveNotesToStorage();
        renderNotesList();
      }
    }
    debouncedUpdateUrl(title, content);
  }, DEBOUNCE_MS);
}

function handleTitleInput() {
  if (state.isLoadingFromUrl) return;

  const { title, content } = getEditorContent();
  debouncedUpdateUrl(title, content);
}

function handleKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (state.isSharedNote) {
      saveSharedNote();
    } else if (state.currentNoteId) {
      const { title, content } = getEditorContent();
      const noteIndex = state.notes.findIndex(n => n.id === state.currentNoteId);
      if (noteIndex >= 0) {
        state.notes[noteIndex] = {
          ...state.notes[noteIndex],
          title,
          content,
          updatedAt: getCurrentTimestamp()
        };
        saveNotesToStorage();
        renderNotesList();
        debouncedUpdateUrl(title, content);
      }
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    createNewNote();
  }

  if (e.key === 'Escape') {
    elements.editor.blur();
    elements.titleInput.blur();
  }
}

function init() {
  loadNotesFromStorage();
  renderNotesList();

  handleHashChange();

  elements.editor.addEventListener('input', handleEditorInput);
  elements.titleInput.addEventListener('input', handleTitleInput);
  elements.copyLinkBtn.addEventListener('click', copyShareLink);
  elements.newNoteBtn.addEventListener('click', createNewNote);
  elements.saveSharedBtn.addEventListener('click', saveSharedNote);
  elements.clearHistoryBtn.addEventListener('click', clearAllNotes);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('hashchange', handleHashChange);

  elements.editor.focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}