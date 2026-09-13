'use strict';

const AgentError = require('./errors').AgentError;
const Mutex = require('../utils/mutex');
const schema = require('../storage/schema');

/**
 * The agent: one conversation, persisted in state.json.
 *
 * It knows the order of a turn — catch up facts, build context, call DeepSeek,
 * store the pair, fold facts — and nothing about HTTP. What goes into the
 * context is ContextManager's business; files are StateStore's.
 *
 * Every state-changing operation runs under `turnLock`, so a mode switch or a
 * branch switch can never interleave with a turn that is waiting on DeepSeek.
 * Reads (getState) do not take it, so reloading the page mid-turn still works.
 */
class DeepSeekAgent {
  /**
   * @param {{client: DeepSeekClient, store: StateStore, contextManager: ContextManager,
   *          factExtractor: FactExtractor, tokenService: object, model: string,
   *          factsModel?: string, maxQuestionChars?: number, logger?: Console}} options
   */
  constructor(options) {
    this.client = options.client;
    this.store = options.store;
    this.context = options.contextManager;
    this.factExtractor = options.factExtractor;
    this.tokenService = options.tokenService;
    this.model = options.model;
    this.factsModel = options.factsModel || options.model;
    this.maxQuestionChars = options.maxQuestionChars || 8000;
    this.logger = options.logger || console;
    this.turnLock = new Mutex();
  }

  get configured() {
    return Boolean(this.client && this.client.configured);
  }

  get busy() {
    return this.turnLock.pending > 0;
  }

  async getState() {
    return this.publicState(await this.store.read());
  }

  // --- The turn ------------------------------------------------------------

  /**
   * @returns {Promise<{request: object, response: object, turn: object, warnings: string[], state: object}>}
   * @throws {AgentError} Nothing is stored when DeepSeek fails.
   */
  ask(question) {
    let text;
    try {
      text = this.validateQuestion(question);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!this.configured) {
      return Promise.reject(new AgentError('DEEPSEEK_API_KEY is not set on the server. Add it to the environment and restart.', 503));
    }
    return this.turnLock.run(() => this._ask(text));
  }

  validateQuestion(question) {
    if (typeof question !== 'string') throw new AgentError('The question must be a string.', 400);
    const text = question.replace(/\r\n/g, '\n');
    if (!text.trim()) throw new AgentError('Please type a question first.', 400);
    if (text.length > this.maxQuestionChars) {
      throw new AgentError('The question is too long (' + text.length + ' characters, the limit is ' + this.maxQuestionChars + ').', 413);
    }
    return text;
  }

