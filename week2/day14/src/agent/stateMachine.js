/**
 * The task state machine.
 *
 *   idle ─▶ planning ─▶ execution ─▶ validation ─▶ done
 *              ▲ │ ↺         │ ↺  ▲        │ ↺
 *              │ ▼           │    └────────┘  (fix after a failed validation)
 *        waiting_for_user ◀──┴──────────────  (question, invariant conflict, too many retries)
 *
 *   planning / execution / validation / waiting_for_user ─▶ paused ─▶ the same state
 *   any working state ─▶ failed ─▶ the same state again (retry), unless cancelled
 *
 * A self-transition (↺) re-runs a state: the user answered, gave feedback, or
 * a result was rejected for violating an invariant.
 *
 * Everything here is pure: functions take a task and return a new one. They
 * know nothing about DeepSeek, storage or HTTP. Every transition is checked
 * against TRANSITIONS; the model may *suggest* the next state, but a suggestion
 * the table does not allow is replaced with the default.
 *
 * Task fields owned by this module:
 *   state          the current state
 *   stepStatus     for planning/execution/validation: pending (entered, not run yet),
 *                  running (DeepSeek call in progress), completed (ran; waiting for continue)
 *   nextState      where "continue" goes (null once finished)
 *   plannedAction  what happens on "continue", in words
 *   status         active | paused | done | failed
 *   mode           manual (stop after every state) | auto (run through)
 *   resumeState    the state to return to from paused, or to retry from failed
 *   waitingReason  why the task waits for the user: question | invariant_conflict | validation_retries
 *   pendingConflict  the invariant conflict the user must decide on
 *   history        [{ from, to, timestamp, reason }]
 */

export const STATES = Object.freeze({
  IDLE: 'idle',
  PLANNING: 'planning',
  WAITING: 'waiting_for_user',
  EXECUTION: 'execution',
  VALIDATION: 'validation',
  DONE: 'done',
  FAILED: 'failed',
  PAUSED: 'paused',
});

export const ALL_STATES = Object.freeze(Object.values(STATES));
/** States that run a DeepSeek call. */
export const WORK_STATES = Object.freeze([STATES.PLANNING, STATES.EXECUTION, STATES.VALIDATION]);
export const MODES = Object.freeze(['manual', 'auto']);
export const STATUSES = Object.freeze({ ACTIVE: 'active', PAUSED: 'paused', DONE: 'done', FAILED: 'failed' });

export const TRANSITIONS = Object.freeze({
  idle: Object.freeze(['planning', 'failed']),
  planning: Object.freeze(['planning', 'execution', 'waiting_for_user', 'paused', 'failed']),
  waiting_for_user: Object.freeze(['planning', 'execution', 'validation', 'paused', 'failed']),
  execution: Object.freeze(['execution', 'validation', 'planning', 'waiting_for_user', 'paused', 'failed']),
  validation: Object.freeze(['validation', 'done', 'execution', 'planning', 'waiting_for_user', 'paused', 'failed']),
  paused: Object.freeze(['planning', 'execution', 'validation', 'waiting_for_user', 'failed']),
  failed: Object.freeze(['planning', 'execution', 'validation']),
  done: Object.freeze([]),
});

export const DEFAULT_NEXT = Object.freeze({
  idle: 'planning',
  planning: 'execution',
  execution: 'validation',
  validation: 'done',
});

/** What running each state means, in the words shown to the user. */
export const STATE_ACTIONS = Object.freeze({
  idle: 'Start planning the task.',
  planning: 'Analyze the request, create the implementation plan and verify it against the active invariants.',
  execution: 'Execute the approved plan and produce the result, within the active invariants.',
  validation: 'Validate the result against the objective, the requirements and the active invariants.',
  done: 'Finish the task and summarize the outcome.',
});

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

export function canTransition(task, to) {
  const from = task.state;
  if (!TRANSITIONS[from]?.includes(to)) return false;
  if (from === STATES.PAUSED && to !== STATES.FAILED) return to === task.resumeState;
  if (from === STATES.FAILED) return to === task.resumeState;
  return true;
}

