/* KartelKoin Notes — client
   One file, no dependencies, no build step, no third-party requests.

   Shape of the app:
     - a gate, because the board is private, with one cell per stored digit;
     - one list of notes fetched as a single document;
     - an editor sheet that knows whether it is dirty;
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
const TOAST_MS = 4000;

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
  lastSyncedAt: null,
  minLength: 12,
  pinMin: 4,
  pinMax: 12,
  pinLength: null,
  credentialKind: 'passphrase',
  returnFocus: null,
  deleteTimer: null,
  deleteArmed: false,
};

const el = {};
let dirtySnapshot = '';
let toastQueue = null;
let pinnedHeight = false;

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

/** The mono date gutter: "NOV 06". */
function formatDay(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  return new Date(then)
    .toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    .toUpperCase();
}

/** First meaningful line, used for the row body when the note has no title. */
function preview(content, limit = 240) {
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

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* -------------------------------------------------------------------- toast */

/**
 * One notice at a time, in one live region. The queue decides what is visible;
 * this file only paints it. A burst of saves bumps a "+N" counter instead of
 * stacking cards over the editor.
 */
function notify(message, options = {}) {
  if (!toastQueue) return;
  toastQueue.push({
    message,
    detail: options.detail || '',
    tone: options.tone === 'error' ? 'error' : 'ok',
    action: options.action || null,
    sticky: options.sticky === true,
    buttons: options.actions || [],
  });
}

function renderToast(toast) {
  const region = el.toastRegion;
  if (!region) return;
  region.replaceChildren();
  if (!toast) return;

  const node = document.createElement('div');
  node.className = toast.tone === 'error' ? 'toast toast-error' : 'toast';

  const icon = document.createElement('span');
  icon.className = 'toast-ico';
  icon.setAttribute('aria-hidden', 'true');
  node.appendChild(icon);

  const body = document.createElement('div');
  body.className = 'toast-body';

  const title = document.createElement('b');
  title.textContent = toast.message;
  body.appendChild(title);

  if (toast.detail) {
    const detail = document.createElement('p');
    detail.textContent = toast.detail;
    body.appendChild(detail);
  }

  if (toast.action) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = toast.action.label;
    action.addEventListener('click', () => {
      toastQueue.dismiss();
      if (typeof toast.action.run === 'function') toast.action.run();
    });
    body.appendChild(action);
  }

  for (const extra of toast.buttons || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = extrasTone(extra) ? 'toast-action toast-action-danger' : 'toast-action';
    button.textContent = extra.label;
    button.addEventListener('click', () => {
      toastQueue.dismiss();
      if (typeof extra.run === 'function') extra.run();
    });
    body.appendChild(button);
  }

  node.appendChild(body);

  if (toastQueue.extra > 0) {
    const pill = document.createElement('span');
    pill.className = 'toast-extra';
    pill.textContent = `+${toastQueue.extra}`;
    node.appendChild(pill);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-dismiss';
  close.setAttribute('aria-label', 'Dismiss message');
  close.textContent = '×';
  close.addEventListener('click', () => toastQueue.dismiss());
  node.appendChild(close);

  region.appendChild(node);
}

function extrasTone(action) {
  return action.tone === 'danger';
}

/* --------------------------------------------------------------------- gate */

function showGate() {
  el.gate.hidden = false;
  el.app.hidden = true;
  el.lockBtn.hidden = true;
  el.statusLine.textContent = '';
  el.fab.hidden = true;
  el.changeForm.hidden = true;
  el.gateForm.hidden = false;
  closeEditor({ force: true, restoreFocus: false });
  requestAnimationFrame(() => focusGateInput());
}

function focusGateInput() {
  el.gatePassphrase.focus();
  const end = el.gatePassphrase.value.length;
  try {
    el.gatePassphrase.setSelectionRange(end, end);
  } catch {
    /* A password field can refuse; focus is the part that matters. */
  }
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

  const length = Number(data.pinLength);
  state.pinLength = state.credentialKind === 'pin' && Number.isInteger(length) && length >= 4 && length <= state.pinMax
    ? length
    : null;

  describeGate();
}

/** One cell per stored digit, but only when six fit. Longer PINs use one field. */
function usesCells() {
  return state.credentialKind === 'pin' && state.pinLength !== null && state.pinLength <= 6;
}

function describeGate() {
  const pin = state.credentialKind === 'pin';
  el.gateLabel.textContent = pin ? 'PIN' : 'Passphrase';
  el.gateHeading.textContent = pin ? 'Enter your PIN' : 'Enter your passphrase';
  el.gateLede.textContent = pin
    ? 'It is exchanged for a signed cookie, so the digits are not stored in this browser after you sign in.'
    : 'It is exchanged for a signed cookie, so it is not stored in this browser after you sign in.';

  if (pin) {
    el.gatePassphrase.setAttribute('inputmode', 'numeric');
    el.gatePassphrase.setAttribute('maxlength', String(state.pinLength || state.pinMax));
    el.gatePassphrase.setAttribute('aria-label', state.pinLength ? `${state.pinLength}-digit PIN` : 'PIN');
  } else {
    el.gatePassphrase.setAttribute('inputmode', 'text');
    el.gatePassphrase.removeAttribute('maxlength');
    el.gatePassphrase.setAttribute('aria-label', 'Passphrase');
  }

  const cells = usesCells();
  el.pinWrap.classList.toggle('cells', cells);
  el.pinCells.hidden = !cells;

  if (cells) buildPinCells();
  updatePinProgress();
  clearGateError();
}

function buildPinCells() {
  const count = state.pinLength || 0;
  const value = el.gatePassphrase.value.slice(0, count);
  const cells = el.pinCells;
  cells.replaceChildren();

  for (let index = 0; index < count; index += 1) {
    const cell = document.createElement('div');
    cell.className = 'pin-cell';
    if (index < value.length) {
      cell.classList.add('filled');
      cell.appendChild(document.createElement('i'));
    } else if (index === value.length) {
      cell.classList.add('active');
    }
    cells.appendChild(cell);
  }
}

function updatePinProgress() {
  if (state.credentialKind !== 'pin') {
    el.gateProgress.hidden = true;
    el.gateProgress.textContent = '';
    return;
  }
  el.gateProgress.hidden = false;
  const length = el.gatePassphrase.value.length;
  el.gateProgress.textContent = state.pinLength
    ? `${Math.min(length, state.pinLength)} of ${state.pinLength}`
    : `${length} digit${length === 1 ? '' : 's'}`;
}

function clearGateError() {
  el.gateError.hidden = true;
  el.gateError.textContent = '';
  el.pinWrap.classList.remove('is-error');
}

function showGateError(message, { shake = false } = {}) {
  el.gateError.textContent = message;
  el.gateError.hidden = false;
  el.pinWrap.classList.add('is-error');

  if (shake && !prefersReducedMotion()) {
    const target = usesCells() ? el.pinCells : el.pinWrap;
    target.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(0)' }],
      { duration: 340, easing: 'ease-in-out' }
    );
  }
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
    requestAnimationFrame(() => focusGateInput());
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
    notify(kind === 'pin' ? 'PIN saved' : 'Passphrase saved', {
      detail: 'Other devices are signed out.',
    });
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
  el.fab.hidden = false;
  clearGateError();
}

