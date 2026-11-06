/* KartelKoin Notes — client
   One file, no dependencies, no build step, no third-party requests.

   Shape of the app:
     - a gate, because the board is private;
     - one list of notes fetched as a single document;
     - an editor that knows whether it is dirty;
     - a search / sort / tag layer that never mutates the store.
   There is no polling. The board is refreshed on focus and after every write,
   which is the only time it can have changed by someone else. */

'use strict';

const API = {
  session: '/api/session',
  notes: '/api/notes',
};

const MAX_CONTENT = 10000;
const MAX_TITLE = 120;

const state = {
  notes: [],
  trash: [],
  version: 0,
  etag: null,
  filter: '',
  sort: 'updated',
  activeTags: new Set(),
  editingId: null,
  dirty: false,
  busy: false,
  composerOpen: true,
  lastSyncedAt: null,
  minLength: 12,
  pinMin: 4,
  pinMax: 12,
  credentialKind: 'passphrase',
};

const el = {};
let dirtySnapshot = '';

/* ------------------------------------------------------------------ helpers */

function $(id) {
  return document.getElementById(id);
}

function formatRelative(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatAbsolute(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  return new Date(then).toLocaleString();
}

/** First meaningful line, used for the card body when the note has no title. */
function preview(content, limit = 220) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function parseTags(raw) {
  return [...new Set(
    String(raw || '')
      .split(',')
      .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(Boolean)
      .slice(0, 8)
  )];
}

/* -------------------------------------------------------------------- toast */

function dismissToast(node) {
  if (!node || !node.isConnected) return;
  node.remove();
}

/**
 * A success message is a neutral notice that leaves by itself. Failures are a
 * separate element, are red, and stay until dismissed — the old build sent
 * both through one error banner, so "Saved" looked like a crash.
 */
function notify(message, options = {}) {
  const region = el.toastRegion;
  if (!region) return;

  const node = document.createElement('div');
  node.className = options.tone === 'error' ? 'toast toast-error' : 'toast';
  node.setAttribute('role', options.tone === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  node.appendChild(text);

  if (options.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.action.label;
    action.addEventListener('click', () => {
      dismissToast(node);
      if (typeof options.action.run === 'function') options.action.run();
    });
    node.appendChild(action);
  }

  // A destructive step is confirmed inside the page, not by window.confirm: the
  // browser dialog puts focus on its OK button, so a stray Enter deletes a note
  // the user only meant to open.
  for (const action of options.actions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.tone === 'danger' ? 'toast-action toast-action-danger' : 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      dismissToast(node);
      // "Keep writing" / "Keep" carry no run() — they mean "do nothing", and
      // calling the missing function threw inside the click handler.
      if (typeof action.run === 'function') action.run();
    });
    node.appendChild(button);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-dismiss';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(node));
  node.appendChild(close);

  // Two saves in a row used to stack identical notices; one is enough.
  for (const existing of [...region.children]) {
    if (existing.querySelector('.toast-text')?.textContent === message) existing.remove();
  }
  region.appendChild(node);

  if (options.tone !== 'error' && !options.sticky) {
    setTimeout(() => dismissToast(node), options.duration || 4000);
  }
  return node;
}

/* --------------------------------------------------------------------- gate */

function showGate() {
  el.gate.hidden = false;
  el.app.hidden = true;
  el.lockBtn.hidden = true;
  el.statusLine.textContent = '';
  el.changeForm.hidden = true;
  el.gateForm.hidden = false;
  requestAnimationFrame(() => el.gatePassphrase.focus());
}

function setMinLength(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 4) state.minLength = Math.floor(parsed);
}

/** Adopts the policy the server reports, so the gate asks for the right thing. */
function applyPolicy(data) {
  if (!data || typeof data !== 'object') return;
  setMinLength(data.minLength);
  const pinMin = Number(data.pinMinLength);
  const pinMax = Number(data.pinMaxLength);
  if (Number.isFinite(pinMin) && pinMin >= 4) state.pinMin = Math.floor(pinMin);
  if (Number.isFinite(pinMax) && pinMax >= state.pinMin) state.pinMax = Math.floor(pinMax);
  if (data.kind === 'pin' || data.kind === 'passphrase') state.credentialKind = data.kind;
  describeGate();
}

