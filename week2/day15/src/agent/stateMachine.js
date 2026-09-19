/**
 * The task state machine: the single place that defines states and legal
 * transitions. Every state change in the application goes through
 * `transition()`, which checks it against TRANSITIONS.
 *
 * Mandatory lifecycle (no stage can be skipped):
 *
 *     planning ──▶ execution ──▶ validation ──▶ done
 *       ↺  ▲          ↺  │  ▲         ↺ │
 *          └──────────────┘  └──────────┘
 *        (re-plan)         (fix after a failed validation)
 *
 *   planning / execution / validation ──▶ paused    ──▶ the same state (resume)
 *   planning / execution / validation ──▶ failed    ──▶ the same state (retry)
 *   planning / execution / validation / paused / failed ──▶ cancelled
 *
 * A self-transition (↺) re-runs the stage: the user added information or
 * answered a question, or a restart interrupted the step.
 *
 * Transition table (from → allowed targets):
 *
 *   planning    → planning, execution, paused, failed, cancelled
 *   execution   → execution, validation, planning, paused, failed, cancelled
 *   validation  → validation, execution, done, paused, failed, cancelled
 *   paused      → the state it was paused in, cancelled
 *   failed      → the state that failed (retry), cancelled
 *   done        → (final)
 *   cancelled   → (final)
 *
 * So planning → validation, planning → done and execution → done are illegal.
 *
 * "Waiting for the user" is not a state. When the agent needs an answer, or an
 * invariant conflict needs a decision, the task stays in the state it is in
 * (the current valid state) with `awaitingInput` set, until the user answers.
 *
 * Everything here is pure: functions take a task and return a new one. They
 * know nothing about DeepSeek, storage or HTTP. The model may *propose* the
 * next state; a proposal the table does not allow is rejected and recorded,
 * never applied.
 *
 * Task fields owned by this module:
 *   state            the current state
 *   stepStatus       for planning/execution/validation: pending (entered, not run yet),
 *                    running (DeepSeek call in progress), completed (ran; waiting for continue)
 *   status           active | paused | failed | done | cancelled
 *   nextState        where "continue" goes (null when the task is finished)
 *   plannedAction    what happens on "continue", in words
 *   currentAction    what the agent is doing (or waiting for) right now
 *   mode             manual (stop after every state) | auto (run through)
 *   resumeState      the state to return to from paused, or to retry from failed
 *   awaitingInput    null | { reason: question | invariant_conflict | validation_retries, since }
 *   pendingConflict  the invariant conflict the user must decide on
 *   validation       { attempts, lastVerdict }
 *   completion       null | { outcome: done | cancelled, completedAt, summary }
 *   rejectedTransitions  proposals of the model that the table refused
 *   history          [{ from, to, timestamp, reason }]
 */

