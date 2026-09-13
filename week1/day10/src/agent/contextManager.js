'use strict';

const AgentError = require('./errors').AgentError;
const schema = require('../storage/schema');
const prompts = require('./prompts');
const SlidingWindowManager = require('./slidingWindow').SlidingWindowManager;
const StickyFactsManager = require('./stickyFacts').StickyFactsManager;
const BranchingManager = require('./branching').BranchingManager;

// The local estimator is within roughly ±15% of DeepSeek's tokenizer, so the
// estimated prompt is kept 15% under the real budget.
const ESTIMATE_HEADROOM = 0.85;

/**
 * The single place that decides what DeepSeek sees.
 *
 *   complete history  = state.messages (every branch, never trimmed here)
 *   active path       = base + active branch (BranchingManager)
 *   model context     = system prompt [+ facts] + the mode's selection of the
 *                       path + the current question, trimmed to the token budget
 *
 * It also applies context-management changes (mode, N, checkpoints) to the
 * state, so the rules live here rather than in routes or the browser.
 */
class ContextManager {
  /**
   * @param {{tokenService: object, contextLimitTokens: number, maxOutputTokens: number}} options
   */
  constructor(options) {
    this.tokenService = options.tokenService;
    this.contextLimitTokens = options.contextLimitTokens;
    this.maxOutputTokens = options.maxOutputTokens;
    this.slidingWindow = new SlidingWindowManager();
    this.stickyFacts = new StickyFactsManager();
    this.branching = new BranchingManager();
  }

  /** Estimated prompt tokens allowed: (limit − output reservation) × headroom. */
  get budgetTokens() {
    return Math.max(1, Math.floor((this.contextLimitTokens - this.maxOutputTokens) * ESTIMATE_HEADROOM));
  }

  pathMessages(state) {
    return this.branching.pathMessages(state);
  }

  activeFactsMemory(state) {
    return this.stickyFacts.memory(state, this.branching.activeBranchId(state));
  }

  /** The mode's choice of messages, before the token budget is applied. */
  select(state) {
    const cm = state.contextManagement;
    const path = this.pathMessages(state);
    let selection;
    if (cm.mode === 'sticky-facts') {
      selection = this.stickyFacts.select(path, cm.stickyFacts.N, this.activeFactsMemory(state));
    } else if (cm.mode === 'branching') {
      selection = Object.assign({ uncoveredIncluded: 0, facts: null }, this.branching.select(path));
    } else {
      selection = Object.assign({ uncoveredIncluded: 0, facts: null }, this.slidingWindow.select(path, cm.slidingWindow.N));
    }
    return Object.assign({ mode: cm.mode, path: path }, selection);
  }

  /**
   * Build the chat-completions messages for a question. Oldest history
   * messages are dropped until the estimate fits the budget; the system prompt,
   * the facts and the question are never dropped.
   *
   * @param {object} state
   * @param {string|null} question null builds a preview of the next context.
   * @throws {AgentError} 413 when even the question alone does not fit.
   */
  build(state, question) {
    const cm = state.contextManagement;
    const sel = this.select(state);
    const history = sel.history.slice();
    const trimmed = [];
    const activeId = this.branching.activeBranchId(state);
    const activeBranch = cm.branching.branches.filter(function (b) { return b.id === activeId; })[0];
    const count = (text) => this.tokenService.count(text) + this.tokenService.MESSAGE_OVERHEAD_TOKENS;

    const systemPrompt = () => prompts.buildAgentSystemPrompt({
      mode: cm.mode,
      N: cm.mode === 'sticky-facts' ? cm.stickyFacts.N : cm.slidingWindow.N,
      branchName: activeBranch ? activeBranch.name : 'Main',
      facts: sel.facts,
      olderOmitted: sel.excluded.length + trimmed.length > 0,
      trimmedForLimit: trimmed.length > 0
    });

    const questionTokens = typeof question === 'string' ? count(question) : 0;
    let historyTokens = history.reduce(function (sum, m) { return sum + count(m.content); }, 0);
    let system = systemPrompt();
    let estimate = count(system) + historyTokens + questionTokens;

    while (estimate > this.budgetTokens && history.length > 0) {
      const dropped = history.shift();
      trimmed.push(dropped);
      historyTokens -= count(dropped.content);
      system = systemPrompt();
      estimate = count(system) + historyTokens + questionTokens;
    }
    const overLimit = estimate > this.budgetTokens;
    if (overLimit && typeof question === 'string') {
      throw new AgentError('The question is too long for the configured context limit (~'
        + this.tokenService.format(estimate) + ' tokens, budget ~' + this.tokenService.format(this.budgetTokens) + ').', 413);
    }

    const chatMessages = [{ role: 'system', content: system }].concat(history.map(function (m) {
      return { role: m.type === 'request' ? 'user' : 'assistant', content: m.content };
    }));
    if (typeof question === 'string') chatMessages.push({ role: 'user', content: question });

    return {
      mode: cm.mode,
      chatMessages: chatMessages,
      historyIds: ids(history),
      excludedIds: ids(sel.excluded),
      trimmedIds: ids(trimmed),
      pathLength: sel.path.length,
      uncoveredIncluded: sel.uncoveredIncluded,
      factsCount: sel.facts ? Object.keys(sel.facts).length : 0,
      systemTokens: count(system),
      questionTokens: questionTokens,
      estimatedTokens: estimate,
      budgetTokens: this.budgetTokens,
      overLimit: overLimit
    };
  }