/** The gate input follows the stored credential: numeric keypad for a PIN. */
function describeGate() {
  const pin = state.credentialKind === 'pin';
  el.gateLabel.textContent = pin ? 'PIN' : 'Passphrase';
  el.gatePassphrase.setAttribute('inputmode', pin ? 'numeric' : 'text');
  if (pin) el.gatePassphrase.setAttribute('maxlength', String(state.pinMax));
  else el.gatePassphrase.removeAttribute('maxlength');
  el.gateLede.textContent = pin
    ? 'Enter your PIN. It is exchanged for a signed cookie, so it is not stored in this browser after you sign in.'
    : 'Enter your passphrase. It is exchanged for a signed cookie, so it is not stored in this browser after you sign in.';
}

/** Switches the change form between the two credential shapes. */
function useKind(kind) {
  const pin = kind === 'pin';
  el.kindPin.checked = pin;
  el.kindPassphrase.checked = !pin;
  el.changeNextLabel.textContent = pin ? 'New PIN' : 'New passphrase';
  el.changeConfirmLabel.textContent = pin ? 'Repeat the new PIN' : 'Repeat the new passphrase';
  el.changeSubmit.textContent = pin ? 'Save new PIN' : 'Save new passphrase';
  el.changeHint.textContent = pin
    ? `${state.pinMin} to ${state.pinMax} digits. Five wrong attempts start a short lockout, so a four-digit PIN is no longer ten thousand free guesses.`
    : `At least ${state.minLength} characters. A four-digit PIN is available if you prefer it.`;
  for (const input of [el.changeNext, el.changeConfirm]) {
    input.minLength = pin ? state.pinMin : state.minLength;
    input.maxLength = pin ? state.pinMax : 256;
    input.setAttribute('inputmode', pin ? 'numeric' : 'text');
  }
}

function showChangeForm(show) {
  el.gateForm.hidden = show;
  el.changeForm.hidden = !show;
  el.changeError.hidden = true;
  if (show) {
    useKind('pin');
    requestAnimationFrame(() => el.changeCurrent.focus());
  } else {
    describeGate();
    requestAnimationFrame(() => el.gatePassphrase.focus());
  }
}

async function submitCredentialChange() {
  const current = el.changeCurrent.value;
  const next = el.changeNext.value;
  const confirm = el.changeConfirm.value;
  const kind = el.kindPin.checked ? 'pin' : 'passphrase';

  const fail = (message) => {
    el.changeError.textContent = message;
    el.changeError.hidden = false;
  };

  if (!current) return fail('Enter the current PIN or passphrase.');
  if (next !== confirm) return fail('The two entries do not match.');
  if (kind === 'pin') {
    if (!/^\d+$/.test(next)) return fail('A PIN is numbers only.');
    if (next.length < state.pinMin || next.length > state.pinMax) {
      return fail(`A PIN is ${state.pinMin} to ${state.pinMax} digits.`);
    }
  } else if (next.length < state.minLength) {
    return fail(`Use at least ${state.minLength} characters.`);
  }

  el.changeSubmit.disabled = true;
  el.changeSubmit.textContent = 'Saving…';
  try {
    const response = await fetch(API.session, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'change', current, next, kind }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The change could not be saved');

    el.changeCurrent.value = '';
    el.changeNext.value = '';
    el.changeConfirm.value = '';
    applyPolicy(data);
    showChangeForm(false);
    showBoard();
    await loadBoard();
    notify(kind === 'pin' ? 'PIN saved. Other devices are signed out.' : 'Passphrase saved. Other devices are signed out.');
  } catch (err) {
    fail(err.message || 'The change could not be saved');
  } finally {
    el.changeSubmit.disabled = false;
    el.changeSubmit.textContent = kind === 'pin' ? 'Save new PIN' : 'Save new passphrase';
  }
}

