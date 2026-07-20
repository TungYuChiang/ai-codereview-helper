// lock.js — tiny, dependency-free async mutex.
//
// Generic on purpose: config.js uses it to serialize read-modify-write
// access to config.json, and state.js (a later unit) reuses it for the same
// pattern on per-repo progress files. Nothing here is coupled to either.

/**
 * Creates a mutex. Returns a `run` function: `run(fn)` queues `fn` so it
 * only starts once every previously queued `fn` has settled (resolved or
 * rejected, in call order), and returns a promise that settles with that
 * particular `fn`'s own outcome.
 *
 * A queued `fn` that rejects does not wedge the queue -- later `run()`
 * calls still execute in order.
 *
 * @returns {(fn: () => any) => Promise<any>}
 */
export function createMutex() {
  let tail = Promise.resolve();

  return function run(fn) {
    const started = tail.then(fn);
    // Advance the queue once this task settles, regardless of whether it
    // resolved or rejected, so a failure can never wedge later callers.
    tail = started.then(
      () => {},
      () => {}
    );
    return started;
  };
}