export function assertTransition(task, to) {
  if (!ALL_STATES.includes(to)) throw new InvalidTransitionError(task.state, to, 'unknown state');
  if (!canTransition(task, to)) {
    let why = 'not in the transition table';
    if (task.state === STATES.DONE) why = 'the task is finished';
    else if (task.state === STATES.FAILED) why = task.resumeState ? `it can only be retried in ${task.resumeState}` : 'the task was cancelled';
    else if (task.state === STATES.PAUSED) why = `it can only return to ${task.resumeState}`;
    throw new InvalidTransitionError(task.state, to, why);
  }
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

/** The model's suggested next state if the table allows it, else the default. */
export function resolveNextState(state, suggested) {
  const allowed = TRANSITIONS[state] ?? [];
  const pickable = suggested && ![STATES.PAUSED, STATES.FAILED, STATES.WAITING, STATES.IDLE].includes(suggested);
  if (pickable && allowed.includes(suggested) && suggested !== state) return suggested;
  return DEFAULT_NEXT[state] ?? null;
}

export function describeAction(state) {
  return STATE_ACTIONS[state] ?? '';
}

/**
 * A new task in `idle`, ready to start planning.
 * @param {{id: string, title: string, request: string, mode: 'manual'|'auto', now?: Date}} input
 */
export function createTask({ id, title, request, mode, now = new Date() }) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const timestamp = now.toISOString();
  return {
    id,
    title,
    request,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: STATUSES.ACTIVE,
    state: STATES.IDLE,
    stepStatus: 'completed',
    nextState: STATES.PLANNING,
    plannedAction: describeAction(STATES.PLANNING),
    mode,
    resumeState: null,
    pauseRequested: false,
    waitingReason: null,
    pendingConflict: null,
    keepInvariants: false,
    validationAttempts: 0,
    revisions: 0,
    lastError: null,
    lastUsage: null,
    completedAt: null,
    history: [{ from: null, to: STATES.IDLE, timestamp, reason: 'task created' }],
  };
}

/** Enter a work state and mark its step as running. Re-entering the same state is a recorded re-run. */
export function beginStep(task, state, { reason = '', now = new Date() } = {}) {
  if (!isWorkState(state)) throw new InvalidTransitionError(task.state, state, 'not a working state');
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, state, 'a step is already running');
  const moved = transition(task, state, { reason, now });
  return {
    ...moved,
    status: STATUSES.ACTIVE,
    stepStatus: 'running',
    nextState: DEFAULT_NEXT[state],
    plannedAction: describeAction(state),
    resumeState: null,
    waitingReason: null,
    pendingConflict: null,
    lastError: null,
  };
}

/**
 * The running step finished. Decide what comes next and whether to stop.
 *
 * @param {object} task
 * @param {{suggestedNext?: string, plannedAction?: string, needsUserInput?: boolean,
 *          conflict?: {stage: string, conflicts: object[], resumeIn?: string}|null,
 *          validationPassed?: boolean|null, maxValidationRetries?: number, now?: Date}} outcome
 * @returns {{task: object, autoContinue: boolean,
 *            announce: {currentState: string, nextState: string|null, plannedAction: string}}}
 *          `announce` is what the answer to the user shows: the state that ran,
 *          where it goes, and why. `autoContinue` tells an auto-mode runner
 *          whether it may go on without the user.
 */
