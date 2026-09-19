import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Token counting for DeepSeek requests.
 *
 * Two strategies behind one interface:
 *
 *  - exact     DeepSeek's own tokenizer (`tokenizer.json` from the DeepSeek-V3.x
 *              repository, identical for V3.1 and V3.2, which back the API's
 *              `deepseek-chat` and `deepseek-reasoner`), run by the pure-JS
 *              `@huggingface/tokenizers`. The request is rendered with
 *              DeepSeek's chat template first, so special tokens are counted.
 *  - estimate  A character-class heuristic used when the tokenizer files are
 *              not installed (`npm run fetch:tokenizer`). Typically within
 *              ±15%; the UI labels it as an estimate.
 *
 * Even "exact" has one known limit: it counts the prompt as the published chat
 * template renders it. Anything DeepSeek's server adds on its side (for JSON
 * output mode, for instance) is invisible here. After each call the UI also
 * shows the `prompt_tokens` DeepSeek reports, so any gap stays visible.
 */

export const SPECIAL = Object.freeze({
  bos: '<｜begin▁of▁sentence｜>',
  eos: '<｜end▁of▁sentence｜>',
  user: '<｜User｜>',
  assistant: '<｜Assistant｜>',
  think: '<think>',
  endThink: '</think>',
});

const SPECIAL_PATTERN = new RegExp(Object.values(SPECIAL).map((s) => s.replace(/[|/\\^$*+?.()[\]{}]/g, '\\$&')).join('|'), 'g');

/**
 * Render messages the way DeepSeek-V3.1/V3.2's chat template does (no tools):
 *
 *   <bos>{system…joined by blank lines}<｜User｜>{q}<｜Assistant｜></think>{a}<eos>…<｜Assistant｜></think>
 *
 * `thinking` (deepseek-reasoner) ends the prompt with `<think>` instead.
 */
export function renderChatTemplate(messages, { thinking = false, addGenerationPrompt = true } = {}) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  let out = SPECIAL.bos + system;
  let lastWasUser = false;
  for (const m of messages) {
    if (m.role === 'user') {
      out += SPECIAL.user + m.content;
      lastWasUser = true;
    } else if (m.role === 'assistant') {
      if (lastWasUser) out += SPECIAL.assistant + SPECIAL.endThink;
      out += m.content + SPECIAL.eos;
      lastWasUser = false;
    }
  }
  if (addGenerationPrompt) out += SPECIAL.assistant + (thinking ? SPECIAL.think : SPECIAL.endThink);
  return out;
}

/** Heuristic count of plain text (no special tokens). */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/u;
  const DIGIT = /[0-9]/;
  const WORD = /[\p{L}\p{M}_']/u;
  const SPACE = /\s/;
  const chars = Array.from(text);
  let tokens = 0;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (SPACE.test(c)) {
      const start = i;
      while (i < chars.length && SPACE.test(chars[i])) i += 1;
      if (i - start > 1) tokens += Math.ceil((i - start - 1) / 4);
    } else if (CJK.test(c)) {
      tokens += 1;
      i += 1;
    } else if (DIGIT.test(c)) {
      const start = i;
      while (i < chars.length && DIGIT.test(chars[i])) i += 1;
      tokens += Math.ceil((i - start) / 3);
    } else if (WORD.test(c)) {
      const start = i;
      const ascii = /[A-Za-z]/.test(c);
      while (i < chars.length && WORD.test(chars[i]) && !CJK.test(chars[i])) i += 1;
      // Latin words average ~4.5 characters per token, other scripts ~2.5.
      tokens += Math.max(1, Math.round((i - start) / (ascii ? 4.5 : 2.5)));
    } else {
      tokens += 1;
      i += 1;
    }
  }
  return tokens;
}

export class TokenCounter {
  #tokenizer;

