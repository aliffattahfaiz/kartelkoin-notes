'use strict';

const API = '/api/notes';
const KEY_STORE = 'kk-notes-key';
const POLL_MS = 15000;

const $ = (id) => document.getElementById(id);

const el = {
  lock: $('lock-screen'),
  lockForm: $('lock-form'),
  lockKey: $('lock-key'),
  lockRemember: $('lock-remember'),
  lockError: $('lock-error'),
  lockSubmit: $('lock-submit'),
  app: $('app'),
  rail: $('rail'),
  list: $('note-list'),
  listEmpty: $('list-empty'),
  search: $('search'),
  notesCount: $('notes-count'),
  filterNote: $('filter-note'),
  sync: $('sync-state'),
  title: $('note-title'),
  editor: $('note-editor'),
  form: $('editor-form'),
  charCount: $('char-count'),
  savedAt: $('saved-at'),
  dirty: $('dirty-flag'),
  saveBtn: $('save-btn'),
  deleteBtn: $('delete-btn'),
  copyNoteBtn: $('copy-note-btn'),
  copyAllBtn: $('copy-all-btn'),
  refreshBtn: $('refresh-btn'),
  lockBtn: $('lock-btn'),
  newBtn: $('new-btn'),
  backBtn: $('back-btn'),
  toast: $('toast'),
  confirm: $('confirm'),
  confirmTitle: $('confirm-title'),
  confirmBody: $('confirm-body'),
  confirmOk: $('confirm-ok'),
  confirmCancel: $('confirm-cancel'),
};

const state = {
  key: null,
  notes: [],
  query: '',
  currentId: null,
  dirty: false,
  saving: false,
  poll: null,
  known: new Map(), // id -> updatedAt|createdAt, to spot remote changes
};

/* ---------------- storage & key handling ---------------- */

function readStoredKey() {
  try {
    const persistent = localStorage.getItem(KEY_STORE);
    if (persistent) return { key: persistent, remember: true };
    const session = sessionStorage.getItem(KEY_STORE);
    if (session) return { key: session, remember: false };
  } catch (err) {
    /* storage unavailable */
  }
  return null;
}

function storeKey(key, remember) {
  try {
    localStorage.removeItem(KEY_STORE);
    sessionStorage.removeItem(KEY_STORE);
    (remember ? localStorage : sessionStorage).setItem(KEY_STORE, key);
  } catch (err) {
    /* private mode: keep it in memory only */
  }
}

function clearKey() {
  try {
    localStorage.removeItem(KEY_STORE);
    sessionStorage.removeItem(KEY_STORE);
  } catch (err) {
    /* ignore */
  }
  state.key = null;
}

/* ---------------- transport ---------------- */

async function api(method, body) {
  const headers = { 'X-Notes-Key': state.key };
  const init = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(API, init);
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }

  if (res.status === 401) {
    lock('Your key is no longer valid.');
    throw new Error('Unauthorised');
  }
  if (res.status === 503) {
    throw new Error('This notebook is not configured on the server yet.');
  }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data || {};
}

/* ---------------- small UI helpers ---------------- */

