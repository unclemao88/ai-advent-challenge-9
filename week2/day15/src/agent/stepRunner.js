import { parseAgentReply } from './responseParser.js';
import { ProfileChecker, describeProfileIssues } from '../profile/profileChecker.js';

/**
 * What Planner, Executor and Validator share: build the context for one state
 * through the agent's ContextBuilder, call the LLM, parse the reply, and check
 * the reply against the user profile.
 *
 * A reply that breaks a readable profile rule (a word limit, "no code", plain
 * text…) is not accepted silently: the model is asked once more, with the
 * issues, for a corrected response (`maxProfileRevisions`). If the correction
 * still breaks the profile, the step goes on with the issues attached, and
 * the answer shows them.
 *
 * The step classes decide what the reply means for their state (conflicts,
 * verdicts, revisions); they never touch storage. The Agent applies their
 * outcome to the task, the memory layers and the chat history.
 */
export class StepRunner {
  /**
   * @param {{llm: object, checker: import('./invariantChecker.js').InvariantChecker,
   *          buildContext: (task: object, state: string, options: object) => Promise<object>, logger: object,
   *          profileChecker?: ProfileChecker, maxProfileRevisions?: number}} deps
   */
  constructor({ llm, checker, buildContext, logger, profileChecker = new ProfileChecker(), maxProfileRevisions = 1 }) {
    this.llm = llm;
    this.checker = checker;
    this.buildContext = buildContext;
    this.logger = logger;
    this.profileChecker = profileChecker;
    this.maxProfileRevisions = maxProfileRevisions;
  }

  /**
   * @returns {Promise<{reply: object, context: object, usage: object,
   *   profileCheck: {ok: boolean, issues: object[], revisions: number}}>}
   */
  async call(task, state, { userMessage = null, notes = {}, requestId } = {}) {
    let usage = null;
    let profileRevision = null;
    for (let revisions = 0; ; revisions += 1) {
      const { reply, context, usage: callUsage } = await this.#callOnce(task, state, {
        userMessage, notes: { ...notes, profileRevision }, requestId,
      });
      usage = sumUsage(usage, callUsage);

      const check = this.profileChecker.check(context.profile, reply.response);
      if (!check.ok && revisions < this.maxProfileRevisions) {
        this.logger.warn('profile.response_rejected', {
          requestId, taskId: task.id, state, rules: check.issues.map((i) => i.rule), attempt: revisions,
        });
        profileRevision = describeProfileIssues(check.issues);
        continue;
      }
      if (!check.ok) {
        this.logger.warn('profile.response_accepted_with_issues', { requestId, taskId: task.id, state, rules: check.issues.map((i) => i.rule) });
      }
      return { reply, context, usage, profileCheck: { ok: check.ok, issues: check.issues, revisions } };
    }
  }

  async #callOnce(task, state, { userMessage, notes, requestId }) {
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
      requestId, taskId: task.id, state, structured: reply.structured, proposedNext: reply.proposedNext,
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
