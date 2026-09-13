/**
 * The context-budget rule, shared verbatim by the server and the browser.
 *
 * The server uses it to decide what actually gets sent to DeepSeek; the page
 * uses it to show what the next request will cost before you press ask. Two
 * implementations of this walk would drift, and the number in the composer
 * would quietly stop matching the request — so there is one, here.
 *
 * Loaded as a CommonJS module on the server and as a plain <script> in the
 * browser, where it defines window.ContextBudget.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ContextBudget = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Decide how much history fits, newest first.
   *
   * The system prompt and the question are reserved before any history is
   * considered: both are mandatory, so whatever is left is what memory may
   * spend. The walk stops at the first message too large to fit rather than
   * skipping it for older, smaller ones — that keeps the replayed window
   * contiguous, so the model never sees a conversation with holes in it.
   *
   * @param {number[]} historyCosts Per-message content tokens, oldest first.
   * @param {{budget: number, systemTokens: number, questionTokens: number,
   *          overhead: number}} options
   *        `budget` of 0 (or a negative) means no budget: everything fits.
   * @returns {{includedMessages: number, trimmedMessages: number,
   *            estimatedTokens: number, historyTokens: number,
   *            reservedTokens: number, budget: number|null}}
   */
  function plan(historyCosts, options) {
    const costs = Array.isArray(historyCosts) ? historyCosts : [];
    const opts = options || {};
    const overhead = numberOr(opts.overhead, 0);
    const budget = numberOr(opts.budget, 0);

    const reserved = numberOr(opts.systemTokens, 0) + overhead
      + numberOr(opts.questionTokens, 0) + overhead;
    const available = budget > 0 ? budget - reserved : Infinity;

    let spent = 0;
    let included = 0;
    for (let i = costs.length - 1; i >= 0; i -= 1) {
      const cost = numberOr(costs[i], 0) + overhead;
      if (spent + cost > available) break;
      spent += cost;
      included += 1;
    }

    return {
      includedMessages: included,
      trimmedMessages: costs.length - included,
      historyTokens: spent,
      reservedTokens: reserved,
      estimatedTokens: spent + reserved,
      budget: budget > 0 ? budget : null
    };
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  return { plan: plan };
});