  /**
   * @param {{tokenizer?: {encode: (text: string, options?: object) => {ids: number[]}}, source?: string, thinking?: boolean}} [options]
   *        Without a tokenizer, the heuristic is used.
   */
  constructor({ tokenizer = null, source = null, thinking = false } = {}) {
    this.#tokenizer = tokenizer;
    this.thinking = thinking;
    this.info = tokenizer
      ? {
        method: 'exact',
        exact: true,
        name: 'DeepSeek-V3 tokenizer',
        source,
        note: 'Counted with DeepSeek\'s tokenizer on the prompt rendered by its chat template. '
          + 'Server-side additions (if any) are not visible; compare with the prompt tokens DeepSeek reports.',
      }
      : {
        method: 'estimate',
        exact: false,
        name: 'heuristic estimate',
        source: null,
        note: 'DeepSeek tokenizer files are not installed (run `npm run fetch:tokenizer`). '
          + 'Counts are estimates, typically within ±15%.',
      };
  }

  /**
   * Load DeepSeek's tokenizer from `directory`, or fall back to the estimate.
   *
   * @param {{directory: string, model?: string, logger?: object}} options
   */
  static async create({ directory, model = '', logger }) {
    const thinking = /reasoner/i.test(model);
    try {
      const [json, config] = await Promise.all([
        readFile(path.join(directory, 'tokenizer.json'), 'utf8'),
        readFile(path.join(directory, 'tokenizer_config.json'), 'utf8'),
      ]);
      const { Tokenizer } = await import('@huggingface/tokenizers');
      const tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
      const counter = new TokenCounter({ tokenizer, source: 'deepseek-ai/DeepSeek-V3.2-Exp tokenizer.json', thinking });
      counter.countText('self-test'); // Fail here, not on the first request.
      if (!counter.info.exact) throw new Error(counter.info.note);
      counter.onFailure = (err) => logger?.error('tokens.tokenizer_failed', { error: err, method: 'estimate' });
      logger?.info('tokens.tokenizer_loaded', { method: 'exact' });
      return counter;
    } catch (err) {
      logger?.warn('tokens.tokenizer_unavailable', {
        method: 'estimate',
        reason: err.code === 'ENOENT' ? 'tokenizer files not installed' : err.message,
      });
      return new TokenCounter({ thinking });
    }
  }

  /** Tokens of plain text. */
  countText(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    return this.#encode(text) ?? estimateTextTokens(text);
  }

  /**
   * Exact count, or null without a tokenizer. If the tokenizer ever throws,
   * counting falls back to the estimate for good and `info` says so, instead of
   * failing the request.
   */
  #encode(text) {
    if (!this.#tokenizer) return null;
    try {
      return this.#tokenizer.encode(text, { add_special_tokens: false }).ids.length;
    } catch (err) {
      this.#tokenizer = null;
      this.info = {
        ...new TokenCounter().info,
        note: `The DeepSeek tokenizer failed (${err.message}); counts are estimates from now on.`,
      };
      this.onFailure?.(err);
      return null;
    }
  }

  /**
   * Tokens of chat turns including their template markers, without the
   * request-level begin/generation markers. Used for the short-term layer.
   */
  countTurns(messages) {
    let total = 0;
    let lastWasUser = false;
    for (const m of messages) {
      if (m.role === 'user') {
        total += 1 + this.countText(m.content);
        lastWasUser = true;
      } else if (m.role === 'assistant') {
        total += (lastWasUser ? 2 : 0) + this.countText(m.content) + 1;
        lastWasUser = false;
      } else {
        total += this.countText(m.content);
      }
    }
    return total;
  }

  /**
   * Tokens of a complete request: every message as rendered by the chat
   * template, plus begin-of-sentence and the generation prompt. This is the
   * number shown as "Current request context".
   */
  countRequest(messages) {
    const rendered = renderChatTemplate(messages, { thinking: this.thinking });
    const exact = this.#encode(rendered);
    if (exact !== null) return exact;
    const specials = rendered.match(SPECIAL_PATTERN)?.length ?? 0;
    // Removing a marker can glue words together; a space keeps them apart.
    return specials + estimateTextTokens(rendered.replace(SPECIAL_PATTERN, ' '));
  }
}
