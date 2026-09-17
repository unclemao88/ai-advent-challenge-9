/**
 * The task state machine.
 *
 *   planning ──▶ execution ──▶ validation ──▶ done
 *      ▲  ↺          │  ↺  ▲        │  ↺
 *      └─────────────┘      └───────┘   (re-plan / fix after failed validation)
 *
 *   any active state ──▶ paused ──▶ the same state again
 *   any active state ──▶ error  ──▶ the same state again (retry)
 *
 * A self-transition (↺) re-runs a state, e.g. when the user answers a
 * question or gives feedback while the task waits in that state.
 *
 * Everything here is pure: functions take a task object and return a new one,
 * and know nothing about DeepSeek, storage or HTTP. Every transition is checked
 * against TRANSITIONS; the model may *suggest* the next state, but a suggestion
 * that is not allowed is replaced with the default.
 *
 * Task fields owned by this module:
 *   currentState   the state the task is in
 *   nextState      where "continue" goes (null once done)
 *   plannedAction  what happens on "continue", in words
 *   status         running | waiting | paused | completed | failed
 *   mode           manual (stop after every state) | auto (run through)
 *   resumeState    the active state to return to from paused / error
 *   pauseRequested set while a step is running; the pause lands when it ends
 *   history        [{ from, to, timestamp, reason }]
 */

export const STATES = Object.freeze({
  PLANNING: 'planning',
  EXECUTION: 'execution',
  VALIDATION: 'validation',
  DONE: 'done',
  PAUSED: 'paused',
  ERROR: 'error',
});

export const ACTIVE_STATES = Object.freeze([STATES.PLANNING, STATES.EXECUTION, STATES.VALIDATION]);
export const ALL_STATES = Object.freeze(Object.values(STATES));

export const STATUSES = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

export const MODES = Object.freeze(['manual', 'auto']);

/** Allowed transitions. `paused` and `error` may only return to `resumeState`. */
export const TRANSITIONS = Object.freeze({
  planning: Object.freeze(['planning', 'execution', 'paused', 'error']),
  execution: Object.freeze(['execution', 'validation', 'planning', 'paused', 'error']),
  validation: Object.freeze(['validation', 'done', 'execution', 'planning', 'paused', 'error']),
  paused: Object.freeze(['planning', 'execution', 'validation']),
  error: Object.freeze(['planning', 'execution', 'validation']),
  done: Object.freeze([]),
});

export const DEFAULT_NEXT = Object.freeze({
  planning: 'execution',
  execution: 'validation',
  validation: 'done',
});

