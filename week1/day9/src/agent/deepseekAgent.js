'use strict';

const Mutex = require('../utils/mutex');
const AgentError = require('./deepseekClient').AgentError;
const createMessage = require('../storage/historyStore').createMessage;
const summaryModule = require('../services/summaryService');

const planSummary = summaryModule.planSummary;
const contentTokens = summaryModule.contentTokens;

// "10 messages" means 10 individual messages, not 10 question/answer pairs.
const RECENT_WINDOW = 10;
// Turns run one at a time; beyond this many waiting, new questions get a 429.
const MAX_QUEUED_TURNS = 4;

const SYSTEM_PROMPT = [
  'You are a helpful AI assistant with persistent memory of your whole conversation with this user,',
  'across page reloads, sessions and server restarts.',
  '',
  'Your memory has two parts, both given below:',
  '1. [Historical Summary] — notes you wrote earlier about the older part of the conversation.',
  '   Treat them as things that were really said.',
  '2. [Last Messages] — the most recent messages, verbatim, as chat turns.',
  '',
  'Use both. When the user refers to something from earlier, rely on this memory and say so naturally',
  '("You mentioned that…"). If the summary and the recent messages disagree, the recent messages are newer',
  'and win. If something is in neither, say you do not know rather than guessing.',
  'Answer in the language of the question. Use Markdown where it helps (lists, fenced code blocks).'
].join('\n');

/**
 * The agent. One call to ask() is one conversation turn:
 *
 *   1. validate the question and store it (so it can never be lost)
 *   2. make sure `summary + last 10 messages` covers everything said before it
 *   3. build the context: system prompt, summary, last 10 messages, question
 *   4. call DeepSeek
 *   5. store the answer with its exact token count
 *   6. fold messages that just left the 10-message window into the summary
 *   7. return the answer, the updated memory and the token statistics
 *
 * The browser never builds prompts; it only sends the question text.
 */
class DeepSeekAgent {
  /**
   * @param {{client: DeepSeekClient, store: HistoryStore, summaryService: SummaryService,
   *          tokenService: object, model: string, windowSize?: number,
   *          maxQuestionChars?: number, logger?: Console}} options
   */
  constructor(options) {
    this.client = options.client;
    this.store = options.store;
    this.summaryService = options.summaryService;
    this.tokenService = options.tokenService;
    this.model = options.model;
    this.windowSize = options.windowSize || RECENT_WINDOW;
    this.maxQuestionChars = options.maxQuestionChars || 8000;
    this.systemPrompt = options.systemPrompt || SYSTEM_PROMPT;
    this.logger = options.logger || console;
    // Whole turns are serialized, so two simultaneous questions cannot
    // interleave their messages or race each other's summary updates.
    this.turns = new Mutex();
  }

  get configured() {
    return this.client.configured;
  }

  /** What GET /api/history returns: the summary, the last 10 messages, token counts. */
  async getMemory() {
    return this.describeMemory(await this.store.getState());
  }

  /**
   * @param {string} question
   * @returns {Promise<object>} See README → API.
   * @throws {AgentError} With `userMessage` and `memory` attached when the
   *         question had already been stored before the failure.
   */
  ask(question) {
    let text;
    try {
      text = this.validateQuestion(question);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this.client.configured) {
      return Promise.reject(new AgentError('The agent is not configured: DEEPSEEK_API_KEY is not set on the server.', 503));
    }
    if (this.turns.pending >= MAX_QUEUED_TURNS) {
      return Promise.reject(new AgentError('The agent is busy with other questions. Please try again shortly.', 429));
    }
    return this.turns.run(() => this._turn(text));
  }

  /** Start a new conversation. Waits for a running turn to finish first. */
  clear() {
    return this.turns.run(async () => this.describeMemory(await this.store.clear()));
  }

  validateQuestion(question) {
    if (typeof question !== 'string' || !question.trim()) {
      throw new AgentError('Please enter a question.', 400);
    }
    const text = question.trim();
    if (text.length > this.maxQuestionChars) {
      throw new AgentError('That question is too long (limit ' + this.maxQuestionChars + ' characters).', 413);
    }
    return text;
  }