function showBoard() {
  el.gate.hidden = true;
  el.app.hidden = false;
  el.lockBtn.hidden = false;
  el.gateError.hidden = true;
}

async function unlock(passphrase) {
  const response = await fetch(API.session, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Could not unlock the board');
    error.status = response.status;
    throw error;
  }
  applyPolicy(data);
  return data;
}

async function lock() {
  try {
    await fetch(API.session, { method: 'DELETE' });
  } catch {
    /* The cookie may already be gone; the local reset below still applies. */
  }
  state.notes = [];
  state.trash = [];
  state.version = 0;
  state.etag = null;
  resetEditor();
  el.notesGrid.replaceChildren();
  showGate();
  notify('Locked. The board is hidden on this device.');
}

/* -------------------------------------------------------------------- store */

function applyBoard(data) {
  state.notes = Array.isArray(data.notes) ? data.notes : [];
  state.trash = Array.isArray(data.trash) ? data.trash : [];
  state.version = Number(data.version) || 0;
  state.lastSyncedAt = new Date();
  render();
}

async function loadBoard({ quiet = false } = {}) {
  if (!quiet) setLoading(true);
  try {
    const headers = {};
    if (quiet && state.etag) headers['If-None-Match'] = state.etag;

    const response = await fetch(API.notes, { headers, cache: 'no-store' });

    if (response.status === 401) {
      showGate();
      return;
    }
    if (response.status === 304) {
      state.lastSyncedAt = new Date();
      updateStatus();
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The board could not be loaded');
    }

    state.etag = response.headers.get('ETag') || state.etag;
    applyBoard(await response.json());
    showBoard();
    updateStatus();
  } catch (err) {
    notify(err.message || 'The board could not be loaded', { tone: 'error' });
  } finally {
    setLoading(false);
  }
}

function setLoading(show) {
  el.loading.hidden = !show;
  if (show) {
    el.empty.hidden = true;
    el.noResults.hidden = true;
  }
}

function updateStatus() {
  if (!state.lastSyncedAt) {
    el.statusLine.textContent = '';
    return;
  }
  const count = state.notes.length;
  el.statusLine.textContent = `${count} note${count === 1 ? '' : 's'} · synced ${formatRelative(state.lastSyncedAt.toISOString())}`;
}

/* ------------------------------------------------------------------ render */

function visibleNotes() {
  const query = state.filter.trim().toLowerCase();

  let list = state.notes.filter((note) => {
    if (state.activeTags.size) {
      const tags = note.tags || [];
      for (const tag of state.activeTags) {
        if (!tags.includes(tag)) return false;
      }
    }
    if (!query) return true;
    return (
      String(note.title || '').toLowerCase().includes(query) ||
      String(note.content || '').toLowerCase().includes(query) ||
      (note.tags || []).some((tag) => tag.includes(query))
    );
  });

  list = list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    switch (state.sort) {
      case 'created':
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      case 'oldest':
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      case 'title':
        return String(a.title).localeCompare(String(b.title));
      default:
        return Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt);
    }
  });

  return list;
}

// A blank title is normal — the author typed straight into the body. Show the
// first meaningful line instead, and keep "Untitled note" for a note that is
// genuinely empty. Matches deriveTitle() in lib/notes.js so the card, the
// editor heading, the trash list and the export all agree.
function displayTitle(note) {
  if (note && note.title) return note.title;
  const firstLine = String((note && note.content) || '')
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'Untitled note';
  return firstLine.length > 60 ? `${firstLine.slice(0, 60).trimEnd()}…` : firstLine;
}

