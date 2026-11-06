/* One notice at a time.
   Several saves in a row used to stack identical cards over the editor. This
   keeps a single visible toast, counts the events that arrived while it was up,
   and shows the newest one when the turn ends.

   Plain script (no build step): `ToastQueue` in the browser, a module in Node so
   the queue can be tested without a DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ToastQueue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object} host
   * @param {(toast: object, extra: number) => void} host.show
   * @param {() => void} host.clear
   * @param {number} [host.duration]
   * @param {(fn: () => void, ms: number) => unknown} [host.schedule]
   * @param {(handle: unknown) => void} [host.cancel]
   */
  function createToastQueue(host) {
    const duration = Number(host.duration) > 0 ? Number(host.duration) : 4000;
    const schedule = host.schedule || setTimeout;
    const cancel = host.cancel || clearTimeout;

    let active = null;
    let pending = null;
    let extra = 0;
    let timer = null;

    function render() {
      host.show(active, extra);
    }

    function arm() {
      if (timer !== null) cancel(timer);
      timer = schedule(tick, duration);
    }

    function tick() {
      timer = null;
      if (pending) {
        active = pending;
        pending = null;
        extra = 0;
        render();
        if (!active.sticky) arm();
        return;
      }
      active = null;
      extra = 0;
      render();
      host.clear();
    }

    return {
      push(toast) {
        if (!active) {
          active = toast;
          extra = 0;
          render();
          if (!toast.sticky) arm();
          return;
        }
        // Keep the newest, not a backlog: a burst of saves should not replay
        // five stale notices after the first one leaves.
        pending = toast;
        extra += 1;
        render();
      },
      dismiss() {
        if (timer !== null) cancel(timer);
        timer = null;
        tick();
      },
      get active() {
        return active;
      },
      get extra() {
        return extra;
      },
    };
  }

  return { createToastQueue };
});