  async _ask(text) {
    const warnings = [];
    let state = await this.store.read();

    // 1. Sticky facts must cover everything outside the window before the
    //    context is built. Normally a no-op: the previous turn already did it.
    if (state.contextManagement.mode === 'sticky-facts') {
      const folded = await this._foldFacts(state);
      if (folded.state) state = folded.state;
      if (folded.warning) warnings.push(folded.warning);
    }

    // 2. Context for this question.
    const ctx = this.context.build(state, text);
    const branchId = this.context.branching.activeBranchId(state);

    // 3. DeepSeek. If this throws, nothing below runs and nothing is stored.
    const sentAt = new Date();
    const started = Date.now();
    const result = await this.client.chat({
      model: this.model,
      messages: ctx.chatMessages,
      maxTokens: this.context.maxOutputTokens
    });
    const receivedAt = new Date();
    const usage = result.usage;

    // 4. The request/response pair.
    const responseTokens = contentTokens(usage);
    const request = schema.createMessage({
      type: 'request',
      content: text,
      branchId: branchId,
      timestamp: sentAt,
      extra: {
        context: {
          mode: ctx.mode,
          messageCount: ctx.historyIds.length,
          excludedCount: ctx.excludedIds.length,
          trimmedCount: ctx.trimmedIds.length,
          factsCount: ctx.factsCount,
          estimatedTokens: ctx.estimatedTokens,
          promptTokens: usage.input
        }
      }
    });
    const response = schema.createMessage({
      type: 'response',
      content: result.content,
      branchId: branchId,
      timestamp: receivedAt,
      tokens: responseTokens,
      tokensSource: responseTokens !== null ? 'api' : 'estimate',
      extra: {
        replyTo: request.id,
        model: result.model,
        finishReason: result.finishReason,
        durationMs: Date.now() - started,
        usage: {
          promptTokens: usage.input,
          completionTokens: usage.output,
          totalTokens: usage.total,
          reasoningTokens: usage.reasoning
        }
      }
    });
    if (result.finishReason === 'length') {
      warnings.push('The answer was cut off by the output limit (MAX_OUTPUT_TOKENS).');
    }

    const contextTokens = usage.input !== null ? usage.input : ctx.estimatedTokens;
    const saved = await this.store.update((s) => {
      // The turn lock makes this impossible in practice; refuse rather than
      // write an answer into the wrong branch.
      if (this.context.branching.activeBranchId(s) !== branchId) {
        throw new AgentError('The active branch changed while the agent was answering; the answer was not saved.', 409);
      }
      s.messages.push(request, response);
      s.settings.model = result.model;
      addApiUsage(s.statistics.api, {
        calls: 1,
        promptTokens: contextTokens,
        completionTokens: usage.output !== null ? usage.output : response.tokens,
        totalTokens: usage.total !== null ? usage.total : contextTokens + response.tokens,
        estimated: usage.input === null || usage.output === null
      }, 'answer');
      s.lastTurn = {
        at: receivedAt.toISOString(),
        mode: ctx.mode,
        branchId: branchId,
        requestId: request.id,
        responseId: response.id,
        requestTokens: request.tokens,
        requestTokensSource: request.tokensSource,
        responseTokens: response.tokens,
        responseTokensSource: response.tokensSource,
        contextTokens: contextTokens,
        contextTokensSource: usage.input !== null ? 'api' : 'estimate',
        contextEstimatedTokens: ctx.estimatedTokens,
        contextMessageCount: ctx.historyIds.length,
        trimmedCount: ctx.trimmedIds.length,
        totalTokens: usage.total,
        factExtraction: null
      };
    });
    state = saved.state;

    // 5. Fold the messages that just left the window into the facts, so the
    //    next request already has them.
    if (state.contextManagement.mode === 'sticky-facts') {
      const folded = await this._foldFacts(state, true);
      if (folded.state) state = folded.state;
      if (folded.warning) warnings.push(folded.warning);
    }

    return {
      request: request,
      response: response,
      turn: state.lastTurn,
      warnings: warnings,
      state: this.publicState(state)
    };
  }

  /**
   * Extract facts from path messages that are outside the latest N but not yet
   * covered. A failure keeps the previous facts and is reported, never thrown:
   * the context builder then sends the uncovered messages in full.
   *
   * @returns {Promise<{state: object|null, warning: string|null}>}
   */
  async _foldFacts(state, recordOnTurn) {
    const branchId = this.context.branching.activeBranchId(state);
    const path = this.context.pathMessages(state);
    const memory = this.context.activeFactsMemory(state);
    const plan = this.context.stickyFacts.plan(path, memory, state.contextManagement.stickyFacts.N);
    if (!plan) return { state: null, warning: null };

    let outcome;
    try {
      outcome = await this.factExtractor.extract(memory.facts, path.slice(plan.from, plan.to), plan.from);
    } catch (err) {
      outcome = { facts: memory.facts, covered: 0, changed: { set: [], removed: [] }, usage: null, error: err.message };
    }
    if (outcome.error) this.logger.warn('[facts] extraction failed: ' + outcome.error);

    const coveredTo = plan.from + outcome.covered;
    const throughId = outcome.covered > 0 ? path[coveredTo - 1].id : null;
    const now = new Date().toISOString();

    const saved = await this.store.update((s) => {
      const current = this.context.pathMessages(s);
      const mem = this.context.stickyFacts.memory(s, branchId);
      const aligned = this.context.branching.activeBranchId(s) === branchId
        && (!throughId || (current[coveredTo - 1] && current[coveredTo - 1].id === throughId));
      if (aligned && outcome.covered > 0) {
        mem.facts = outcome.facts;
        mem.messagesCovered = coveredTo;
        mem.coveredThroughId = throughId;
        mem.updatedAt = now;
      }
      mem.lastError = outcome.error ? { message: outcome.error, at: now } : null;
      if (outcome.usage && outcome.usage.calls) addApiUsage(s.statistics.api, outcome.usage, 'facts');
      if (recordOnTurn && s.lastTurn) {
        s.lastTurn.factExtraction = {
          messages: outcome.covered,
          calls: outcome.usage ? outcome.usage.calls : 0,
          tokens: outcome.usage ? outcome.usage.totalTokens : 0,
          set: outcome.changed.set,
          removed: outcome.changed.removed,
          error: outcome.error
        };
      }
    });

    return {
      state: saved.state,
      warning: outcome.error ? 'Sticky facts were not fully updated (' + outcome.error + '). The previous facts were kept and the uncovered messages are sent in full.' : null
    };
  }