async function unlock(credential) {
  const response = await fetch(API.session, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: credential }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Could not unlock the board');
    error.status = response.status;
    error.retryAfter = Number(data.retryAfter) || 0;
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
  notify('Locked', { detail: 'The board is hidden on this device.' });
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
    notify('The board could not be loaded', { tone: 'error', detail: err.message || '' });
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
    if (a.done !== b.done) return a.done ? 1 : -1;
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
// genuinely empty. Matches deriveTitle() in lib/notes.js so the row, the
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

function buildRow(note) {
  const item = document.createElement('li');
  item.className = 'row';
  item.dataset.id = note.id;
  item.classList.toggle('done', note.done === true);
  if (note.id === state.editingId) item.classList.add('sel');
  if (note.id === state.editingId) item.setAttribute('aria-current', 'true');

  const date = document.createElement('div');
  date.className = 'row-date';
  date.textContent = formatDay(note.updatedAt || note.createdAt);
  date.title = `Updated ${formatAbsolute(note.updatedAt || note.createdAt)}`;
  item.appendChild(date);

  const main = document.createElement('div');
  main.className = 'row-main';

  const titleLine = document.createElement('div');
  titleLine.className = 'row-title';

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(note.done === true));
  check.setAttribute('aria-label', `Mark “${displayTitle(note)}” as ${note.done ? 'open' : 'done'}`);
  check.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDone(note.id);
  });
  titleLine.appendChild(check);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'row-title-btn';
  const label = document.createElement('span');
  label.className = 'row-title-text';
  label.textContent = displayTitle(note);
  open.appendChild(label);
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    openNote(note.id, open);
  });
  titleLine.appendChild(open);

  main.appendChild(titleLine);

  const body = document.createElement('p');
  body.className = 'excerpt';
  // A legacy note may have no stored title; the heading already shows its first
  // line, so do not print that line twice.
  body.textContent = preview(note.title ? note.content : String(note.content || '').split('\n').slice(1).join('\n'));
  main.appendChild(body);

  if (Array.isArray(note.tags) && note.tags.length) {
    const tags = document.createElement('ul');
    tags.className = 'row-tags';
    for (const tag of note.tags) {
      const li = document.createElement('li');
      li.className = 'tag';
      li.textContent = tag;
      tags.appendChild(li);
    }
    main.appendChild(tags);
  }

  item.appendChild(main);

  const status = document.createElement('div');
  status.className = 'row-status';
  if (note.id === state.editingId) status.textContent = 'Editing';
  else if (note.done) status.textContent = 'Done';
  else if (note.pinned) status.textContent = 'Pinned';
  else status.textContent = 'Open';
  item.appendChild(status);

  item.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openNote(note.id, item);
  });

  return item;
}