function buildCard(note) {
  const item = document.createElement('li');
  item.className = 'note-card';
  item.dataset.id = note.id;
  if (note.id === state.editingId) item.classList.add('is-open');

  const head = document.createElement('div');
  head.className = 'note-card-head';

  const title = document.createElement('h3');
  title.className = 'note-card-title';
  title.textContent = displayTitle(note);
  head.appendChild(title);

  if (note.pinned) {
    const pin = document.createElement('span');
    pin.className = 'pin-flag';
    pin.textContent = 'Pinned';
    head.appendChild(pin);
  }

  item.appendChild(head);

  const body = document.createElement('p');
  body.className = 'note-card-body';
  body.textContent = preview(note.content);
  item.appendChild(body);

  if (Array.isArray(note.tags) && note.tags.length) {
    const tags = document.createElement('ul');
    tags.className = 'note-tags';
    for (const tag of note.tags) {
      const li = document.createElement('li');
      li.className = 'note-tag';
      li.textContent = tag;
      tags.appendChild(li);
    }
    item.appendChild(tags);
  }

  const foot = document.createElement('div');
  foot.className = 'note-card-foot';

  const time = document.createElement('time');
  time.className = 'note-card-time';
  time.dateTime = note.updatedAt || note.createdAt;
  time.title = formatAbsolute(note.updatedAt || note.createdAt);
  time.textContent = formatRelative(note.updatedAt || note.createdAt);
  foot.appendChild(time);

  // A real button: focusable, Enter/Space activate it, the focus ring is the
  // browser's. The whole card is still clickable as a convenience, but the
  // keyboard path never depends on that.
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'note-card-open';
  open.textContent = note.id === state.editingId ? 'Editing' : 'Open';
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    openNote(note.id);
  });
  foot.appendChild(open);

  item.appendChild(foot);

  item.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openNote(note.id);
  });

  return item;
}

function render() {
  const list = visibleNotes();
  const total = state.notes.length;

  el.notesCount.textContent = String(total);

  const grid = el.notesGrid;
  grid.replaceChildren();

  if (total === 0) {
    el.empty.hidden = false;
    el.noResults.hidden = true;
    el.loading.hidden = true;
  } else if (list.length === 0) {
    el.empty.hidden = true;
    el.noResults.hidden = false;
    el.loading.hidden = true;
  } else {
    el.empty.hidden = true;
    el.noResults.hidden = true;
    el.loading.hidden = true;
    const fragment = document.createDocumentFragment();
    for (const note of list) fragment.appendChild(buildCard(note));
    grid.appendChild(fragment);
  }

  renderTagFilter();
  renderTrash();
  updateStatus();
  syncEditorChrome();
}

function renderTagFilter() {
  const counts = new Map();
  for (const note of state.notes) {
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }

  const container = el.tagFilter;
  container.replaceChildren();

  if (counts.size === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  for (const [tag, count] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip';
    chip.textContent = `${tag} ${count}`;
    chip.setAttribute('aria-pressed', String(state.activeTags.has(tag)));
    chip.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      render();
    });
    container.appendChild(chip);
  }
}

function renderTrash() {
  const trash = state.trash || [];
  el.trash.hidden = trash.length === 0;
  el.trashCount.textContent = String(trash.length);

  const list = el.trashList;
  list.replaceChildren();

  for (const entry of trash) {
    const row = document.createElement('li');
    row.className = 'trash-row';

    const title = document.createElement('span');
    title.className = 'trash-row-title';
    title.textContent = displayTitle(entry);
    title.title = `Deleted ${formatAbsolute(entry.deletedAt)}`;
    row.appendChild(title);

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'ghost-btn';
    restore.textContent = 'Restore';
    restore.addEventListener('click', () => restoreNote(entry.id));
    row.appendChild(restore);

    list.appendChild(row);
  }
}

/* ------------------------------------------------------------------ editor */

function currentDraft() {
  return {
    title: el.titleInput.value,
    content: el.editor.value,
    tags: el.noteTags.value,
  };
}

function snapshot() {
  const draft = currentDraft();
  return `${draft.title}\u0000${draft.content}\u0000${draft.tags}`;
}

function markClean() {
  dirtySnapshot = snapshot();
  state.dirty = false;
}

function updateDirty() {
  state.dirty = snapshot() !== dirtySnapshot;
  syncEditorChrome();
}