  async _turn(question) {
    const warnings = [];
    const summarization = { input: 0, output: 0, total: 0, calls: 0, estimated: false };

    // 1. Store the question first. Whatever fails later, it is not lost.
    const userMessage = createMessage('user', question, {
      tokens: this.tokenService.count(question),
      tokensSource: 'estimate'
    });
    let state = await this.store.appendMessage(userMessage);
    const previous = state.messages.slice(0, -1);

    // 2. Catch the summary up if an earlier update failed. Normally a no-op:
    //    the previous turn already folded everything outside the window.
    let summary = state.summary;
    try {
      summary = await this._foldOldMessages(state, previous.length, summarization) || summary;
    } catch (err) {
      this._summaryFailed(err, warnings);
    }

    // 3. Context: summary + the last 10 messages before this question + the question.
    const recent = previous.slice(-this.windowSize);
    // Only non-empty if summarizing failed: sent verbatim so nothing is forgotten.
    const unsummarized = previous.slice(summary.messagesCovered, Math.max(summary.messagesCovered, previous.length - this.windowSize));
    const context = this.buildContext(summary, unsummarized, recent, question);

    // 4. Ask. On failure there is no fake answer: the stored question stays, and
    //    the caller learns that it was stored.
    let completion;
    try {
      completion = await this.client.chat({ model: this.model, messages: context });
    } catch (err) {
      err.userMessage = userMessage;
      err.memory = await this.getMemory().catch(() => null);
      throw err;
    }

    // 5. Store the answer. DeepSeek's usage is exact; estimate only what it omits.
    const usage = completion.usage;
    const apiCall = {
      input: usage.input !== null ? usage.input : this.tokenService.estimateRequest(context),
      output: usage.output !== null ? usage.output : this.tokenService.count(completion.content),
      estimated: usage.input === null || usage.output === null,
      model: completion.model
    };
    apiCall.total = usage.total !== null && !apiCall.estimated ? usage.total : apiCall.input + apiCall.output;

    const answerTokens = contentTokens(usage);
    const assistantMessage = createMessage('assistant', completion.content, {
      tokens: answerTokens !== null ? answerTokens : undefined,
      tokensSource: 'api',
      usage: apiCall
    });
    state = await this.store.appendMessage(assistantMessage);

    // 6. The two new messages pushed the oldest ones out of the window: fold them
    //    into the summary now, so the stored memory is complete between turns.
    try {
      await this._foldOldMessages(state, state.messages.length, summarization);
    } catch (err) {
      this._summaryFailed(err, warnings);
    }

    // 7. Report.
    const memory = await this.getMemory();
    this.logger.log('[agent] answered: ' + apiCall.input + ' in / ' + apiCall.output + ' out'
      + (apiCall.estimated ? ' (estimated)' : '') + '; context = summary of ' + summary.messagesCovered
      + ' + ' + unsummarized.length + ' unsummarized + ' + recent.length + ' recent messages'
      + (summarization.calls ? '; summary updated in ' + summarization.calls + ' call(s)' : ''));

    return {
      answer: completion.content,
      userMessage: userMessage,
      message: assistantMessage,
      summary: memory.summary,
      memory: memory,
      tokens: {
        // The question itself. Always a local estimate.
        currentRequest: userMessage.tokens,
        currentRequestEstimated: true,
        // The answering API call: everything sent (system prompt, summary,
        // recent messages, question) and everything generated.
        input: apiCall.input,
        output: apiCall.output,
        total: apiCall.total,
        apiEstimated: apiCall.estimated,
        // Persistent memory after this turn (summary + last 10 messages) — what
        // the next question will be answered from. Not the current request.
        summary: memory.tokens.summary,
        summaryEstimated: memory.tokens.summaryEstimated,
        fullHistory: memory.tokens.fullHistory,
        fullHistoryEstimated: memory.tokens.fullHistoryEstimated,
        historyTotal: memory.tokens.historyTotal,
        historyTotalEstimated: memory.tokens.historyTotalEstimated,
        summarization: summarization.calls ? summarization : null
      },
      context: {
        model: completion.model,
        summaryMessagesCovered: summary.messagesCovered,
        unsummarizedMessages: unsummarized.length,
        recentMessages: recent.length
      },
      warnings: warnings
    };
  }