  /** What the next request would send, without a question. For the UI. */
  preview(state) {
    const built = this.build(state, null);
    delete built.chatMessages;
    return built;
  }

  // --- Changes to context-management state ---------------------------------

  /**
   * Apply {mode?, slidingWindow?: {N}, stickyFacts?: {N}}. Everything is
   * validated before anything changes. Other modes' settings are untouched,
   * so switching away and back restores them.
   */
  applySettings(state, patch) {
    if (!schema.isObject(patch)) throw new AgentError('Expected a JSON object with context settings.', 400);
    const cm = state.contextManagement;
    const changes = {};

    if (patch.mode !== undefined) {
      if (schema.MODE_IDS.indexOf(patch.mode) === -1) {
        throw new AgentError('Unknown context-management mode. Use one of: ' + schema.MODE_IDS.join(', ') + '.', 400);
      }
      changes.mode = patch.mode;
    }
    ['slidingWindow', 'stickyFacts'].forEach(function (section) {
      if (patch[section] === undefined) return;
      if (!schema.isObject(patch[section]) || patch[section].N === undefined) {
        throw new AgentError(section + ' must be an object like {"N": 10}.', 400);
      }
      const n = schema.parseWindowSize(patch[section].N);
      if (n === null) {
        throw new AgentError((section === 'slidingWindow' ? 'Number of messages' : 'Keep latest messages')
          + ' must be a whole number from ' + schema.WINDOW_LIMITS.min + ' to ' + schema.WINDOW_LIMITS.max + '.', 400);
      }
      changes[section] = n;
    });
    if (!Object.keys(changes).length) throw new AgentError('Nothing to change.', 400);

    if (changes.mode) cm.mode = changes.mode;
    if (changes.slidingWindow) cm.slidingWindow.N = changes.slidingWindow;
    if (changes.stickyFacts) cm.stickyFacts.N = changes.stickyFacts;
    return changes;
  }

  createCheckpoint(state) {
    requireBranchingMode(state);
    const checkpoint = this.branching.createCheckpoint(state);
    this.stickyFacts.forkMemory(state, schema.MAIN_BRANCH, checkpoint.branchIds);
    return checkpoint;
  }

  switchBranch(state, branchId) {
    requireBranchingMode(state);
    return this.branching.switchBranch(state, branchId);
  }

  deleteCheckpoint(state, branchIdToRemove) {
    requireBranchingMode(state);
    const result = this.branching.deleteCheckpoint(state, branchIdToRemove);
    this.stickyFacts.adoptMemory(state, result.survivorBranchId, [result.removedBranchId]);
    return result;
  }
}

function requireBranchingMode(state) {
  if (state.contextManagement.mode !== 'branching') {
    throw new AgentError('Checkpoints are available in the Branching context-management mode.', 409);
  }
}

function ids(messages) {
  return messages.map(function (m) { return m.id; });
}

module.exports = { ContextManager, ESTIMATE_HEADROOM };
