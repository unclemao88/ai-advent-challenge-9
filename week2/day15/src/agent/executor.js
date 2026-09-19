import { mergeConflicts } from './planner.js';
import { STATES } from './stateMachine.js';
import { StepRunner, describeConflicts, sumUsage } from './stepRunner.js';
import { clip } from '../utils/validate.js';

/**
 * The execution state.
 *
 * The result is checked against the invariants before the user sees it. A
 * violating result is rejected and the model is asked to revise it (up to
 * `maxRevisions` times, within the same step). If it still violates an
 * invariant, the step ends in a conflict and the task waits for the user —
 * a violating result is never passed on as the answer.
 */
export class Executor extends StepRunner {
  constructor({ maxRevisions = 1, ...deps }) {
    super(deps);
    this.maxRevisions = maxRevisions;
  }

  /**
   * @param {{task: object, invariants: object[], userMessage?: string|null, notes?: object, requestId?: string}} input
   */
  async run({ task, invariants, userMessage = null, notes = {}, requestId }) {
    let usage = null;
    let revision = null;
    let profileRevisions = 0;
    const rejected = [];

    for (let attempt = 0; ; attempt += 1) {
      const call = await this.call(task, STATES.EXECUTION, { userMessage, notes: { ...notes, revision }, requestId });
      usage = sumUsage(usage, call.usage);
      profileRevisions += call.profileCheck.revisions;
      const { reply } = call;

      const byRule = this.checker.checkResponse(reply.response, invariants).conflicts;
      const byModel = this.checker.fromModel(reply.invariantConflicts, invariants, 'response');
      const conflicts = mergeConflicts(byRule, byModel);
      const check = { stage: 'response', ok: conflicts.length === 0, conflicts, attempt };

      // Only a result the rules reject is revised automatically. When the model
      // itself says the task cannot be done within the invariants, revising
      // cannot help: the user has to decide.
      if (byRule.length && !byModel.length && attempt < this.maxRevisions) {
        rejected.push({ check, excerpt: clip(reply.response, 300) });
        this.logger.warn('invariant.result_rejected', {
          requestId, taskId: task.id, attempt, invariants: byRule.map((c) => c.invariantId),
        });
        revision = describeConflicts(byRule);
        continue;
      }

      const updates = { ...reply.workMemory };
      delete updates.result;
      updates.intermediateResults = [reply.workMemory.result || clip(reply.response, 300)];

      return {
        state: STATES.EXECUTION,
        reply,
        usage,
        rejected,
        profileCheck: { ...call.profileCheck, revisions: profileRevisions },
        conflict: conflicts.length ? { stage: 'response', conflicts, resumeIn: STATES.EXECUTION } : null,
        check,
        workUpdates: updates,
      };
    }
  }
}
