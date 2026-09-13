/**
 * Token counting — the only module that knows how tokens are counted.
 * Shared verbatim by the server (CommonJS) and the browser (window.TokenService),
 * so the live count under the input box and the stored count cannot disagree.
 *
 * Two kinds of number exist in this app, and they are never mixed up:
 *
 *   EXACT      — DeepSeek's `usage` object (prompt_tokens, completion_tokens,
 *                total_tokens). Used for the context actually sent (prompt),
 *                for the token count of each stored answer, and for API totals.
 *   ESTIMATED  — count() below. DeepSeek does not publish a JavaScript
 *                tokenizer, so anything we count ourselves (a question, the
 *                context preview before sending, a fallback when usage is missing) is an estimate, is stored with
 *                tokensSource "estimate", and is shown as "~N tokens (estimated)".
 *
 * The estimator approximates byte-pair encoding segment by segment:
 *   - CJK / Kana / Hangul       ~1 token per character
 *   - runs of digits            ~1 token per 3 digits
 *   - latin-ish words           ~1 token per 5 characters, at least 1
 *   - punctuation and symbols   1 token each
 * with a single leading space folded into the following word. On ordinary
 * English prose it lands within roughly ±15% of DeepSeek's reported counts.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TokenService = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Role and framing overhead per chat message, used only when estimating the
  // size of a whole request (never for a stored per-message count).
  var MESSAGE_OVERHEAD_TOKENS = 4;

  var CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;
  var DIGITS = /[0-9]/;
  var WORD_CHAR = /[A-Za-z0-9_À-ɏͰ-ϿЀ-ӿ']/;
  var WHITESPACE = /\s/;

  /**
   * Estimate the tokens in a piece of text.
   * @param {string} text
   * @returns {number} Non-negative integer. Always an estimate.
   */
  function count(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;

    var tokens = 0;
    var i = 0;
    var length = text.length;

    while (i < length) {
      var ch = text.charAt(i);

      if (WHITESPACE.test(ch)) {
        var wsStart = i;
        while (i < length && WHITESPACE.test(text.charAt(i))) i += 1;
        if (i - wsStart > 1) tokens += Math.ceil((i - wsStart - 1) / 4);
        continue;
      }
      if (CJK.test(ch)) {
        while (i < length && CJK.test(text.charAt(i))) { tokens += 1; i += 1; }
        continue;
      }
      if (DIGITS.test(ch)) {
        var digitStart = i;
        while (i < length && DIGITS.test(text.charAt(i))) i += 1;
        tokens += Math.ceil((i - digitStart) / 3);
        continue;
      }
      if (WORD_CHAR.test(ch)) {
        var wordStart = i;
        while (i < length && WORD_CHAR.test(text.charAt(i))) i += 1;
        tokens += Math.max(1, Math.round((i - wordStart) / 5));
        continue;
      }
      tokens += 1; // Punctuation, symbols, emoji.
      i += 1;
    }
    return tokens;
  }

  /**
   * The token count of one stored message: its recorded count when it has one
   * (exact for answers), otherwise an estimate of its text.
   * @returns {{tokens: number, estimated: boolean}}
   */
  function countMessage(message) {
    if (!message) return { tokens: 0, estimated: false };
    var stored = Number(message.tokens);
    if (typeof message.tokens === 'number' && isFinite(stored) && stored >= 0) {
      return { tokens: Math.round(stored), estimated: message.tokensSource !== 'api' };
    }
    return { tokens: count(message.content), estimated: true };
  }

  /**
   * Sum of stored message counts. `estimated` is true if any part was estimated.
   * @param {object[]} messages
   * @returns {{tokens: number, estimated: boolean}}
   */
  function countMessages(messages) {
    var result = { tokens: 0, estimated: false };
    (Array.isArray(messages) ? messages : []).forEach(function (message) {
      var c = countMessage(message);
      result.tokens += c.tokens;
      result.estimated = result.estimated || (c.estimated && c.tokens > 0);
    });
    return result;
  }

  /**
   * Estimate the input size of a chat-completions request ({role, content}[]).
   * Only used when DeepSeek omits `usage`, so always an estimate.
   * @returns {number}
   */
  function estimateRequest(chatMessages) {
    return (Array.isArray(chatMessages) ? chatMessages : []).reduce(function (total, m) {
      return total + (m && typeof m.content === 'string' ? count(m.content) + MESSAGE_OVERHEAD_TOKENS : 0);
    }, 0);
  }

  /** "1,270" */
  function format(value) {
    var n = Math.max(0, Math.round(Number(value) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** "1,270 tokens" or "~1,270 tokens (estimated)". */
  function label(value, estimated) {
    return (estimated ? '~' : '') + format(value) + ' tokens' + (estimated ? ' (estimated)' : '');
  }

  return {
    MESSAGE_OVERHEAD_TOKENS: MESSAGE_OVERHEAD_TOKENS,
    count: count,
    countMessage: countMessage,
    countMessages: countMessages,
    estimateRequest: estimateRequest,
    format: format,
    label: label
  };
});