let toastTimer = null;
function toast(message, tone = 'ok') {
  el.toast.textContent = message;
  el.toast.dataset.tone = tone;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function setSync(text, tone) {
  el.sync.textContent = text;
  el.sync.dataset.tone = tone || '';
}

// A note with no title still needs a name in the list. Derive one from the
// first line of the body instead of showing 36 rows called "Untitled".
function displayTitle(note) {
  const title = (note.title || '').trim();
  if (title && title.toLowerCase() !== 'untitled') return title;
  const first = (note.content || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!first) return 'Empty note';
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

function formatDate(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.floor(mins / 1440)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stampOf(note) {
  return note.updatedAt || note.createdAt || '';
}

function markDirty(dirty) {
  state.dirty = dirty;
  el.dirty.hidden = !dirty;
  el.saveBtn.disabled = state.saving;
}

/* ---------------- rendering ---------------- */

function visibleNotes() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.notes;
  return state.notes.filter((n) =>
    (n.title || '').toLowerCase().includes(q) || (n.content || '').toLowerCase().includes(q)
  );
}

function renderList() {
  const items = visibleNotes();
  el.notesCount.textContent = `${state.notes.length} note${state.notes.length === 1 ? '' : 's'}`;
  el.filterNote.hidden = !state.query;
  el.filterNote.textContent = state.query ? `${items.length} match${items.length === 1 ? '' : 'es'}` : '';
  el.listEmpty.hidden = items.length > 0;

  const frag = document.createDocumentFragment();
  for (const note of items) {
    const row = document.createElement('div');
    row.className = 'note-row';
    row.setAttribute('role', 'option');
    row.dataset.id = note.id;
    row.tabIndex = -1;
    if (note.id === state.currentId) {
      row.classList.add('is-active');
      row.setAttribute('aria-selected', 'true');
    }

    const title = document.createElement('div');
    title.className = 'note-row-title';
    title.textContent = displayTitle(note);

    const preview = document.createElement('div');
    preview.className = 'note-row-preview';
    preview.textContent = (note.content || '').replace(/\s+/g, ' ').slice(0, 110);

    const meta = document.createElement('div');
    meta.className = 'note-row-meta';
    meta.textContent = formatDate(stampOf(note));

    row.append(title, preview, meta);
    row.addEventListener('click', () => openNote(note.id));
    frag.appendChild(row);
  }

  el.list.replaceChildren(frag);
}

function renderEditor() {
  const note = state.notes.find((n) => n.id === state.currentId) || null;
  el.deleteBtn.disabled = !note;
  el.copyNoteBtn.disabled = !note;
  el.savedAt.textContent = note ? `saved ${formatDate(stampOf(note))}` : 'not saved yet';
  updateCount();
}

function updateCount() {
  const n = el.editor.value.length;
  el.charCount.textContent = `${n.toLocaleString()} / 10,000`;
  el.charCount.dataset.warn = n > 9500 ? 'high' : '';
}

/* ---------------- data flow ---------------- */

function mergeFromServer(notes, { announce } = {}) {
  const previous = state.known;
  const changed = [];
  const next = new Map();

  for (const note of notes) {
    const stamp = stampOf(note);
    next.set(note.id, stamp);
    if (previous.has(note.id) && previous.get(note.id) !== stamp) changed.push(note);
  }
  const removed = [...previous.keys()].filter((id) => !next.has(id));

  state.notes = notes;
  state.known = next;

  if (announce && (changed.length || removed.length) && !state.dirty) {
    setSync('Updated elsewhere', 'warn');
  } else if (announce) {
    setSync('Up to date', 'ok');
  }

  // Adopt a remote edit only when the open note is clean; never clobber typing.
  if (!state.dirty && state.currentId) {
    const remote = notes.find((n) => n.id === state.currentId);
    if (remote) {
      el.title.value = remote.title || '';
      el.editor.value = remote.content || '';
      updateCount();
    } else {
      startNew({ focus: false });
    }
  }

  renderList();
  renderEditor();
}

async function load({ announce = false, quiet = false } = {}) {
  if (!quiet) setSync('Loading…');
  try {
    const data = await api('GET');
    mergeFromServer(data.notes || [], { announce });
    if (data.stale) setSync('Showing last known copy', 'warn');
    else if (!announce) setSync('Up to date', 'ok');
  } catch (err) {
    if (err.message === 'Unauthorised') return;
    setSync('Offline', 'bad');
    if (!quiet) toast(err.message, 'error');
  }
}

/* ---------------- actions ---------------- */

async function openNote(id) {
  if (state.dirty && !(await confirmDiscard())) return;
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  state.currentId = id;
  el.title.value = note.title || '';
  el.editor.value = note.content || '';
  markDirty(false);
  renderList();
  renderEditor();
  el.app.classList.add('has-selection');
  el.editor.focus();
}

async function startNew({ focus = true } = {}) {
  if (state.dirty && focus && !(await confirmDiscard())) return;
  state.currentId = null;
  el.title.value = '';
  el.editor.value = '';
  markDirty(false);
  renderList();
  renderEditor();
  el.app.classList.add('has-selection');
  if (focus) el.title.focus();
}

function confirmDiscard() {
  return askConfirm(
    'Discard unsaved changes?',
    'This note has edits that are not saved yet. They will be lost.'
  );
}

async function save({ thenNew = false } = {}) {
  if (state.saving) return;
  const title = el.title.value.trim();
  const content = el.editor.value;

  if (!content.trim()) {
    toast('Write something first', 'error');
    el.editor.focus();
    return;
  }

  state.saving = true;
  el.saveBtn.disabled = true;
  el.saveBtn.textContent = 'Saving…';
  setSync('Saving…');

  try {
    const data = state.currentId
      ? await api('PATCH', { id: state.currentId, title, content })
      : await api('POST', { title, content });

    const saved = data.note;
    if (saved) {
      state.notes = [saved, ...state.notes.filter((n) => n.id !== saved.id)];
      state.known.set(saved.id, stampOf(saved));
      state.currentId = saved.id;
      markDirty(false);
      renderList();
      renderEditor();
      el.app.classList.add('has-selection');
    }

    setSync('Saved', 'ok');
    toast('Saved');
    if (thenNew) startNew();
  } catch (err) {
    if (err.message !== 'Unauthorised') {
      setSync('Save failed', 'bad');
      toast(err.message, 'error');
    }
  } finally {
    state.saving = false;
    el.saveBtn.disabled = false;
    el.saveBtn.textContent = 'Save';
  }
}

function askConfirm(title, body) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmBody.textContent = body;
    el.confirm.hidden = false;

    const done = (value) => {
      el.confirm.hidden = true;
      el.confirmOk.removeEventListener('click', onOk);
      el.confirmCancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(false); }
    };

    el.confirmOk.addEventListener('click', onOk);
    el.confirmCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
    el.confirmCancel.focus();
  });
}

