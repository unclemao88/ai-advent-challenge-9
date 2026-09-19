import { STATES } from './stateMachine.js';
import { StepRunner } from './stepRunner.js';

/**
 * The planning state.
 *
 * Before any API call, `precheck()` checks the user's request against the
 * active invariants: a request that plainly asks to break one ("rewrite the
 * backend in Python" under "Backend: Node.js") stops the task right there and
 * asks the user, without spending a DeepSeek call.
 *
 * After the call, the plan is checked twice: by the rules (`checkPlan`) and by
 * what the model itself reported in `invariantConflicts`.
 */
export class Planner extends StepRunner {
  /**
   * @param {string} request The user's message.
   * @param {object[]} invariants
   * @returns {{ok: boolean, stage: string, conflicts: object[]}}
   */
  precheck(request, invariants) {
    return this.checker.check({ type: 'request', text: request }, invariants);
  }

  /**
   * @param {{task: object, invariants: object[], userMessage?: string|null, notes?: object, requestId?: string}} input
   * @returns {Promise<object>} The step outcome (see Agent#applyOutcome).
   */
  async run({ task, invariants, userMessage = null, notes = {}, requestId }) {
    const { reply, usage, profileCheck } = await this.call(task, STATES.PLANNING, { userMessage, notes, requestId });

    const byRule = this.checker.checkPlan({ steps: reply.workMemory.plan ?? [], text: reply.response }, invariants).conflicts;
    const byModel = this.checker.fromModel(reply.invariantConflicts, invariants, 'plan');
    const conflicts = mergeConflicts(byRule, byModel);

    return {
      state: STATES.PLANNING,
      reply,
      usage,
      profileCheck,
      conflict: conflicts.length ? { stage: 'plan', conflicts, resumeIn: STATES.PLANNING } : null,
      check: { stage: 'plan', ok: conflicts.length === 0, conflicts },
      workUpdates: workUpdates(reply),
    };
  }
}

export function mergeConflicts(...lists) {
  const seen = new Set();
  const out = [];
  for (const conflict of lists.flat()) {
    const key = `${conflict.invariantId}|${conflict.method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(conflict);
  }
  return out;
}

function workUpdates(reply) {
  const { result, ...rest } = reply.workMemory; // eslint-disable-line no-unused-vars
  return rest;
}