function syncEditorChrome() {
  const editing = state.editingId
    ? state.notes.find((note) => note.id === state.editingId)
    : null;

  el.editingBanner.hidden = !editing;
  if (editing) {
    el.editingTitle.textContent = displayTitle(editing);
    el.saveBtn.textContent = 'Update note';
  } else {
    el.saveBtn.textContent = 'Save note';
  }

  el.composerHeading.textContent = editing ? 'Editing note' : 'New note';
}

function fillEditor({ title = '', content = '', tags = [] }) {
  el.titleInput.value = title;
  el.editor.value = content;
  el.noteTags.value = tags.join(', ');
  updateCounter();
  markClean();
}

function resetEditor() {
  state.editingId = null;
  fillEditor({});
  el.composerOpen = true;
  el.composerBody.hidden = false;
  el.composerToggle.textContent = 'Collapse';
  el.composerToggle.setAttribute('aria-expanded', 'true');
  syncEditorChrome();
}

function updateCounter() {
  const length = el.editor.value.length;
  el.charCount.textContent = `${length.toLocaleString()} / ${MAX_CONTENT.toLocaleString()}`;
  el.charCount.classList.toggle('warn', length > MAX_CONTENT * 0.9);
}

/**
 * Runs `run` now, or after the user confirms on a sticky notice. Never
 * window.confirm: the browser focuses its OK button, so one stray Enter throws
 * away a draft that was only half written.
 */
function guardDraft(run) {
  if (!state.dirty) {
    run();
    return;
  }
  notify('This draft has unsaved changes. Discard them?', {
    sticky: true,
    actions: [
      { label: 'Discard', tone: 'danger', run: () => { markClean(); run(); } },
      { label: 'Keep writing' },
    ],
  });
}

function openNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (state.editingId === id) {
    el.editor.focus();
    return;
  }
  guardDraft(() => openNoteNow(note));
}