  // --- Context management --------------------------------------------------

  updateContext(patch) {
    return this._mutate((s) => this.context.applySettings(s, patch));
  }

  createCheckpoint() {
    return this._mutate((s) => this.context.createCheckpoint(s));
  }

  switchBranch(branchId) {
    return this._mutate((s) => this.context.switchBranch(s, branchId));
  }

  deleteCheckpoint(branchIdToRemove) {
    return this._mutate((s) => this.context.deleteCheckpoint(s, branchIdToRemove));
  }

  /** @returns {Promise<{result: any, state: object}>} */
  _mutate(mutator) {
    return this.turnLock.run(async () => {
      const saved = await this.store.update(mutator);
      return { result: saved.result, state: this.publicState(saved.state) };
    });
  }

  // --- The browser's view --------------------------------------------------

  /**
   * Everything the page needs to rebuild itself after a reload. Contains no
   * secrets: the API key never leaves the client module.
   */
  publicState(state) {
    const cm = state.contextManagement;
    const preview = this.context.preview(state);
    const path = this.context.pathMessages(state);
    const memory = this.context.activeFactsMemory(state);
    const covered = cm.mode === 'sticky-facts' ? this.context.stickyFacts.coverage(memory, path) : 0;

    const inContext = toSet(preview.historyIds);
    const trimmed = toSet(preview.trimmedIds);
    const messages = path.map(function (m, i) {
      let status = 'out';
      if (inContext[m.id]) status = 'in';
      else if (trimmed[m.id]) status = 'trimmed';
      else if (i < covered) status = 'facts';
      return Object.assign({}, m, { contextStatus: status });
    });

    return {
      agent: {
        configured: this.configured,
        busy: this.busy,
        model: this.model,
        factsModel: this.factsModel,
        maxQuestionChars: this.maxQuestionChars,
        contextLimitTokens: this.context.contextLimitTokens,
        maxOutputTokens: this.context.maxOutputTokens,
        contextBudgetTokens: this.context.budgetTokens
      },
      contextManagement: {
        mode: cm.mode,
        modes: schema.MODES,
        limits: schema.WINDOW_LIMITS,
        slidingWindow: { N: cm.slidingWindow.N },
        stickyFacts: {
          N: cm.stickyFacts.N,
          branchId: this.context.branching.activeBranchId(state),
          facts: Object.keys(memory.facts).sort().map(function (key) {
            return { key: key, value: memory.facts[key].value, createdAt: memory.facts[key].createdAt, updatedAt: memory.facts[key].updatedAt };
          }),
          messagesCovered: this.context.stickyFacts.coverage(memory, path),
          updatedAt: memory.updatedAt,
          lastError: memory.lastError
        },
        branching: this.context.branching.describe(state)
      },
      messages: messages,
      history: { visibleMessages: path.length, storedMessages: state.messages.length },
      context: preview,
      statistics: state.statistics,
      lastTurn: state.lastTurn,
      notices: this.store.notices.slice(),
      updatedAt: state.updatedAt
    };
  }
}

/** Tokens of the visible answer: reasoning models include thinking in completion_tokens. */
function contentTokens(usage) {
  if (!usage || usage.output === null) return null;
  return Math.max(0, usage.output - (usage.reasoning || 0));
}

function addApiUsage(api, usage, kind) {
  api.calls += usage.calls;
  if (kind === 'answer') api.answerCalls += usage.calls;
  else api.factExtractionCalls += usage.calls;
  api.promptTokens += usage.promptTokens;
  api.completionTokens += usage.completionTokens;
  api.totalTokens += usage.totalTokens;
  api.estimated = api.estimated || Boolean(usage.estimated);
}

function toSet(list) {
  const set = {};
  list.forEach(function (id) { set[id] = true; });
  return set;
}

module.exports = { DeepSeekAgent, contentTokens };