/** What running each state means, in the words shown to the user. */
export const STATE_ACTIONS = Object.freeze({
  planning: 'Analyze the request and prepare an execution plan.',
  execution: 'Execute the plan and produce the result.',
  validation: 'Check the result against the objective and requirements.',
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

export function isActiveState(state) {
  return ACTIVE_STATES.includes(state);
}

export function canTransition(task, to) {
  const from = task.currentState;
  if (!TRANSITIONS[from]?.includes(to)) return false;
  if (from === STATES.PAUSED || from === STATES.ERROR) return to === task.resumeState;
  return true;
}

/** Throws unless `from → to` is allowed for this task. */
export function assertTransition(task, to) {
  if (!ALL_STATES.includes(to)) throw new InvalidTransitionError(task.currentState, to, 'unknown state');
  if (!canTransition(task, to)) {
    const why = task.currentState === STATES.DONE ? 'the task is finished'
      : (task.currentState === STATES.PAUSED || task.currentState === STATES.ERROR)
        ? `it can only return to ${task.resumeState}` : 'not in the transition table';
    throw new InvalidTransitionError(task.currentState, to, why);
  }
}

/**
 * Record `currentState → to`. Only the state and history change; callers set
 * status, nextState and plannedAction for the new situation.
 */
export function transition(task, to, { reason = '', now = new Date() } = {}) {
  assertTransition(task, to);
  const timestamp = now.toISOString();
  return {
    ...task,
    currentState: to,
    history: [...task.history, { from: task.currentState, to, timestamp, reason }],
    updatedAt: timestamp,
  };
}

/** Pick the model's suggested next state if the table allows it, else the default. */
export function resolveNextState(state, suggested) {
  const allowed = TRANSITIONS[state] ?? [];
  if (suggested && suggested !== STATES.PAUSED && suggested !== STATES.ERROR && allowed.includes(suggested)) {
    return suggested;
  }
  return DEFAULT_NEXT[state] ?? null;
}

export function describeAction(state) {
  return STATE_ACTIONS[state] ?? '';
}

/**
 * A new task, about to run its planning step.
 *
 * @param {{taskId: string, title: string, mode: 'manual'|'auto', now?: Date}} input
 */
export function createTask({ taskId, title, mode, now = new Date() }) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  const timestamp = now.toISOString();
  return {
    taskId,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    currentState: STATES.PLANNING,
    nextState: DEFAULT_NEXT.planning,
    plannedAction: describeAction(STATES.PLANNING),
    mode,
    status: STATUSES.RUNNING,
    resumeState: null,
    pauseRequested: false,
    validationAttempts: 0,
    lastError: null,
    // The planning step starts right away.
    stepStartedAt: timestamp,
    workMemoryRef: { layer: 'work', key: `task-${taskId}` },
    history: [{ from: null, to: STATES.PLANNING, timestamp, reason: 'task created' }],
  };
}

/**
 * Enter `state` and mark the task as running its step. Entering the state the
 * task is already in is a recorded self-transition (a re-run).
 */
export function beginStep(task, state, { reason = '', now = new Date() } = {}) {
  if (!isActiveState(state)) throw new InvalidTransitionError(task.currentState, state, 'not an executable state');
  if (task.status === STATUSES.RUNNING) throw new InvalidTransitionError(task.currentState, state, 'a step is already running');
  const moved = transition(task, state, { reason, now });
  return {
    ...moved,
    status: STATUSES.RUNNING,
    nextState: DEFAULT_NEXT[state],
    plannedAction: describeAction(state),
    resumeState: null,
    lastError: null,
    stepStartedAt: now.toISOString(),
  };
}

/**
 * The running step finished. Decide what comes next and whether to stop.
 *
 * @param {object} task
 * @param {{suggestedNext?: string, plannedAction?: string, needsUserInput?: boolean,
 *          validationPassed?: boolean|null, maxValidationRetries?: number, now?: Date}} outcome
 * @returns {{task: object, autoContinue: boolean}} The task is `waiting` (or
 *          `paused` if a pause was requested); `autoContinue` tells an
 *          auto-mode runner whether to go on without the user.
 */
export function completeStep(task, {
  suggestedNext, plannedAction, needsUserInput = false, validationPassed = null, maxValidationRetries = 2, now = new Date(),
} = {}) {
  const state = task.currentState;
  if (!isActiveState(state) || task.status !== STATUSES.RUNNING) {
    throw new InvalidTransitionError(state, suggestedNext ?? '?', 'no step is running');
  }

  let next = resolveNextState(state, suggestedNext);
  let validationAttempts = task.validationAttempts ?? 0;
  let stop = needsUserInput;
  let action = plannedAction?.trim() || null;

  if (state === STATES.VALIDATION) {
    // The verdict decides between done and another execution round, whatever was suggested.
    if (validationPassed === false) {
      validationAttempts += 1;
      next = suggestedNext === STATES.PLANNING ? STATES.PLANNING : STATES.EXECUTION;
      if (validationAttempts > maxValidationRetries) {
        stop = true;
        action = `Validation failed ${validationAttempts} times. Review the result, give feedback, or continue to try again.`;
      }
    } else if (validationPassed === true) {
      next = STATES.DONE;
    }
  }

  if (needsUserInput && !action) action = 'Waiting for your answer. Reply in the chat, or continue without one.';
  if (!action) action = describeAction(next);

  const result = {
    ...task,
    nextState: next,
    plannedAction: action,
    status: STATUSES.WAITING,
    validationAttempts,
    stepStartedAt: null,
    updatedAt: now.toISOString(),
  };

  if (result.pauseRequested) return { task: pause(result, { now }), autoContinue: false };
  return { task: result, autoContinue: result.mode === 'auto' && !stop && next !== null };
}

/**
 * Which state a new user message runs, for a task that is not finished:
 *   waiting in planning/execution → that state again, with the message as input
 *   waiting in validation         → execution (the message is feedback on the result)
 *   failed                        → the state that failed (a retry with the message)
 * Returns null when the task cannot take a message (running, paused, done).
 */
export function stateForUserMessage(task) {
  if (task.status === STATUSES.FAILED) return task.resumeState;
  if (task.status !== STATUSES.WAITING) return null;
  return task.currentState === STATES.VALIDATION ? STATES.EXECUTION : task.currentState;
}

const ADVANCE_BLOCKED = {
  paused: 'the task is paused; resume it first',
  running: 'a step is still running',
  completed: 'the task is already finished',
};

/**
 * Move to `nextState` (the "continue" control). Returns the task running the
 * next step, or completed when the next state is done.
 */
export function advance(task, { reason = 'continue', now = new Date() } = {}) {
  if (task.status !== STATUSES.WAITING && task.status !== STATUSES.FAILED) {
    throw new InvalidTransitionError(task.currentState, task.nextState ?? '?', ADVANCE_BLOCKED[task.status] ?? `the task is ${task.status}`);
  }
  const to = task.nextState;
  if (!to) throw new InvalidTransitionError(task.currentState, '?', 'there is no next state');
  if (to === STATES.DONE) return complete(task, { reason, now });
  return beginStep(task, to, { reason, now });
}

export function complete(task, { reason = 'validation passed', now = new Date() } = {}) {
  const moved = transition(task, STATES.DONE, { reason, now });
  return {
    ...moved,
    nextState: null,
    plannedAction: 'No further action. Ask a new question to start a new task.',
    status: STATUSES.COMPLETED,
    pauseRequested: false,
    stepStartedAt: null,
    completedAt: now.toISOString(),
  };
}

/**
 * Pause the task. A waiting task pauses at once; a running one gets
 * `pauseRequested` and pauses when its step completes. Finished and failed
 * tasks cannot be paused (a failed task is already standing still).
 */
export function pause(task, { now = new Date() } = {}) {
  if (task.status === STATUSES.PAUSED) return task;
  if (task.status === STATUSES.RUNNING) return { ...task, pauseRequested: true, updatedAt: now.toISOString() };
  if (task.status !== STATUSES.WAITING || !isActiveState(task.currentState)) {
    throw new InvalidTransitionError(task.currentState, STATES.PAUSED, `the task is ${task.status}`);
  }
  const moved = transition(task, STATES.PAUSED, { reason: 'paused by user', now });
  return { ...moved, status: STATUSES.PAUSED, resumeState: task.currentState, pauseRequested: false };
}

/** Return a paused task to the state it was paused in, waiting for continue. */
export function resume(task, { now = new Date() } = {}) {
  if (task.currentState !== STATES.PAUSED) {
    throw new InvalidTransitionError(task.currentState, task.resumeState ?? '?', 'the task is not paused');
  }
  const moved = transition(task, task.resumeState, { reason: 'resumed by user', now });
  return { ...moved, status: STATUSES.WAITING, resumeState: null, pauseRequested: false };
}

/** A step failed: move to `error`; continuing retries the same state. */
export function fail(task, message, { now = new Date() } = {}) {
  const from = task.currentState;
  if (!isActiveState(from)) throw new InvalidTransitionError(from, STATES.ERROR, 'no step is running');
  const moved = transition(task, STATES.ERROR, { reason: 'step failed', now });
  return {
    ...moved,
    status: STATUSES.FAILED,
    resumeState: from,
    nextState: from,
    plannedAction: `Retry the ${from} step.`,
    lastError: message,
    pauseRequested: false,
    stepStartedAt: null,
  };
}

/**
 * After a restart, a task still marked running was interrupted mid-step. It is
 * put back to waiting so that continue re-runs that step (or paused, if a pause
 * had been requested).
 */
export function recoverInterrupted(task, { now = new Date() } = {}) {
  if (task.status !== STATUSES.RUNNING) return task;
  const recovered = {
    ...task,
    status: STATUSES.WAITING,
    nextState: task.currentState,
    plannedAction: `Re-run the ${task.currentState} step (it was interrupted by a server restart).`,
    stepStartedAt: null,
    updatedAt: now.toISOString(),
  };
  return task.pauseRequested ? pause(recovered, { now }) : recovered;
}

export function setMode(task, mode, { now = new Date() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
  if (task.status === STATUSES.COMPLETED) throw new InvalidTransitionError(task.currentState, task.currentState, 'the task is finished');
  return { ...task, mode, updatedAt: now.toISOString() };
}

/** The part of a task the UI and the API show. */
export function publicTask(task) {
  if (!task) return null;
  return {
    id: task.taskId,
    title: task.title,
    currentState: task.currentState,
    nextState: task.nextState,
    plannedAction: task.plannedAction,
    mode: task.mode,
    status: task.status,
    resumeState: task.resumeState,
    pauseRequested: Boolean(task.pauseRequested),
    validationAttempts: task.validationAttempts ?? 0,
    lastError: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    workMemoryRef: task.workMemoryRef,
    history: task.history,
  };
}