  /**
   * Fold whatever lies outside the recent window (among the first `upTo`
   * messages) into the summary: existing summary + leaving messages = new summary.
   * @returns {Promise<object|null>} The new summary record, or null if nothing to do.
   */
  async _foldOldMessages(state, upTo, usageTotals) {
    const plan = planSummary(upTo, state.summary.messagesCovered, this.windowSize);
    if (!plan) return null;

    const result = await this.summaryService.update(
      state.summary.summary, state.messages.slice(plan.from, plan.to), plan.from);
    ['input', 'output', 'total', 'calls'].forEach((k) => { usageTotals[k] += result.usage[k]; });
    usageTotals.estimated = usageTotals.estimated || result.usage.estimated;

    const saved = await this.store.saveSummary({
      summary: result.summary,
      tokens: result.tokens,
      tokensSource: result.tokensSource,
      messagesCovered: plan.to,
      model: result.model
    });
    return saved.summary;
  }

  _summaryFailed(err, warnings) {
    this.logger.error('[agent] summary update failed: ' + (err.detail || err.message));
    warnings.push('The historical summary could not be updated (' + (err instanceof AgentError ? err.message : 'internal error')
      + '). Nothing was lost: the unsummarized messages are sent in full and the summary will be retried next time.');
  }

  /**
   * The chat messages sent to DeepSeek. The summary and the recent messages are
   * clearly separated; the current question appears exactly once, at the end.
   */
  buildContext(summary, unsummarized, recent, question) {
    const lines = [this.systemPrompt, '', '[Historical Summary]'];
    if (summary.summary) {
      lines.push('Compressed memory of the ' + summary.messagesCovered + ' oldest messages of this conversation:', '', summary.summary);
    } else {
      lines.push('(empty — no older messages have been summarized yet)');
    }
    if (unsummarized.length) {
      lines.push('', '[Older Messages Not Yet Summarized]',
        'These came after the summary and before the last messages. Summarizing them failed, so they are verbatim:', '');
      unsummarized.forEach((m) => { lines.push(m.role + ': ' + m.content, ''); });
    }
    lines.push('', '[Last ' + recent.length + ' Messages]',
      recent.length
        ? 'The most recent messages follow as chat turns, complete and verbatim, oldest first.'
        : '(none — this is the start of the conversation)',
      '', '[Current User Question]', 'The final user message is the current question.');

    const chat = [{ role: 'system', content: lines.join('\n') }];
    recent.forEach((m) => pushTurn(chat, m.role, m.content));
    pushTurn(chat, 'user', question);
    return chat;
  }

  describeMemory(state) {
    const messages = state.messages;
    const summary = state.summary;
    const recent = messages.slice(-this.windowSize);
    const s = this.tokenService.countSummary(summary);
    const h = this.tokenService.countMessages(recent);

    let lastApiCall = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant' && messages[i].usage) { lastApiCall = messages[i].usage; break; }
    }

    return {
      summary: {
        summary: summary.summary,
        tokens: s.tokens,
        tokensEstimated: s.estimated,
        updatedAt: summary.updatedAt,
        messagesCovered: summary.messagesCovered
      },
      messages: recent,
      totalMessages: messages.length,
      windowSize: this.windowSize,
      // Messages that are neither in the summary nor among the last 10: only
      // after a failed summary update, until the next question catches up.
      pendingSummary: Math.max(0, messages.length - this.windowSize - summary.messagesCovered),
      tokens: {
        summary: s.tokens,
        summaryEstimated: s.estimated,
        fullHistory: h.tokens,
        fullHistoryEstimated: h.estimated,
        historyTotal: s.tokens + h.tokens,
        historyTotalEstimated: s.estimated || h.estimated
      },
      lastApiCall: lastApiCall,
      notices: this.store.notices.slice()
    };
  }
}

/**
 * Append a chat turn. Two stored user messages in a row happen when an earlier
 * question got no answer (DeepSeek failed); the API expects alternating turns,
 * so they are merged for the request only — history.json is not touched.
 */
function pushTurn(chat, role, content) {
  const last = chat[chat.length - 1];
  if (last && last.role === role && role !== 'system') {
    last.content += role === 'user'
      ? '\n\n(The message above received no answer because of an error.)\n\n' + content
      : '\n\n' + content;
    return;
  }
  chat.push({ role: role, content: content });
}

module.exports = { DeepSeekAgent, RECENT_WINDOW, SYSTEM_PROMPT };