export function completeStep(task, {
  suggestedNext, plannedAction, needsUserInput = false, conflict = null,
  validationPassed = null, maxValidationRetries = 2, now = new Date(),
} = {}) {
  const state = task.state;
  if (!isWorkState(state) || task.stepStatus !== 'running') {
    throw new InvalidTransitionError(state, suggestedNext ?? '?', 'no step is running');
  }

  // An invariant conflict always stops, whatever the mode.
  if (conflict?.conflicts?.length) {
    const names = conflict.conflicts.map((c) => `"${c.name}"`).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    const plural = names.includes(',');
    const action = `Request permission to modify the invariant${plural ? 's' : ''} ${names}, or keep ${plural ? 'them' : 'it'} and re-work the task within ${plural ? 'them' : 'it'}.`;
    const waiting = waitForUser({ ...task, stepStatus: 'completed' }, {
      reason: 'invariant_conflict', nextState: conflict.resumeIn ?? STATES.PLANNING, plannedAction: action, conflict, now,
    });
    return { task: waiting, autoContinue: false, announce: { currentState: state, nextState: STATES.WAITING, plannedAction: action } };
  }

  if (needsUserInput) {
    const action = plannedAction?.trim() || 'Wait for your answer, then continue with it.';
    const resumeIn = state === STATES.VALIDATION ? STATES.EXECUTION : state;
    const waiting = waitForUser({ ...task, stepStatus: 'completed' }, {
      reason: 'question', nextState: resumeIn, plannedAction: action, now,
    });
    return { task: waiting, autoContinue: false, announce: { currentState: state, nextState: STATES.WAITING, plannedAction: action } };
  }

  let next = resolveNextState(state, suggestedNext);
  let validationAttempts = task.validationAttempts ?? 0;
  let action = plannedAction?.trim() || null;

  if (state === STATES.VALIDATION) {
    // The verdict decides between done and another round, whatever was suggested.
    if (validationPassed === false) {
      validationAttempts += 1;
      next = suggestedNext === STATES.PLANNING ? STATES.PLANNING : STATES.EXECUTION;
      if (validationAttempts > maxValidationRetries) {
        const tooMany = `Validation failed ${validationAttempts} times. Give feedback in the chat, or continue to try again.`;
        const waiting = waitForUser({ ...task, stepStatus: 'completed', validationAttempts }, {
          reason: 'validation_retries', nextState: STATES.EXECUTION, plannedAction: tooMany, now,
        });
        return { task: waiting, autoContinue: false, announce: { currentState: state, nextState: STATES.WAITING, plannedAction: tooMany } };
      }
    } else if (validationPassed === true) {
      next = STATES.DONE;
    }
  }
  if (!action || next === STATES.DONE) action = next === STATES.DONE ? 'Finish the task and summarize the outcome.' : describeAction(next);

  const result = {
    ...task,
    stepStatus: 'completed',
    nextState: next,
    plannedAction: action,
    validationAttempts,
    updatedAt: now.toISOString(),
  };
  const announce = { currentState: state, nextState: next, plannedAction: action };
  if (result.pauseRequested) return { task: pause(result, { now }), autoContinue: false, announce };
  return { task: result, autoContinue: result.mode === 'auto' && next !== null, announce };
}

/** Move into waiting_for_user. `nextState` is where the user's answer (or continue) goes. */
export function waitForUser(task, { reason, nextState, plannedAction, conflict = null, now = new Date() }) {
  const moved = transition(task, STATES.WAITING, { reason, now });
  return {
    ...moved,
    status: STATUSES.ACTIVE,
    nextState,
    plannedAction,
    waitingReason: reason,
    pendingConflict: conflict ? { ...conflict, detectedAt: now.toISOString() } : null,
    pauseRequested: false,
  };
}

/**
 * Which state a new user message runs, for an unfinished task:
 *   waiting_for_user            → its nextState (the answer continues the task)
 *   planning / execution done   → the same state again, with the message as input
 *   validation done             → execution (the message is feedback on the result)
 *   failed (retryable)          → the state that failed
 * Returns null when the task cannot take a message (running, paused, finished).
 */
export function stateForUserMessage(task) {
  if (task.status === STATUSES.FAILED) return task.resumeState ?? null;
  if (task.status !== STATUSES.ACTIVE || task.stepStatus === 'running') return null;
  if (task.state === STATES.WAITING) return task.nextState;
  if (task.state === STATES.IDLE) return STATES.PLANNING;
  if (task.state === STATES.VALIDATION) return STATES.EXECUTION;
  return isWorkState(task.state) ? task.state : null;
}

const ADVANCE_BLOCKED = {
  paused: 'the task is paused; resume it first',
  done: 'the task is already finished',
};

/**
 * The "continue" control: move to nextState and start it (or finish the task).
 * Also retries a failed step.
 */
export function advance(task, { reason = 'continue', now = new Date() } = {}) {
  if (task.status === STATUSES.FAILED && !task.resumeState) {
    throw new InvalidTransitionError(task.state, '?', 'the task was cancelled');
  }
  if (task.status !== STATUSES.ACTIVE && task.status !== STATUSES.FAILED) {
    throw new InvalidTransitionError(task.state, task.nextState ?? '?', ADVANCE_BLOCKED[task.status] ?? `the task is ${task.status}`);
  }
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, task.nextState ?? '?', 'a step is still running');
  const to = task.nextState;
  if (!to) throw new InvalidTransitionError(task.state, '?', 'there is no next state');
  if (to === STATES.DONE) return complete(task, { reason, now });
  return beginStep(task, to, { reason, now });
}