async function removeCurrent() {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) return;

  const ok = await askConfirm(
    'Delete this note?',
    `“${displayTitle(note)}” is removed for everyone. This cannot be undone.`
  );
  if (!ok) return;

  try {
    await api('DELETE', { id: note.id });
    state.notes = state.notes.filter((n) => n.id !== note.id);
    state.known.delete(note.id);
    startNew({ focus: false });
    setSync('Deleted', 'ok');
    toast('Note deleted');
  } catch (err) {
    if (err.message !== 'Unauthorised') toast(err.message, 'error');
  }
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch (err) {
    toast('Clipboard blocked by the browser');
  }
}

function copyCurrent() {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) return;
  copy(note.content, 'Note copied');
}

function copyAll() {
  if (!state.notes.length) {
    toast('No notes to copy');
    return;
  }
  const body = state.notes.map((n) => `## ${displayTitle(n)}\n\n${n.content}`).join('\n\n---\n\n');
  copy(`# KartelKoin Notes (${state.notes.length})\n\n${body}`, `${state.notes.length} notes copied`);
}

function lock(message) {
  clearKey();
  stopPolling();
  state.notes = [];
  state.known.clear();
  state.currentId = null;
  state.dirty = false;
  el.app.hidden = true;
  el.lock.hidden = false;
  el.lockError.textContent = message || '';
  el.lockError.hidden = !message;
  el.lockKey.value = '';
  el.lockKey.focus();
}

async function unlock(key, remember) {
  state.key = key;
  el.lockSubmit.disabled = true;
  el.lockSubmit.textContent = 'Checking…';
  el.lockError.hidden = true;

  try {
    const data = await api('GET');
    storeKey(key, remember);
    el.lockRemember.checked = remember;
    el.lock.hidden = true;
    el.app.hidden = false;
    mergeFromServer(data.notes || []);
    setSync('Up to date', 'ok');
    startPolling();
    if (state.notes.length) openNote(state.notes[0].id);
    else startNew();
  } catch (err) {
    state.key = null;
    el.lockError.textContent = err.message === 'Unauthorised'
      ? 'That key was not accepted.'
      : err.message;
    el.lockError.hidden = false;
    el.lockKey.select();
  } finally {
    el.lockSubmit.disabled = false;
    el.lockSubmit.textContent = 'Unlock';
  }
}

/* ---------------- polling ---------------- */

function startPolling() {
  stopPolling();
  state.poll = setInterval(() => {
    if (document.hidden || state.saving || state.dirty) return;
    load({ announce: true, quiet: true });
  }, POLL_MS);
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

/* ---------------- wiring ---------------- */

el.lockForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = el.lockKey.value.trim();
  if (!key) return;
  unlock(key, el.lockRemember.checked);
});

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  save();
});

el.title.addEventListener('input', () => markDirty(true));
el.editor.addEventListener('input', () => { updateCount(); markDirty(true); });

el.newBtn.addEventListener('click', () => startNew());
el.refreshBtn.addEventListener('click', () => load({ announce: true }));
el.copyAllBtn.addEventListener('click', copyAll);
el.copyNoteBtn.addEventListener('click', copyCurrent);
el.deleteBtn.addEventListener('click', removeCurrent);
el.lockBtn.addEventListener('click', () => lock());
el.backBtn.addEventListener('click', () => el.app.classList.remove('has-selection'));

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  renderList();
});

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!el.app.hidden) save();
  } else if (meta && e.key === 'Enter') {
    e.preventDefault();
    if (!el.app.hidden) save({ thenNew: true });
  } else if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!el.app.hidden) el.search.focus();
  } else if (e.key === 'Escape') {
    if (document.activeElement === el.search) {
      el.search.value = '';
      state.query = '';
      renderList();
      el.search.blur();
    }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.key) load({ quiet: true });
});

(function boot() {
  const stored = readStoredKey();
  if (stored) {
    el.lockRemember.checked = stored.remember;
    unlock(stored.key, stored.remember);
  } else {
    el.lock.hidden = false;
    el.lockKey.focus();
  }
})();
