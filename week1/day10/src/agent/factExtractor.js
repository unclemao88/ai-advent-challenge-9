'use strict';

const AgentError = require('./errors').AgentError;
const prompts = require('./prompts');
const stickyFacts = require('./stickyFacts');

// A long backlog (e.g. switching to Sticky facts after 200 messages) is folded
// in slices, each building on the facts produced by the previous one.
const MAX_BATCH_MESSAGES = 30;
const MAX_BATCH_TOKENS = 12000;

/**
 * Folds messages into sticky facts using DeepSeek's JSON output mode.
 * Every response is validated by stickyFacts.parseExtraction before it can
 * change anything; a failed batch leaves the facts as they were.
 */
class FactExtractor {
  /**
   * @param {{client: DeepSeekClient, model: string, tokenService: object}} options
   */
  constructor(options) {
    this.client = options.client;
    this.model = options.model;
    this.tokenService = options.tokenService;
  }

  /**
   * @param {object} existingFacts
   * @param {object[]} messages Messages to fold in, oldest first.
   * @param {number} firstIndex Position of messages[0] in the conversation.
   * @returns {Promise<{facts: object, covered: number, changed: {set: string[], removed: string[]},
   *           usage: object, error: string|null}>} `covered` counts the leading
   *           messages that were folded in successfully, even if a later batch failed.
   */
  async extract(existingFacts, messages, firstIndex) {
    let facts = existingFacts || {};
    let covered = 0;
    const changed = { set: [], removed: [] };
    const usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };

    for (const batch of this.batches(messages)) {
      const prompt = prompts.buildFactsPrompt(facts, batch, firstIndex + covered);
      try {
        const result = await this.client.chat({
          model: this.model,
          messages: prompt,
          temperature: 0,
          maxTokens: 2048,
          responseFormat: 'json_object'
        });
        addUsage(usage, result, prompt, this.tokenService);
        if (result.finishReason === 'length') {
          throw new AgentError('the fact list was cut off by the output limit');
        }
        const applied = stickyFacts.applyUpdate(facts, stickyFacts.parseExtraction(result.content), new Date());
        facts = applied.facts;
        applied.changed.set.forEach(function (k) { if (changed.set.indexOf(k) === -1) changed.set.push(k); });
        applied.changed.removed.forEach(function (k) { if (changed.removed.indexOf(k) === -1) changed.removed.push(k); });
        covered += batch.length;
      } catch (err) {
        return { facts: facts, covered: covered, changed: changed, usage: usage, error: err.message };
      }
    }
    return { facts: facts, covered: covered, changed: changed, usage: usage, error: null };
  }

  batches(messages) {
    const out = [];
    let current = null;
    let tokens = 0;
    messages.forEach((m) => {
      const size = this.tokenService.count(m.content);
      if (!current || current.length >= MAX_BATCH_MESSAGES || (tokens + size > MAX_BATCH_TOKENS && current.length > 0)) {
        current = [];
        tokens = 0;
        out.push(current);
      }
      current.push(m);
      tokens += size;
    });
    return out;
  }
}

function addUsage(usage, result, prompt, tokenService) {
  const u = result.usage;
  const input = u.input !== null ? u.input : tokenService.estimateRequest(prompt);
  const output = u.output !== null ? u.output : tokenService.count(result.content);
  usage.calls += 1;
  usage.promptTokens += input;
  usage.completionTokens += output;
  usage.totalTokens += u.total !== null ? u.total : input + output;
  usage.estimated = usage.estimated || u.input === null || u.output === null;
}

module.exports = { FactExtractor, MAX_BATCH_MESSAGES, MAX_BATCH_TOKENS };