export const STATES = Object.freeze({
  PLANNING: 'planning',
  EXECUTION: 'execution',
  VALIDATION: 'validation',
  DONE: 'done',
  PAUSED: 'paused',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const ALL_STATES = Object.freeze(Object.values(STATES));
/** The mandatory order. */
export const LIFECYCLE = Object.freeze([STATES.PLANNING, STATES.EXECUTION, STATES.VALIDATION, STATES.DONE]);
/** States that run a DeepSeek call. */
export const WORK_STATES = Object.freeze([STATES.PLANNING, STATES.EXECUTION, STATES.VALIDATION]);
export const FINAL_STATES = Object.freeze([STATES.DONE, STATES.CANCELLED]);
export const MODES = Object.freeze(['manual', 'auto']);
export const STATUSES = Object.freeze({
  ACTIVE: 'active', PAUSED: 'paused', FAILED: 'failed', DONE: 'done', CANCELLED: 'cancelled',
});
export const AWAITING_REASONS = Object.freeze(['question', 'invariant_conflict', 'validation_retries']);

export const TRANSITIONS = Object.freeze({
  planning: Object.freeze(['planning', 'execution', 'paused', 'failed', 'cancelled']),
  execution: Object.freeze(['execution', 'validation', 'planning', 'paused', 'failed', 'cancelled']),
  validation: Object.freeze(['validation', 'execution', 'done', 'paused', 'failed', 'cancelled']),
  paused: Object.freeze(['planning', 'execution', 'validation', 'cancelled']),
  failed: Object.freeze(['planning', 'execution', 'validation', 'cancelled']),
  done: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** The forward step of each working state. */
export const DEFAULT_NEXT = Object.freeze({
  planning: 'execution',
  execution: 'validation',
  validation: 'done',
});

/** What running each state means, in the words shown to the user. */
export const STATE_ACTIONS = Object.freeze({
  planning: 'Analyze the request, define the implementation approach and verify the plan against the active invariants.',
  execution: 'Implement the approved plan and prepare the result for validation, within the active invariants.',
  validation: 'Validate the result against the objective, the requirements and the active invariants.',
  done: 'Finish the task and summarize the outcome.',
});

export const NONE = 'none';

export class InvalidTransitionError extends Error {
  constructor(from, to, why = '') {
    super(`Invalid task transition: ${from ?? '(none)'} → ${to}${why ? ` (${why})` : ''}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function isWorkState(state) {
  return WORK_STATES.includes(state);
}

export function isFinal(task) {
  return FINAL_STATES.includes(task.state);
}

/** The states a task may move to from where it is now (the table plus the paused/failed guard). */
export function allowedTransitions(task) {
  const targets = TRANSITIONS[task.state] ?? [];
  if (task.state === STATES.PAUSED || task.state === STATES.FAILED) {
    return targets.filter((to) => to === task.resumeState || to === STATES.CANCELLED);
  }
  return [...targets];
}

export function canTransition(task, to) {
  return allowedTransitions(task).includes(to);
}

/** Why `from → to` is illegal, in words. */
export function explainIllegal(task, to) {
  const from = task.state;
  if (!ALL_STATES.includes(to)) return `"${to}" is not a state`;
  if (FINAL_STATES.includes(from)) return `the task is already ${from}`;
  if (from === STATES.PAUSED) return `a paused task can only resume in ${task.resumeState} (or be cancelled)`;
  if (from === STATES.FAILED) return `a failed task can only be retried in ${task.resumeState} (or be cancelled)`;
  const a = LIFECYCLE.indexOf(from);
  const b = LIFECYCLE.indexOf(to);
  if (a !== -1 && b > a + 1) return `it would skip ${LIFECYCLE.slice(a + 1, b).join(' and ')}`;
  return 'not in the transition table';
}

export function assertTransition(task, to) {
  if (!canTransition(task, to)) throw new InvalidTransitionError(task.state, to, explainIllegal(task, to));
}

/** Record `state → to`. Only the state and history change; callers set the rest. */
export function transition(task, to, { reason = '', now = new Date() } = {}) {
  assertTransition(task, to);
  const timestamp = now.toISOString();
  return {
    ...task,
    state: to,
    history: [...task.history, { from: task.state, to, timestamp, reason }].slice(-200),
    updatedAt: timestamp,
  };
}

export function describeAction(state) {
  if (!state) return NONE;
  return STATE_ACTIONS[state] ?? NONE;
}

/**
 * Validate the model's proposed next state after `state` ran.
 *
 * @returns {{next: string, rejected: {from: string, to: string, reason: string}|null}}
 *   `next` is always legal: the proposal when the table allows it, else the
 *   default forward step. `rejected` describes a refused proposal.
 */
export function resolveNextState(state, proposed) {
  const fallback = DEFAULT_NEXT[state] ?? null;
  if (proposed === null || proposed === undefined || proposed === '' || proposed === fallback || proposed === state) {
    return { next: fallback, rejected: null };
  }
  const reject = (reason) => ({ next: fallback, rejected: { from: state, to: String(proposed).slice(0, 40), reason } });
  if (!ALL_STATES.includes(proposed)) return reject(`"${String(proposed).slice(0, 40)}" is not a state`);
  if ([STATES.PAUSED, STATES.FAILED, STATES.CANCELLED].includes(proposed)) return reject('only the user or an error can pause, fail or cancel a task');
  if (!(TRANSITIONS[state] ?? []).includes(proposed)) return reject(explainIllegal({ state }, proposed));
  return { next: proposed, rejected: null };
}

/**
 * A new task in `planning`, its step pending (ready to run).
 * @param {{id: string, title: string, request: string, mode: 'manual'|'auto', now?: Date}} input
 */
export function createTask({ id, title, request, mode, now = new Date() }) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const timestamp = now.toISOString();
  const task = {
    id,
    title,
    objective: request,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: STATUSES.ACTIVE,
    state: STATES.PLANNING,
    stepStatus: 'pending',
    nextState: STATES.PLANNING,
    plannedAction: describeAction(STATES.PLANNING),
    mode,
    resumeState: null,
    pauseRequested: false,
    awaitingInput: null,
    pendingConflict: null,
    keepInvariants: false,
    resolvedConflict: null,
    validation: { attempts: 0, lastVerdict: null },
    revisions: 0,
    rejectedTransitions: [],
    lastError: null,
    lastUsage: null,
    completion: null,
    workMemory: { layer: 'work', key: id },
    history: [{ from: null, to: STATES.PLANNING, timestamp, reason: 'task created' }],
  };
  return { ...task, currentAction: currentActionOf(task) };
}

/**
 * Start running a working state. Entering a different state is a transition;
 * running the pending step of the current state is not; running a completed
 * state again is a recorded self-transition (a re-run).
 */
export function beginStep(task, state, { reason = '', now = new Date() } = {}) {
  if (!isWorkState(state)) throw new InvalidTransitionError(task.state, state, 'not a working state');
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, state, 'a step is already running');
  const samePending = task.state === state && task.stepStatus === 'pending' && task.status === STATUSES.ACTIVE;
  const moved = samePending ? { ...task, updatedAt: now.toISOString() } : transition(task, state, { reason, now });
  const next = DEFAULT_NEXT[state];
  return {
    ...moved,
    status: STATUSES.ACTIVE,
    stepStatus: 'running',
    nextState: next,
    plannedAction: describeAction(next),
    resumeState: null,
    awaitingInput: null,
    pendingConflict: null,
    lastError: null,
  };
}

/**
 * The running step finished. Decide what comes next and whether to stop.
 *
 * @param {object} task
 * @param {{proposedNext?: string|null, plannedAction?: string, needsUserInput?: boolean,
 *          conflict?: {stage: string, conflicts: object[], resumeIn?: string}|null,
 *          verdict?: {passed: boolean, summary?: string, issues?: string[]}|null,
 *          maxValidationRetries?: number, now?: Date}} outcome
 * @returns {{task: object, autoContinue: boolean, rejected: object|null,
 *            announce: {currentState: string, nextState: string|null, plannedAction: string}}}
 *          `announce` is what the answer to the user shows: the state that ran,
 *          where it goes next and what that will do. `autoContinue` tells an
 *          auto-mode runner whether it may go on without the user.
 */
export function completeStep(task, {
  proposedNext = null, plannedAction, needsUserInput = false, conflict = null,
  verdict = null, maxValidationRetries = 2, now = new Date(),
} = {}) {
  const state = task.state;
  if (!isWorkState(state) || task.stepStatus !== 'running') {
    throw new InvalidTransitionError(state, proposedNext ?? '?', 'no step is running');
  }
  const timestamp = now.toISOString();
  const base = { ...task, stepStatus: 'completed', updatedAt: timestamp };

  // An invariant conflict always stops, whatever the mode. The task stays in
  // its current state; the decision re-runs the stage it belongs to.
  if (conflict?.conflicts?.length) {
    const names = [...new Set(conflict.conflicts.map((c) => `"${c.name}"`))].join(', ');
    const plural = names.includes(',');
    const resumeIn = legalOr(state, conflict.resumeIn, state);
    const action = `Request permission to modify the invariant${plural ? 's' : ''} ${names}, or keep ${plural ? 'them' : 'it'} and re-work the task within ${plural ? 'them' : 'it'}.`;
    const waiting = await_(base, { reason: 'invariant_conflict', nextState: resumeIn, plannedAction: action, conflict, timestamp });
    return finish(waiting, state, { autoContinue: false, rejected: null });
  }

  if (needsUserInput) {
    const resumeIn = state === STATES.VALIDATION ? STATES.EXECUTION : state;
    const action = plannedAction?.trim() || `Answer the question; the ${resumeIn} step then continues with your answer.`;
    const waiting = await_(base, { reason: 'question', nextState: resumeIn, plannedAction: action, timestamp });
    return finish(waiting, state, { autoContinue: false, rejected: null });
  }

  let { next, rejected } = resolveNextState(state, proposedNext);
  let action = plannedAction?.trim() || null;
  const validation = { ...(task.validation ?? { attempts: 0, lastVerdict: null }) };

  if (state === STATES.VALIDATION && verdict) {
    // The verdict decides between done and another round, whatever was proposed.
    validation.lastVerdict = { passed: verdict.passed, summary: verdict.summary ?? '', issues: verdict.issues ?? [], at: timestamp };
    if (verdict.passed) {
      next = STATES.DONE;
    } else {
      validation.attempts += 1;
      next = STATES.EXECUTION;
      if (validation.attempts > maxValidationRetries) {
        const tooMany = `Validation failed ${validation.attempts} times. Give feedback in the chat, or continue to try the execution step again.`;
        const waiting = await_({ ...base, validation }, {
          reason: 'validation_retries', nextState: STATES.EXECUTION, plannedAction: tooMany, timestamp,
        });
        return finish(waiting, state, { autoContinue: false, rejected });
      }
    }
    if (rejected && rejected.to === next) rejected = null;
  }
  if (next === STATES.DONE) action = STATE_ACTIONS.done;
  if (!action) action = describeAction(next);

  let result = {
    ...base,
    validation,
    nextState: next,
    plannedAction: action,
    rejectedTransitions: rejected ? [...(task.rejectedTransitions ?? []), { ...rejected, at: timestamp }].slice(-20) : task.rejectedTransitions ?? [],
  };
  if (result.pauseRequested) {
    result = pause(result, { now });
    return finish(result, state, { autoContinue: false, rejected });
  }
  return finish(result, state, { autoContinue: result.mode === 'auto' && next !== null, rejected });
}

function finish(task, ranState, { autoContinue, rejected }) {
  const out = { ...task, currentAction: currentActionOf(task) };
  return {
    task: out,
    autoContinue,
    rejected,
    announce: { currentState: ranState, nextState: out.nextState, plannedAction: out.plannedAction },
  };
}

function legalOr(state, wanted, fallback) {
  return wanted && (TRANSITIONS[state] ?? []).includes(wanted) ? wanted : fallback;
}

/**
 * The user's request conflicts with an invariant before any step ran: stay in
 * the current state and wait for the decision. `resumeIn` is the stage the
 * decision will run.
 */
export function waitForDecision(task, { conflict, resumeIn, now = new Date() }) {
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, task.state, 'a step is running');
  if (task.status !== STATUSES.ACTIVE) throw new InvalidTransitionError(task.state, task.state, `the task is ${task.status}`);
  const to = task.state === resumeIn || canTransition(task, resumeIn) ? resumeIn : task.state;
  const names = [...new Set(conflict.conflicts.map((c) => `"${c.name}"`))].join(', ');
  const plural = names.includes(',');
  const action = `Request permission to modify the invariant${plural ? 's' : ''} ${names}, or keep ${plural ? 'them' : 'it'} and re-work the task within ${plural ? 'them' : 'it'}.`;
  return finish(await_(task, { reason: 'invariant_conflict', nextState: to, plannedAction: action, conflict, timestamp: now.toISOString() }),
    task.state, { autoContinue: false, rejected: null });
}

/** Stay in the current state and wait for the user. `nextState` is where the answer (or decision) goes. */
function await_(task, { reason, nextState, plannedAction, conflict = null, timestamp }) {
  return {
    ...task,
    status: STATUSES.ACTIVE,
    nextState,
    plannedAction,
    awaitingInput: { reason, since: timestamp },
    pendingConflict: conflict ? { ...conflict, detectedAt: timestamp } : null,
    pauseRequested: false,
    updatedAt: timestamp,
  };
}

/**
 * Which state a new user message runs, for an unfinished task:
 *   awaiting input              → its nextState (the answer continues the task)
 *   pending step                → that step
 *   planning / execution done   → the same state again, with the message as input
 *   validation done             → execution (the message is feedback on the result)
 *   failed                      → the state that failed
 * Returns null when the task cannot take a message (running, paused, finished).
 */
export function stateForUserMessage(task) {
  if (task.status === STATUSES.FAILED) return task.resumeState ?? null;
  if (task.status !== STATUSES.ACTIVE || task.stepStatus === 'running') return null;
  if (task.awaitingInput) return task.nextState;
  if (task.stepStatus === 'pending') return task.state;
  if (task.state === STATES.VALIDATION) return STATES.EXECUTION;
  return isWorkState(task.state) ? task.state : null;
}

/**
 * The "continue" control: move to nextState and start it (or finish the
 * task). Also retries a failed step. Refused while a question or an
 * invariant conflict is open: those need the user's answer or decision.
 */
export function advance(task, { reason = 'continue', now = new Date() } = {}) {
  if (task.state === STATES.DONE) throw new InvalidTransitionError(task.state, '?', 'the task is already finished');
  if (task.state === STATES.CANCELLED) throw new InvalidTransitionError(task.state, '?', 'the task was cancelled');
  if (task.state === STATES.PAUSED) throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'the task is paused; resume it first');
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'a step is still running');
  if (task.awaitingInput?.reason === 'question') {
    throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'the agent is waiting for your answer; reply in the chat');
  }
  if (task.awaitingInput?.reason === 'invariant_conflict') {
    throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'an invariant conflict needs your decision first');
  }
  if (task.state === STATES.FAILED) return beginStep(task, task.resumeState, { reason: `retry: ${reason}`, now });
  const to = task.nextState;
  if (!to) throw new InvalidTransitionError(task.state, '?', 'there is no next state');
  if (to === STATES.DONE) return complete(task, { reason, now });
  return beginStep(task, to, { reason, now });
}

/** A decision on an invariant conflict: leave the waiting state and run its next state. */
export function resolveAwaiting(task, { reason, now = new Date(), ...changes }) {
  if (!task.awaitingInput) throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'the task is not waiting for a decision');
  return beginStep({ ...task, ...changes, awaitingInput: null }, task.nextState, { reason, now });
}

export function complete(task, { reason = 'validation passed', now = new Date(), summary = '' } = {}) {
  const moved = transition(task, STATES.DONE, { reason, now });
  const done = {
    ...moved,
    status: STATUSES.DONE,
    stepStatus: 'completed',
    nextState: null,
    plannedAction: NONE,
    pauseRequested: false,
    awaitingInput: null,
    pendingConflict: null,
    completion: { outcome: STATES.DONE, completedAt: now.toISOString(), summary },
  };
  return { ...done, currentAction: currentActionOf(done) };
}

/**
 * Pause the task. A task between steps pauses at once; a running one gets
 * `pauseRequested` and pauses when its step completes. Work memory and the
 * conversation are untouched: resuming continues exactly here.
 */
export function pause(task, { now = new Date() } = {}) {
  if (task.state === STATES.PAUSED) return task;
  if (task.status !== STATUSES.ACTIVE) {
    throw new InvalidTransitionError(task.state, STATES.PAUSED, `the task is ${task.status}`);
  }
  if (task.stepStatus === 'running') return { ...task, pauseRequested: true, updatedAt: now.toISOString() };
  const moved = transition(task, STATES.PAUSED, { reason: 'paused by user', now });
  const paused = { ...moved, status: STATUSES.PAUSED, resumeState: task.state, pauseRequested: false };
  return { ...paused, currentAction: currentActionOf(paused) };
}

/** Return a paused task to the state it was paused in. Next state, planned action and any open question are unchanged. */
export function resume(task, { now = new Date() } = {}) {
  if (task.state !== STATES.PAUSED) throw new InvalidTransitionError(task.state, task.resumeState ?? '?', 'the task is not paused');
  const moved = transition(task, task.resumeState, { reason: 'resumed by user', now });
  const resumed = { ...moved, status: STATUSES.ACTIVE, resumeState: null, pauseRequested: false };
  return { ...resumed, currentAction: currentActionOf(resumed) };
}

/** A step failed (API error, storage error). Continue retries the same state. */
export function fail(task, message, { now = new Date() } = {}) {
  const from = task.state;
  if (!isWorkState(from)) throw new InvalidTransitionError(from, STATES.FAILED, 'only a working state can fail');
  const moved = transition(task, STATES.FAILED, { reason: 'step failed', now });
  const failed = {
    ...moved,
    status: STATUSES.FAILED,
    stepStatus: 'completed',
    resumeState: from,
    nextState: from,
    plannedAction: `Retry the ${from} step.`,
    lastError: message,
    pauseRequested: false,
  };
  return { ...failed, currentAction: currentActionOf(failed) };
}

/** Stop the task for good. */
export function cancel(task, { reason = 'cancelled by user', now = new Date() } = {}) {
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, STATES.CANCELLED, 'a step is still running');
  const moved = transition(task, STATES.CANCELLED, { reason, now });
  const cancelled = {
    ...moved,
    status: STATUSES.CANCELLED,
    stepStatus: 'completed',
    resumeState: null,
    nextState: null,
    plannedAction: NONE,
    awaitingInput: null,
    pendingConflict: null,
    pauseRequested: false,
    completion: { outcome: STATES.CANCELLED, completedAt: now.toISOString(), summary: reason },
  };
  return { ...cancelled, currentAction: currentActionOf(cancelled) };
}

/**
 * After a restart, a task whose step was running was interrupted. It is put
 * back to "pending" in the same state, so continue re-runs that step (or
 * paused, if a pause had been requested).
 */
export function recoverInterrupted(task, { now = new Date() } = {}) {
  if (task.stepStatus !== 'running') return task;
  const recovered = {
    ...task,
    stepStatus: 'pending',
    nextState: task.state,
    plannedAction: `Re-run the ${task.state} step (it was interrupted by a server restart).`,
    updatedAt: now.toISOString(),
  };
  const out = task.pauseRequested ? pause(recovered, { now }) : recovered;
  return { ...out, currentAction: currentActionOf(out) };
}

export function setMode(task, mode, { now = new Date() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  if (isFinal(task)) throw new InvalidTransitionError(task.state, task.state, `the task is ${task.state}`);
  const updated = { ...task, mode, updatedAt: now.toISOString() };
  return { ...updated, currentAction: currentActionOf(updated) };
}

/** What the agent is doing, or waiting for, right now. Derived from the task, never invented. */
export function currentActionOf(task) {
  if (FINAL_STATES.includes(task.state)) return NONE;
  if (task.state === STATES.PAUSED) return `Paused by the user in ${task.resumeState}. Resume to continue.`;
  if (task.state === STATES.FAILED) return `Stopped by an error in the ${task.resumeState} step.`;
  if (task.stepStatus === 'running') return STATE_ACTIONS[task.state];
  if (task.awaitingInput?.reason === 'question') return 'Waiting for your answer to the agent\'s question.';
  if (task.awaitingInput?.reason === 'invariant_conflict') return 'Waiting for your decision on the invariant conflict.';
  if (task.awaitingInput?.reason === 'validation_retries') return 'Waiting for your feedback after repeated validation failures.';
  if (task.stepStatus === 'pending') return `Ready to run the ${task.state} step.`;
  return task.mode === 'manual'
    ? `The ${task.state} step is finished. Waiting for you to continue (manual mode).`
    : `The ${task.state} step is finished.`;
}

/** The part of a task the UI and the API show. */
export function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    objective: task.objective,
    status: task.status,
    state: task.state,
    stepStatus: task.stepStatus,
    nextState: task.nextState,
    plannedAction: task.plannedAction,
    currentAction: task.currentAction ?? currentActionOf(task),
    mode: task.mode,
    allowedStates: ALL_STATES,
    allowedTransitions: allowedTransitions(task),
    resumeState: task.resumeState,
    pauseRequested: Boolean(task.pauseRequested),
    awaitingInput: task.awaitingInput ?? null,
    pendingConflict: task.pendingConflict ?? null,
    keepInvariants: Boolean(task.keepInvariants),
    validation: task.validation ?? { attempts: 0, lastVerdict: null },
    revisions: task.revisions ?? 0,
    rejectedTransitions: task.rejectedTransitions ?? [],
    lastError: task.lastError ?? null,
    lastUsage: task.lastUsage ?? null,
    completion: task.completion ?? null,
    workMemory: task.workMemory ?? { layer: 'work', key: task.id },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    history: task.history,
  };
}

/** The compact state stamped on each chat message. */
export function snapshot(task, announce) {
  return {
    id: task.id,
    state: announce?.currentState ?? task.state,
    nextState: announce ? announce.nextState : task.nextState,
    plannedAction: announce?.plannedAction ?? task.plannedAction,
    mode: task.mode,
    status: task.status,
    awaiting: task.awaitingInput?.reason ?? null,
  };
}