function render() {
  const list = visibleNotes();
  const total = state.notes.length;
  const doneCount = state.notes.filter((note) => note.done === true).length;

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
    let dividerAdded = false;
    for (const note of list) {
      if (note.done && !dividerAdded) {
        dividerAdded = true;
        fragment.appendChild(buildDoneDivider(doneCount));
      }
      fragment.appendChild(buildRow(note));
    }
    grid.appendChild(fragment);
  }

  renderTags();
  renderTrash();
  updateStatus();
  syncEditorChrome();
}

function buildDoneDivider(count) {
  const item = document.createElement('li');
  item.className = 'ledger-divider';
  item.textContent = `Done ${count}`;
  return item;
}

/** One set of counts drives both the chip row and the aside list. */
function renderTags() {
  const counts = new Map();
  for (const note of state.notes) {
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const chips = el.tagFilter;
  const aside = el.tagAside;
  chips.replaceChildren();
  aside.replaceChildren();

  chips.hidden = tags.length === 0;
  if (tags.length === 0) return;

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip';
  all.classList.toggle('on', state.activeTags.size === 0);
  all.setAttribute('aria-pressed', String(state.activeTags.size === 0));
  all.textContent = 'All ';
  const allCount = document.createElement('b');
  allCount.textContent = String(state.notes.length);
  all.appendChild(allCount);
  all.addEventListener('click', () => {
    state.activeTags.clear();
    render();
  });
  chips.appendChild(all);

  for (const [tag, count] of tags) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.classList.toggle('on', state.activeTags.has(tag));
    chip.setAttribute('aria-pressed', String(state.activeTags.has(tag)));
    chip.textContent = tag;
    const number = document.createElement('b');
    number.textContent = String(count);
    chip.appendChild(number);
    chip.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      render();
    });
    chips.appendChild(chip);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tagrow';
    row.setAttribute('aria-pressed', String(state.activeTags.has(tag)));
    row.textContent = tag;
    const badge = document.createElement('b');
    badge.textContent = String(count);
    row.appendChild(badge);
    row.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      render();
    });
    aside.appendChild(row);
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
    content: el.editorArea.value,
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
}

function syncEditorChrome() {
  const editing = state.editingId
    ? state.notes.find((note) => note.id === state.editingId)
    : null;

  el.editingBanner.hidden = !editing;
  if (editing) {
    el.editingTitle.textContent = displayTitle(editing);
    el.composerHeading.textContent = displayTitle(editing);
    el.composerKicker.textContent = 'Editing note';
    el.saveBtn.textContent = 'Update note';
  } else {
    el.composerHeading.textContent = 'New note';
    el.composerKicker.textContent = 'Compose';
    el.saveBtn.textContent = 'Save note';
  }
  resetDeleteButton();
}

function fillEditor({ title = '', content = '', tags = [] }) {
  el.titleInput.value = title;
  el.editorArea.value = content;
  el.noteTags.value = tags.join(', ');
  updateCounter();
  markClean();
}

function resetEditor() {
  state.editingId = null;
  fillEditor({});
  syncEditorChrome();
}

function updateCounter() {
  const length = el.editorArea.value.length;
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
  notify('Discard this draft?', {
    sticky: true,
    detail: 'It has unsaved changes.',
    actions: [
      { label: 'Discard', tone: 'danger', run: () => { markClean(); run(); } },
      { label: 'Keep writing' },
    ],
  });
}

function openEditor(trigger) {
  state.returnFocus = trigger || document.activeElement;
  if (!el.sheet.open) el.sheet.show();
  requestAnimationFrame(() => {
    el.titleInput.focus();
    el.titleInput.select();
  });
}

