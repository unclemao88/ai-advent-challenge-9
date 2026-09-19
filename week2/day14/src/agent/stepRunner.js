import { parseAgentReply } from './responseParser.js';

/**
 * What Planner, Executor and Validator share: build the context for one state
 * through the agent's ContextBuilder, call the LLM, parse the reply.
 *
 * The step classes decide what the reply means for their state (conflicts,
 * verdicts, revisions); they never touch storage. The Agent applies their
 * outcome to the task, the memory layers and the conversation.
 */
export class StepRunner {
  /**
   * @param {{llm: object, checker: import('./invariantChecker.js').InvariantChecker,
   *          buildContext: (task: object, state: string, options: object) => Promise<object>, logger: object}} deps
   */
  constructor({ llm, checker, buildContext, logger }) {
    this.llm = llm;
    this.checker = checker;
    this.buildContext = buildContext;
    this.logger = logger;
  }

  /**
   * @returns {Promise<{reply: object, context: object, usage: object}>}
   */
  async call(task, state, { userMessage = null, notes = {}, requestId } = {}) {
    const started = Date.now();
    const context = await this.buildContext(task, state, { userMessage, notes });
    this.logger.info('agent.step.start', {
      requestId, taskId: task.id, state, provider: this.llm.provider, model: this.llm.model,
      contextTokens: context.tokens.total, droppedTurns: context.droppedTurns, longTermSelected: context.longTermSelected?.length ?? 0,
    });
    const completion = await this.llm.complete(context.messages, { json: true, requestId, taskId: task.id });
    const reply = parseAgentReply(completion.content, state);
    const usage = {
      contextTokens: context.tokens.total,
      contextTokensExact: context.tokenizer.exact,
      promptTokens: completion.usage?.promptTokens ?? null,
      completionTokens: completion.usage?.completionTokens ?? null,
      totalTokens: completion.usage?.totalTokens ?? null,
      model: completion.model,
      calls: 1,
    };
    this.logger.info('agent.step.reply', {
      requestId, taskId: task.id, state, structured: reply.structured, suggestedNext: reply.suggestedNext,
      reportedConflicts: reply.invariantConflicts.length, ms: Date.now() - started,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    });
    return { reply, context, usage };
  }
}

/** Add up the usage of several calls made for one step. */
export function sumUsage(a, b) {
  if (!a) return b;
  const add = (x, y) => (x === null || y === null ? null : x + y);
  return {
    ...b,
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    calls: a.calls + b.calls,
  };
}

/** Conflicts as one readable paragraph for the prompt and the chat. */
export function describeConflicts(conflicts) {
  return conflicts.map((c) => `- Invariant "${c.name}" [${c.invariantId}] (${c.value}): ${c.reason}`).join('\n');
}
