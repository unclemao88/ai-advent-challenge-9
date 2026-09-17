/**
 * Token counting for DeepSeek requests.
 *
 * IMPORTANT — every number produced here is an ESTIMATE.
 *
 * DeepSeek's tokenizer is a byte-level BPE with a ~128k vocabulary, published
 * as a Hugging Face `tokenizer.json` plus Python code. There is no small,
 * dependency-free Node.js package for it, so this module approximates it. The
 * API reports the exact `prompt_tokens` after each call; the UI shows that next
 * to the estimate so the difference is always visible.
 *
 * Everything tokenizer-specific is in this file. To switch to an exact
 * tokenizer, reimplement `countTextTokens` (and set `TOKENIZER.exact`);
 * callers do not change.
 */

export const TOKENIZER = Object.freeze({
  name: 'heuristic BPE estimate',
  exact: false,
  description:
    'Approximation of DeepSeek\'s BPE tokenizer: ~1 token per 4–5 letters of a word, '
    + '1 per CJK character, 1 per 3 digits, 1 per symbol, plus chat-template markers per message. '
    + 'Typically within ±15% of the count DeepSeek reports.',
});

/**
 * DeepSeek's chat template wraps the messages in special tokens:
 *
 *   <｜begin▁of▁sentence｜>{system}<｜User｜>{q}<｜Assistant｜>{a}<｜end▁of▁sentence｜>…<｜Assistant｜>
 *
 * The system prompt gets no marker, a user turn one, an assistant turn two
 * (opening and end-of-sentence), and the request as a whole the leading
 * begin-of-sentence plus the trailing <｜Assistant｜> that asks for the reply.
 * These are counted so the total reflects the payload, not just its text.
 */
const ROLE_OVERHEAD = { system: 0, user: 1, assistant: 2 };
const REQUEST_OVERHEAD = 2;

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
const DIGIT = /[0-9]/;
const WORD_CHAR = /[\p{L}\p{M}_']/u;
const WHITESPACE = /\s/;

/**
 * Estimate the tokens in a piece of text.
 *
 * A segment-wise approximation of byte-pair encoding. A single space folds
 * into the word after it, as BPE merges " word" into one token.
 *
 * @param {string} text
 * @returns {number} A non-negative integer.
 */
export function countTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;

  let tokens = 0;
  let i = 0;
  const chars = Array.from(text); // Code points, so emoji and astral CJK count once.

  while (i < chars.length) {
    const char = chars[i];

    if (WHITESPACE.test(char)) {
      const start = i;
      while (i < chars.length && WHITESPACE.test(chars[i])) i += 1;
      // One space is free; indentation and blank lines are not.
      if (i - start > 1) tokens += Math.ceil((i - start - 1) / 4);
    } else if (CJK.test(char)) {
      tokens += 1;
      i += 1;
    } else if (DIGIT.test(char)) {
      const start = i;
      while (i < chars.length && DIGIT.test(chars[i])) i += 1;
      tokens += Math.ceil((i - start) / 3);
    } else if (WORD_CHAR.test(char)) {
      const start = i;
      while (i < chars.length && WORD_CHAR.test(chars[i]) && !CJK.test(chars[i])) i += 1;
      // Common words are one token; long or rare ones split into pieces.
      tokens += Math.max(1, Math.round((i - start) / 4.5));
    } else {
      tokens += 1; // Punctuation, symbols, emoji.
      i += 1;
    }
  }

  return tokens;
}

/**
 * One chat message: its content plus the template markers for its role.
 *
 * @param {{role: string, content: string}} message
 */
export function countMessageTokens(message) {
  if (!message || typeof message.content !== 'string') return 0;
  return countTextTokens(message.content) + (ROLE_OVERHEAD[message.role] ?? 1);
}

/**
 * A complete request: every message plus the request-level markers. This is
 * the function that answers "how big is what we send to DeepSeek?".
 *
 * @param {Array<{role: string, content: string}>} messages
 */
export function countRequestTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((total, message) => total + countMessageTokens(message), REQUEST_OVERHEAD);
}