export function complete(task, { reason = 'validation passed', now = new Date() } = {}) {
  const moved = transition(task, STATES.DONE, { reason, now });
  return {
    ...moved,
    status: STATUSES.DONE,
    stepStatus: 'completed',
    nextState: null,
    plannedAction: 'No further action. Ask a new question to start a new task.',
    pauseRequested: false,
    waitingReason: null,
    pendingConflict: null,
    completedAt: now.toISOString(),
  };
}

/**
 * Pause the task. A task between steps pauses at once; a running one gets
 * `pauseRequested` and pauses when its step completes. Work memory and the
 * conversation are untouched: resuming continues exactly here.
 */
export function pause(task, { now = new Date() } = {}) {
  if (task.status === STATUSES.PAUSED) return task;
  if (task.status !== STATUSES.ACTIVE) throw new InvalidTransitionError(task.state, STATES.PAUSED, `the task is ${task.status}`);
  if (task.stepStatus === 'running') return { ...task, pauseRequested: true, updatedAt: now.toISOString() };
  if (task.state === STATES.IDLE) throw new InvalidTransitionError(task.state, STATES.PAUSED, 'the task has not started');
  const moved = transition(task, STATES.PAUSED, { reason: 'paused by user', now });
  return { ...moved, status: STATUSES.PAUSED, resumeState: task.state, pauseRequested: false };
}

/** Return a paused task to the state it was paused in. Its next state and planned action are unchanged. */
export function resume(task, { now = new Date() } = {}) {
  if (task.state !== STATES.PAUSED) throw new InvalidTransitionError(task.state, task.resumeState ?? '?', 'the task is not paused');
  const moved = transition(task, task.resumeState, { reason: 'resumed by user', now });
  return { ...moved, status: STATUSES.ACTIVE, resumeState: null, pauseRequested: false };
}

/**
 * A step failed (API error, storage error). The task moves to `failed`;
 * continue retries the same state.
 */
export function fail(task, message, { now = new Date() } = {}) {
  const from = task.state;
  const moved = transition(task, STATES.FAILED, { reason: 'step failed', now });
  const retryIn = isWorkState(from) ? from : STATES.PLANNING;
  return {
    ...moved,
    status: STATUSES.FAILED,
    stepStatus: 'completed',
    resumeState: retryIn,
    nextState: retryIn,
    plannedAction: `Retry the ${retryIn} step.`,
    lastError: message,
    pauseRequested: false,
  };
}

/** Stop the task for good. */
export function cancel(task, { reason = 'cancelled by user', now = new Date() } = {}) {
  if (task.status === STATUSES.DONE) throw new InvalidTransitionError(task.state, STATES.FAILED, 'the task is finished');
  if (task.stepStatus === 'running') throw new InvalidTransitionError(task.state, STATES.FAILED, 'a step is still running');
  const moved = task.state === STATES.FAILED
    ? { ...task, history: [...task.history, { from: STATES.FAILED, to: STATES.FAILED, timestamp: now.toISOString(), reason }] }
    : transition(task, STATES.FAILED, { reason, now });
  return {
    ...moved,
    status: STATUSES.FAILED,
    stepStatus: 'completed',
    resumeState: null,
    nextState: null,
    plannedAction: 'Task cancelled. Ask a new question to start a new task.',
    waitingReason: null,
    pendingConflict: null,
    lastError: reason,
    pauseRequested: false,
    completedAt: now.toISOString(),
  };
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
  return task.pauseRequested ? pause(recovered, { now }) : recovered;
}

export function setMode(task, mode, { now = new Date() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  if (task.status === STATUSES.DONE) throw new InvalidTransitionError(task.state, task.state, 'the task is finished');
  return { ...task, mode, updatedAt: now.toISOString() };
}

/** The part of a task the UI and the API show. */
export function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    state: task.state,
    stepStatus: task.stepStatus,
    nextState: task.nextState,
    plannedAction: task.plannedAction,
    mode: task.mode,
    resumeState: task.resumeState,
    pauseRequested: Boolean(task.pauseRequested),
    waitingReason: task.waitingReason,
    pendingConflict: task.pendingConflict,
    keepInvariants: Boolean(task.keepInvariants),
    validationAttempts: task.validationAttempts ?? 0,
    revisions: task.revisions ?? 0,
    lastError: task.lastError,
    lastUsage: task.lastUsage ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
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
  };
}
