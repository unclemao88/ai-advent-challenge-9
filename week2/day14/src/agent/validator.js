import { mergeConflicts } from './planner.js';
import { STATES } from './stateMachine.js';
import { StepRunner } from './stepRunner.js';

/**
 * The validation state.
 *
 * Two verdicts are combined:
 *   - the model's check of the result against objective and requirements;
 *   - the invariant check of the latest execution result, run again here,
 *     because the invariants may have changed since the result was produced.
 *
 * Failed requirements send the task back to execution (the state machine
 * limits the retries). A violated invariant stops the task and asks the user
 * whether the invariant should change — it is never waved through.
 */
export class Validator extends StepRunner {
  /**
   * @param {{task: object, invariants: object[], lastResult: string|null, userMessage?: string|null,
   *          notes?: object, requestId?: string}} input
   */
  async run({ task, invariants, lastResult, userMessage = null, notes = {}, requestId }) {
    const { reply, usage } = await this.call(task, STATES.VALIDATION, { userMessage, notes, requestId });

    const byRule = lastResult ? this.checker.checkResponse(lastResult, invariants).conflicts : [];
    const byModel = this.checker.fromModel(reply.invariantConflicts, invariants, 'response');
    const conflicts = mergeConflicts(byRule, byModel);

    let validation = reply.validation;
    if (conflicts.length) {
      validation = {
        passed: false,
        summary: validation?.summary || 'The result violates an active invariant.',
        issues: [...(validation?.issues ?? []), ...conflicts.map((c) => `Invariant "${c.name}": ${c.reason}`)],
      };
    }

    const workUpdates = { ...reply.workMemory };
    delete workUpdates.result;
    if (validation) {
      workUpdates.validationResults = [{
        text: validation.summary || (validation.passed ? 'Validation passed.' : 'Validation failed.'),
        passed: validation.passed,
      }];
    }

    return {
      state: STATES.VALIDATION,
      reply: { ...reply, validation },
      usage,
      conflict: conflicts.length ? { stage: 'validation', conflicts, resumeIn: STATES.EXECUTION } : null,
      check: { stage: 'validation', ok: conflicts.length === 0, conflicts },
      workUpdates,
    };
  }
}
