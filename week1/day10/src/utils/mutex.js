'use strict';

/**
 * A promise-based lock for a single process. `run(fn)` waits for every earlier
 * holder to finish, then runs `fn`. A holder that throws still releases the
 * lock, so one failure cannot wedge everything behind it.
 *
 * This is all the concurrency control a local, single-process app needs: every
 * read-modify-write of a JSON file, and every conversation turn, goes through
 * one of these.
 */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
    this.pending = 0; // Holders running or waiting.
  }

  run(fn) {
    this.pending += 1;
    const result = this._tail.then(function () { return fn(); });
    const release = () => { this.pending -= 1; };
    this._tail = result.then(release, release);
    return result;
  }
}

module.exports = Mutex;