function closeEditor({ force = false, restoreFocus = true } = {}) {
  if (!el.sheet.open) return;
  if (!force && state.dirty) {
    guardDraft(() => closeEditor({ force: true }));
    return;
  }
  el.sheet.close();
  resetDeleteButton();
  if (restoreFocus) {
    const target = state.returnFocus;
    state.returnFocus = null;
    if (target && target.isConnected) target.focus();
    else el.newNote.focus();
  } else {
    state.returnFocus = null;
  }
}

function openNote(id, trigger) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (state.editingId === id && el.sheet.open) {
    el.editorArea.focus();
    return;
  }
  guardDraft(() => openNoteNow(note, trigger));
}

function openNoteNow(note, trigger) {
  state.editingId = note.id;
  fillEditor(note);
  syncEditorChrome();
  render();
  openEditor(trigger);
}

function startNewDraft(trigger) {
  guardDraft(() => {
    resetEditor();
    render();
    openEditor(trigger);
  });
}

async function saveNote() {
  if (state.busy) return;

  const title = el.titleInput.value.trim();
  const content = el.editorArea.value.trim();
  const tags = parseTags(el.noteTags.value);

  if (!content) {
    notify('A note needs some text before it can be saved.', { tone: 'error' });
    el.editorArea.focus();
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

  const trigger = state.returnFocus;

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

    resetEditor();
    render();
    closeEditor({ force: true, restoreFocus: false });
    if (trigger && trigger.isConnected) trigger.focus();
    else el.newNote.focus();

    notify(editing ? 'Changes saved' : 'Note saved', {
      detail: `${state.notes.length} note${state.notes.length === 1 ? '' : 's'} · just now`,
    });
  } catch (err) {
    notify('The note could not be saved', { tone: 'error', detail: err.message || '' });
  } finally {
    state.busy = false;
    el.saveBtn.disabled = false;
    syncEditorChrome();
  }
}

/* ---------------------------------------------------------------- done state */

async function toggleDone(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  const button = el.notesGrid.querySelector(`[data-id="${cssEscape(id)}"] .check`);
  if (button) button.disabled = true;

  try {
    const response = await fetch(API.notes, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, version: note.version, done: !note.done }),
    });

    if (response.status === 401) {
      showGate();
      throw new Error('Your session expired.');
    }

    const data = await response.json().catch(() => ({}));
    if (response.status === 409) throw new Error('This note changed somewhere else. Reload the board.');
    if (!response.ok) throw new Error(data.error || 'The note could not be updated');

    state.etag = response.headers.get('ETag') || state.etag;
    applyBoard(data);
    // The row is rebuilt, so put the keyboard back where it was.
    const restored = el.notesGrid.querySelector(`[data-id="${cssEscape(id)}"] .check`);
    if (restored) restored.focus();
  } catch (err) {
    notify('The note could not be updated', { tone: 'error', detail: err.message || '' });
    if (button && button.isConnected) button.disabled = false;
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
}

/* -------------------------------------------------------------------- trash */

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
    if (state.editingId === id) {
      resetEditor();
      closeEditor({ force: true });
    }
    applyBoard(data);

    notify('Moved to trash', {
      detail: 'Restore it for 30 days.',
      action: { label: 'Undo', run: () => restoreNote(id) },
    });
  } catch (err) {
    notify('The note could not be deleted', { tone: 'error', detail: err.message || '' });
  }
}

/**
 * In-place confirmation: the button becomes "Confirm?" for four seconds, then
 * reverts. No dialog, so a stray Enter on a focused OK button cannot delete.
 */
function resetDeleteButton() {
  if (state.deleteTimer) {
    clearTimeout(state.deleteTimer);
    state.deleteTimer = null;
  }
  state.deleteArmed = false;
  if (!el.deleteBtn) return;
  el.deleteBtn.textContent = 'Move to trash';
  el.deleteBtn.classList.remove('armed');
  el.deleteBtn.setAttribute('aria-label', 'Move this note to trash');
}

function armDelete() {
  if (!state.editingId) return;
  if (state.deleteArmed) {
    resetDeleteButton();
    deleteNote(state.editingId);
    return;
  }
  state.deleteArmed = true;
  el.deleteBtn.textContent = 'Confirm?';
  el.deleteBtn.classList.add('armed');
  el.deleteBtn.setAttribute('aria-label', 'Confirm moving this note to trash');
  state.deleteTimer = setTimeout(resetDeleteButton, 4000);
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
    notify('Note restored');
  } catch (err) {
    notify('The note could not be restored', { tone: 'error', detail: err.message || '' });
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
  notify(`Exported ${state.notes.length} notes as Markdown`);
}