function openNoteNow(note) {
  state.editingId = note.id;
  fillEditor(note);
  syncEditorChrome();
  render();

  el.composerBody.hidden = false;
  state.composerOpen = true;
  el.composerToggle.textContent = 'Collapse';
  el.composerToggle.setAttribute('aria-expanded', 'true');

  const target = el.titleInput.getBoundingClientRect();
  if (target.top < 0) {
    el.composerForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  el.titleInput.focus();
  el.titleInput.select();
}

function startNewDraft() {
  guardDraft(() => {
    resetEditor();
    render();
    el.titleInput.focus();
  });
}

async function saveNote() {
  if (state.busy) return;

  const title = el.titleInput.value.trim();
  const content = el.editor.value.trim();
  const tags = parseTags(el.noteTags.value);

  if (!content) {
    notify('A note needs some text before it can be saved.', { tone: 'error' });
    el.editor.focus();
    return;
  }
  if (title.length > MAX_TITLE) {
    notify(`Titles are capped at ${MAX_TITLE} characters.`, { tone: 'error' });
    el.titleInput.focus();
    return;
  }

  state.busy = true;
  el.saveBtn.disabled = true;
  el.saveBtn.textContent = 'Saving…';

  try {
    const editing = state.editingId
      ? state.notes.find((note) => note.id === state.editingId)
      : null;

    const payload = editing
      ? { id: editing.id, title, content, tags, version: editing.version }
      : { title, content, tags };

    const response = await fetch(API.notes, {
      method: editing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      showGate();
      throw new Error('Your session expired. Unlock the board again.');
    }
    if (response.status === 409) {
      throw new Error('This note changed somewhere else. Reload the board before saving over it.');
    }
    if (response.status === 413) {
      throw new Error('That note is over the size limit.');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The note could not be saved');

    state.etag = response.headers.get('ETag') || state.etag;
    applyBoard(data);

    // Stay on the saved note so a second Ctrl+S does not create a duplicate.
    const saved = state.notes.find((note) =>
      editing ? note.id === editing.id : note.title === (title || '') || note.content === content
    );
    state.editingId = saved ? saved.id : null;
    fillEditor(saved || { title, content, tags });
    syncEditorChrome();
    render();

    notify(editing ? 'Changes saved.' : 'Note saved.');
  } catch (err) {
    notify(err.message || 'The note could not be saved', { tone: 'error' });
  } finally {
    state.busy = false;
    el.saveBtn.disabled = false;
    syncEditorChrome();
  }
}

async function deleteNote(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;

  try {
    const response = await fetch(API.notes, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });

    if (response.status === 401) {
      showGate();
      throw new Error('Your session expired.');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The note could not be deleted');

    state.etag = response.headers.get('ETag') || state.etag;
    if (state.editingId === id) resetEditor();
    applyBoard(data);

    notify('Moved to the trash.', {
      duration: 8000,
      action: { label: 'Undo', run: () => restoreNote(id) },
    });
  } catch (err) {
    notify(err.message || 'The note could not be deleted', { tone: 'error' });
  }
}

function confirmTrash(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  notify(`Move “${displayTitle(note)}” to the trash?`, {
    sticky: true,
    actions: [
      { label: 'Move to trash', tone: 'danger', run: () => deleteNote(note.id) },
      { label: 'Keep' },
    ],
  });
}

async function restoreNote(id) {
  try {
    const response = await fetch(API.notes, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'restore', id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The note could not be restored');

    state.etag = response.headers.get('ETag') || state.etag;
    applyBoard(data);
    notify('Note restored.');
  } catch (err) {
    notify(err.message || 'The note could not be restored', { tone: 'error' });
  }
}

function exportNotes() {
  if (state.notes.length === 0) {
    notify('There is nothing to export yet.', { tone: 'error' });
    return;
  }
  const body = state.notes
    .map((note) => {
      const tags = note.tags && note.tags.length ? `\n_tags: ${note.tags.join(', ')}_` : '';
      return `## ${displayTitle(note)}${tags}\n\n${note.content}`;
    })
    .join('\n\n---\n\n');

  const blob = new Blob(
    [`# KartelKoin Notes — ${new Date().toISOString().slice(0, 10)}\n\n${body}\n`],
    { type: 'text/markdown' }
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `kartelkoin-notes-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  notify(`Exported ${state.notes.length} notes as Markdown.`);
}

/* ------------------------------------------------------------------- events */

function bindEvents() {
  el.gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = el.gatePassphrase.value;
    if (!value) {
      el.gateError.textContent = 'Enter your PIN or passphrase.';
      el.gateError.hidden = false;
      el.gatePassphrase.focus();
      return;
    }

    el.gateSubmit.disabled = true;
    el.gateSubmit.textContent = 'Unlocking…';
    el.gateError.hidden = true;

    try {
      await unlock(value);
      el.gatePassphrase.value = '';
      showBoard();
      await loadBoard();
    } catch (err) {
      el.gateError.textContent = err.message || 'Could not unlock the board';
      el.gateError.hidden = false;
      el.gatePassphrase.select();
    } finally {
      el.gateSubmit.disabled = false;
      el.gateSubmit.textContent = 'Unlock board';
    }
  });

  el.lockBtn.addEventListener('click', lock);

  el.gateChangeToggle.addEventListener('click', () => showChangeForm(true));
  el.kindPin.addEventListener('change', () => useKind('pin'));
  el.kindPassphrase.addEventListener('change', () => useKind('passphrase'));
  el.changeCancel.addEventListener('click', () => showChangeForm(false));
  el.changeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCredentialChange();
  });

  el.composerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveNote();
  });

  el.newBtn.addEventListener('click', startNewDraft);
  el.cancelEdit.addEventListener('click', () => {
    guardDraft(() => {
      resetEditor();
      render();
    });
  });
  el.deleteBtn.addEventListener('click', () => {
    if (state.editingId) confirmTrash(state.editingId);
  });

  el.composerToggle.addEventListener('click', () => {
    state.composerOpen = !state.composerOpen;
    el.composerBody.hidden = !state.composerOpen;
    el.composerToggle.textContent = state.composerOpen ? 'Collapse' : 'Expand';
    el.composerToggle.setAttribute('aria-expanded', String(state.composerOpen));
  });

  el.editor.addEventListener('input', () => {
    updateCounter();
    updateDirty();
  });
  el.titleInput.addEventListener('input', updateDirty);
  el.noteTags.addEventListener('input', updateDirty);

  el.search.addEventListener('input', () => {
    state.filter = el.search.value;
    render();
  });

  el.sort.addEventListener('change', () => {
    state.sort = el.sort.value;
    render();
  });

  el.exportBtn.addEventListener('click', exportNotes);

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!el.app.hidden) saveNote();
      return;
    }

    if (event.key === '/' && !typing && !el.app.hidden) {
      event.preventDefault();
      el.search.focus();
      el.search.select();
      return;
    }

    if (event.key === 'Escape' && document.activeElement === el.search) {
      el.search.value = '';
      state.filter = '';
      render();
      el.search.blur();
    }
  });

  // A draft must not vanish because the tab was closed or reloaded.
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Refresh when the tab comes back, instead of polling every two seconds.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !el.app.hidden) loadBoard({ quiet: true });
  });
  window.addEventListener('focus', () => {
    if (!el.app.hidden) loadBoard({ quiet: true });
  });

  // A second tab on the same board should not fight this one.
  window.addEventListener('storage', (event) => {
    if (event.key === 'kk:board' && !el.app.hidden) loadBoard({ quiet: true });
  });
}

function cacheElements() {
  el.gate = $('gate');
  el.gateForm = $('gate-form');
  el.gatePassphrase = $('gate-passphrase');
  el.gateLabel = $('gate-label');
  el.gateLede = $('gate-lede');
  el.gateSubmit = $('gate-submit');
  el.gateError = $('gate-error');
  el.gateChangeToggle = $('gate-change-toggle');

  el.changeForm = $('change-form');
  el.changeCurrent = $('change-current');
  el.changeNext = $('change-next');
  el.changeConfirm = $('change-confirm');
  el.kindPin = $('kind-pin');
  el.kindPassphrase = $('kind-passphrase');
  el.changeNextLabel = $('change-next-label');
  el.changeConfirmLabel = $('change-confirm-label');
  el.changeHint = $('change-hint');
  el.changeError = $('change-error');
  el.changeSubmit = $('change-submit');
  el.changeCancel = $('change-cancel');

  el.app = $('app');
  el.statusLine = $('status-line');
  el.lockBtn = $('lock-btn');

  el.composerForm = $('composer-form');
  el.composerBody = $('composer-body');
  el.composerToggle = $('composer-toggle');
  el.composerHeading = $('composer-heading');
  el.titleInput = $('note-title');
  el.editor = $('note-editor');
  el.noteTags = $('note-tags');
  el.charCount = $('char-count');
  el.saveBtn = $('save-btn');
  el.newBtn = $('new-btn');
  el.editingBanner = $('editing-banner');
  el.editingTitle = $('editing-title');
  el.cancelEdit = $('cancel-edit');
  el.deleteBtn = $('delete-btn');

  el.notesCount = $('notes-count');
  el.notesGrid = $('notes-grid');
  el.loading = $('loading');
  el.empty = $('empty');
  el.noResults = $('no-results');
  el.search = $('search');
  el.sort = $('sort');
  el.exportBtn = $('export-btn');
  el.tagFilter = $('tag-filter');

  el.trash = $('trash');
  el.trashCount = $('trash-count');
  el.trashList = $('trash-list');

  el.toastRegion = $('toast-region');
}

async function init() {
  cacheElements();
  bindEvents();
  updateCounter();
  markClean();

  // Ask the server whether this browser already holds a valid session, rather
  // than assuming and flashing the board before a 401.
  try {
    const response = await fetch(API.session, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    applyPolicy(data);
    if (data.authenticated) {
      showBoard();
      await loadBoard();
      return;
    }
    if (data.configured === false) {
      el.gateError.textContent = 'This board has no PIN or passphrase configured yet.';
      el.gateError.hidden = false;
    }
  } catch {
    /* Fall through to the gate; the unlock attempt will surface the error. */
  }

  showGate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
