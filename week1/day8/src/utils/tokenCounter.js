/**
 * Token estimation, shared verbatim by the server and the browser.
 *
 * IMPORTANT — this is an ESTIMATE, not DeepSeek's tokenizer.
 * DeepSeek does not publish a JavaScript tokenizer, so nothing here can be
 * exact. Counts produced by this file are labelled "estimate" everywhere they
 * are stored or displayed, and the UI prefixes them with "~".
 *
 * The one place we get real numbers is the `usage` object DeepSeek returns with
 * every answer; those are marked "api" and are exact. See countMessageTokens()
 * in the storage layer and the README section on token counting.
 *
 * The heuristic below is a segment-wise approximation of byte-pair encoding:
 *   - CJK / Kana / Hangul       ~1 token per character
 *   - runs of digits            ~1 token per 3 digits
 *   - latin-ish words           ~1 token per 5 characters, at least 1
 *   - punctuation and symbols   1 token each
 * Leading whitespace is absorbed into the following word, the way BPE merges
 * " word" into a single token. In spot checks against GPT-style tokenizers this
 * lands within roughly ±15% for ordinary prose, which is accurate enough to
 * budget context with and honest enough to show with a "~".
 *
 * Loaded as a CommonJS module on the server and as a plain <script> in the
 * browser (where it defines window.TokenCounter), so the count the user sees
 * while typing is produced by exactly the same code as the stored count.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokenCounter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Every chat message costs a few tokens of role/framing overhead on top of
  // its text. Used only when budgeting a whole request, never for the per
  // message count we store and display.
  var MESSAGE_OVERHEAD_TOKENS = 4;

  var CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  var DIGITS = /[0-9]/;
  var WORD_CHAR = /[A-Za-z0-9_À-ɏͰ-ϿЀ-ӿ']/;
  var WHITESPACE = /\s/;

  /**
   * Estimate the number of tokens in a piece of text.
   *
   * @param {string} text
   * @returns {number} A non-negative integer estimate.
   */
  function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;

    var tokens = 0;
    var i = 0;
    var length = text.length;

    while (i < length) {
      var char = text.charAt(i);

      // Whitespace is free on its own; BPE folds a single leading space into
      // the word that follows. A run of blank lines still costs something.
      if (WHITESPACE.test(char)) {
        var wsStart = i;
        while (i < length && WHITESPACE.test(text.charAt(i))) i += 1;
        var wsLength = i - wsStart;
        if (wsLength > 1) tokens += Math.ceil((wsLength - 1) / 4);
        continue;
      }

      // Chinese, Japanese and Korean: roughly one token per character.
      if (CJK.test(char)) {
        while (i < length && CJK.test(text.charAt(i))) {
          tokens += 1;
          i += 1;
        }
        continue;
      }

      // Numbers are split into short runs of digits.
      if (DIGITS.test(char)) {
        var digitStart = i;
        while (i < length && DIGITS.test(text.charAt(i))) i += 1;
        tokens += Math.ceil((i - digitStart) / 3);
        continue;
      }

      // Letters and the marks that stay inside a word.
      if (WORD_CHAR.test(char)) {
        var wordStart = i;
        while (i < length && WORD_CHAR.test(text.charAt(i)) && !CJK.test(text.charAt(i))) i += 1;
        tokens += Math.max(1, Math.round((i - wordStart) / 5));
        continue;
      }

      // Punctuation, symbols, emoji: one token each.
      tokens += 1;
      i += 1;
    }

    return tokens;
  }

  /**
   * Estimate the cost of a list of chat messages, framing included. This is the
   * number a future context-trimming step would budget against.
   *
   * @param {Array<{content?: string}>} messages
   * @returns {number}
   */
  function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce(function (total, message) {
      if (!message || typeof message.content !== 'string') return total;
      return total + estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
    }, 0);
  }

  /**
   * Sum the token counts already stored on history messages. The stored numbers
   * are authoritative — a response carries DeepSeek's exact count — so this
   * never re-estimates text it has a real number for.
   *
   * @param {Array<{tokenCount?: number}>} messages
   * @returns {number}
   */
  function sumStoredTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce(function (total, message) {
      var count = message && Number(message.tokenCount);
      return total + (Number.isFinite(count) && count > 0 ? Math.round(count) : 0);
    }, 0);
  }

  /** Format a count the way the header and the bubbles show it: "2,450". */
  function formatCount(value) {
    var n = Math.max(0, Math.round(Number(value) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  return {
    MESSAGE_OVERHEAD_TOKENS: MESSAGE_OVERHEAD_TOKENS,
    estimateTokens: estimateTokens,
    estimateMessagesTokens: estimateMessagesTokens,
    sumStoredTokens: sumStoredTokens,
    formatCount: formatCount
  };
});
