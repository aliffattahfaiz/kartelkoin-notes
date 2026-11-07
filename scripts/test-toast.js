'use strict';

// The toast queue without a DOM: what is visible, what waits, and what the
// "+N" counter means. Run with: node scripts/test-toast.js

const assert = require('node:assert/strict');
const { createToastQueue } = require('../toast-queue');

const results = [];
function check(name, fn) {
  results.push({ name, fn });
}

function harness() {
  const shown = [];
  const timers = [];
  let cleared = 0;
  let cancelled = 0;

  const queue = createToastQueue({
    duration: 4000,
    show: (toast, extra) => shown.push({ message: toast ? toast.message : null, extra }),
    clear: () => { cleared += 1; },
    schedule: (fn) => { timers.push(fn); return timers.length; },
    cancel: () => { cancelled += 1; },
  });

  return {
    queue,
    shown,
    get cleared() { return cleared; },
    get cancelled() { return cancelled; },
    fire() {
      const next = timers.shift();
      assert.ok(next, 'a timer should be armed');
      next();
    },
  };
}

check('the first notice is shown alone', () => {
  const h = harness();
  h.queue.push({ message: 'Note saved' });
  assert.deepEqual(h.shown, [{ message: 'Note saved', extra: 0 }]);
  assert.equal(h.queue.active.message, 'Note saved');
});

check('a burst keeps one notice visible and counts the rest', () => {
  const h = harness();
  h.queue.push({ message: 'Note saved' });
  h.queue.push({ message: 'Note saved' });
  h.queue.push({ message: 'Changes saved' });
  h.queue.push({ message: 'Note saved' });

  assert.equal(h.shown.length, 4, 'the same card is repainted, not stacked');
  assert.deepEqual(h.shown.at(-1), { message: 'Note saved', extra: 3 });
  assert.equal(h.queue.active.message, 'Note saved', 'the first notice keeps the screen');
});

check('when the turn ends the newest notice takes over', () => {
  const h = harness();
  h.queue.push({ message: 'Note saved' });
  h.queue.push({ message: 'Changes saved' });
  h.queue.push({ message: 'Moved to trash' });

  h.fire();
  assert.deepEqual(h.shown.at(-1), { message: 'Moved to trash', extra: 0 });
  assert.equal(h.queue.active.message, 'Moved to trash');
});

check('the region empties after the last notice', () => {
  const h = harness();
  h.queue.push({ message: 'Note saved' });
  h.fire();

  assert.equal(h.queue.active, null);
  assert.equal(h.cleared, 1);
  assert.deepEqual(h.shown.at(-1), { message: null, extra: 0 });
});

check('dismiss advances immediately instead of waiting', () => {
  const h = harness();
  h.queue.push({ message: 'Note saved' });
  h.queue.push({ message: 'Locked' });

  h.queue.dismiss();
  assert.equal(h.queue.active.message, 'Locked');
  assert.equal(h.queue.extra, 0);
});

check('a sticky confirmation does not disappear on a timer', () => {
  const h = harness();
  h.queue.push({ message: 'Discard this draft?', sticky: true });
  assert.equal(h.shown.length, 1);
  assert.equal(h.cancelled, 0, 'no timer was armed');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of results) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}`);
      console.log(`     ${err.message}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();