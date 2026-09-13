'use strict';

/**
 * Sliding window: the latest N stored messages of the active conversation go
 * to the model; everything older stays in state.json and in the chat, but is
 * not sent.
 */
class SlidingWindowManager {
  /**
   * @param {object[]} path The active conversation, oldest first.
   * @param {number} N
   * @returns {{history: object[], excluded: object[]}}
   */
  select(path, N) {
    const start = Math.max(0, path.length - N);
    return { history: path.slice(start), excluded: path.slice(0, start) };
  }
}

module.exports = { SlidingWindowManager };