/* ------------------------------------------------------------------- events */

function bindEvents() {
  el.gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (el.gateSubmit.disabled) return;

    const value = el.gatePassphrase.value;
    if (!value) {
      showGateError('Enter your PIN or passphrase.');
      focusGateInput();
      return;
    }

    el.gateSubmit.disabled = true;
    el.gateSubmit.textContent = 'Unlocking…';
    clearGateError();

    try {
      await unlock(value);
      el.gatePassphrase.value = '';
      showBoard();
      await loadBoard();
    } catch (err) {
      const base = err.message || 'Could not unlock the board';
      const wait = err.status === 429 && err.retryAfter > 0
        ? ` Try again in ${err.retryAfter}s.`
        : '';
      showGateError(wait ? `${base}${wait}` : base, { shake: true });
      if (err.status === 401) el.gatePassphrase.value = '';
      updatePinProgress();
      buildPinCells();
      focusGateInput();
    } finally {
      el.gateSubmit.disabled = false;
      el.gateSubmit.textContent = 'Unlock board';
    }
  });

  // Cells repaint from the real input, so paste, arrows and backspace keep the
  // browser's own behaviour instead of being re-implemented.
  el.gatePassphrase.addEventListener('input', () => {
    updatePinProgress();
    if (usesCells()) buildPinCells();
    if (!el.gateError.hidden) clearGateError();

    if (
      state.credentialKind === 'pin' &&
      state.pinLength &&
      el.gatePassphrase.value.length === state.pinLength &&
      !el.gateSubmit.disabled
    ) {
      el.gateForm.requestSubmit();
    }
  });

  el.gatePassphrase.addEventListener('focus', () => {
    if (usesCells()) buildPinCells();
    el.pinWrap.classList.add('is-focus');
  });
  el.gatePassphrase.addEventListener('blur', () => el.pinWrap.classList.remove('is-focus'));

  el.pinWrap.addEventListener('click', (event) => {
    if (event.target !== el.gatePassphrase) focusGateInput();
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

  el.newNote.addEventListener('click', () => startNewDraft(el.newNote));
  el.fab.addEventListener('click', () => startNewDraft(el.fab));
  el.composerClose.addEventListener('click', () => closeEditor());
  el.deleteBtn.addEventListener('click', armDelete);
  el.sheet.addEventListener('close', resetDeleteButton);

  el.editorArea.addEventListener('input', () => {
    updateCounter();
    updateDirty();
  });

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
      if (el.sheet.open) saveNote();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && el.sheet.open) {
      event.preventDefault();
      saveNote();
      return;
    }

    if (event.key === 'Escape') {
      if (el.sheet.open) {
        event.preventDefault();
        closeEditor();
        return;
      }
      if (document.activeElement === el.search) {
        el.search.value = '';
        state.filter = '';
        render();
        el.search.blur();
      }
      return;
    }

    if (typing || !el.gate.hidden) return;

    if (event.key === '/') {
      event.preventDefault();
      el.search.focus();
      el.search.select();
      return;
    }

    if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      startNewDraft(el.newNote);
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
  el.gateHeading = $('gate-heading');
  el.gateLabel = $('gate-label');
  el.gateLede = $('gate-lede');
  el.gateProgress = $('gate-progress');
  el.gateSubmit = $('gate-submit');
  el.gateError = $('gate-error');
  el.gateChangeToggle = $('gate-change-toggle');
  el.pinWrap = $('pin-wrap');
  el.pinCells = $('pin-cells');

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
  el.fab = $('fab');
  el.newNote = $('new-note');

  el.sheet = $('editor');
  el.composerForm = $('composer-form');
  el.composerHeading = $('composer-heading');
  el.composerKicker = $('composer-kicker');
  el.composerClose = $('composer-close');
  el.titleInput = $('note-title');
  el.editorArea = $('note-editor');
  el.noteTags = $('note-tags');
  el.charCount = $('char-count');
  el.saveBtn = $('save-btn');
  el.editingBanner = $('editing-banner');
  el.editingTitle = $('editing-title');
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
  el.tagAside = $('tag-aside');

  el.trash = $('trash');
  el.trashCount = $('trash-count');
  el.trashList = $('trash-list');

  el.toastRegion = $('toast-region');
}

async function init() {
  cacheElements();
  toastQueue = ToastQueue.createToastQueue({
    duration: TOAST_MS,
    show: (toast) => renderToast(toast),
    clear: () => el.toastRegion.replaceChildren(),
  });
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
      showGateError('This board has no PIN or passphrase configured yet.');
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