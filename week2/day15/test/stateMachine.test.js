import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as SM from '../src/agent/stateMachine.js';

const ID = 'task-11111111-1111-4111-8111-111111111111';
const newTask = (mode = 'manual') => SM.createTask({ id: ID, title: 't', request: 'r', mode });
const history = (task) => task.history.map((h) => `${h.from ?? '∅'}→${h.to}`);
/** Run the current step to completion with the given outcome. */
const run = (task, outcome = {}) => SM.completeStep(SM.advance(task), outcome);

test('the permissible states and transitions are defined explicitly', () => {
  assert.deepEqual(SM.ALL_STATES, ['planning', 'execution', 'validation', 'done', 'paused', 'failed', 'cancelled']);
  assert.deepEqual(SM.LIFECYCLE, ['planning', 'execution', 'validation', 'done']);
  assert.deepEqual(SM.TRANSITIONS.planning, ['planning', 'execution', 'paused', 'failed', 'cancelled']);
  assert.deepEqual(SM.TRANSITIONS.done, []);
  assert.deepEqual(SM.TRANSITIONS.cancelled, []);
  for (const [from, targets] of Object.entries(SM.TRANSITIONS)) {
    for (const to of targets) assert.ok(SM.ALL_STATES.includes(to), `${from} → ${to} targets a known state`);
  }
});

test('a new task starts in planning with its step pending, and carries every required field', () => {
  const task = newTask();
  assert.equal(task.state, 'planning');
  assert.equal(task.stepStatus, 'pending');
  assert.equal(task.nextState, 'planning');
  assert.equal(task.objective, 'r');
  assert.deepEqual(task.workMemory, { layer: 'work', key: ID });
  assert.deepEqual(task.validation, { attempts: 0, lastVerdict: null });
  assert.equal(task.completion, null);
  assert.ok(task.currentAction);
  const pub = SM.publicTask(task);
  for (const key of ['id', 'createdAt', 'state', 'allowedStates', 'allowedTransitions', 'objective', 'workMemory',
    'plannedAction', 'currentAction', 'validation', 'completion']) {
    assert.ok(key in pub, key);
  }
});

test('valid transitions: planning → execution → validation → done, one state at a time in manual mode', () => {
  let out = run(newTask());
  assert.equal(out.autoContinue, false, 'manual mode waits for continue');
  assert.deepEqual(out.announce, { currentState: 'planning', nextState: 'execution', plannedAction: SM.STATE_ACTIONS.execution });
  assert.equal(out.task.state, 'planning');
  assert.equal(out.task.stepStatus, 'completed');

  out = run(out.task);
  assert.equal(out.task.state, 'execution');
  assert.equal(out.announce.nextState, 'validation');
  out = run(out.task, { verdict: { passed: true, summary: 'ok' } });
  assert.equal(out.task.state, 'validation');
  assert.equal(out.task.nextState, 'done');
  assert.equal(out.task.validation.lastVerdict.passed, true);

  const done = SM.advance(out.task);
  assert.equal(done.state, 'done');
  assert.equal(done.nextState, null);
  assert.equal(done.plannedAction, 'none');
  assert.equal(done.completion.outcome, 'done');
  assert.deepEqual(history(done), ['∅→planning', 'planning→execution', 'execution→validation', 'validation→done']);
  assert.throws(() => SM.advance(done), SM.InvalidTransitionError);
});

test('invalid transitions are rejected and the current state is preserved', () => {
  const task = newTask();
  assert.throws(() => SM.transition(task, 'paused-ish'), /not a state/);
  assert.throws(() => SM.transition({ ...task, state: 'done' }, 'planning'), /already done/);
  assert.throws(() => SM.transition({ ...task, state: 'cancelled' }, 'execution'), /already cancelled/);
  assert.equal(task.state, 'planning', 'a refused transition changes nothing');
});

test('skipping a mandatory stage is impossible', () => {
  const planning = newTask();
  assert.throws(() => SM.transition(planning, 'validation'), /would skip execution/);
  assert.throws(() => SM.transition(planning, 'done'), /would skip execution and validation/);
  const execution = SM.advance(run(planning).task);
  assert.throws(() => SM.transition(execution, 'done'), /would skip validation/);
});

test('an illegal next state proposed by the model is rejected, recorded, and the lifecycle is kept', () => {
  const out = run(newTask('auto'), { proposedNext: 'done' });
  assert.equal(out.task.nextState, 'execution', 'the legal next state is used instead');
  assert.deepEqual(out.rejected, { from: 'planning', to: 'done', reason: 'it would skip execution and validation' });
  assert.equal(out.task.rejectedTransitions.length, 1);
  assert.equal(out.task.state, 'planning');

  assert.equal(SM.resolveNextState('planning', 'validation').rejected.reason, 'it would skip execution');
  assert.match(SM.resolveNextState('execution', 'finished').rejected.reason, /not a state/);
  assert.match(SM.resolveNextState('planning', 'paused').rejected.reason, /only the user/);
  assert.deepEqual(SM.resolveNextState('validation', 'execution'), { next: 'execution', rejected: null }, 'a legal proposal is taken');
  assert.deepEqual(SM.resolveNextState('planning', 'planning'), { next: 'execution', rejected: null });
});

test('auto mode continues without confirmation, but still one legal step at a time', () => {
  let task = newTask('auto');
  const seen = [];
  for (;;) {
    const out = run(task);
    seen.push(out.announce.currentState);
    assert.equal(out.autoContinue, true);
    task = out.task;
    if (task.nextState === 'done') break;
  }
  const done = SM.advance(task);
  assert.deepEqual([...seen, done.state], ['planning', 'execution', 'validation', 'done']);
  assert.deepEqual(history(done), ['∅→planning', 'planning→execution', 'execution→validation', 'validation→done']);
});

test('pause and resume keep the state, next state and planned action', () => {
  const executed = run(run(newTask()).task).task; // execution, completed
  assert.equal(executed.state, 'execution');
  const before = { nextState: executed.nextState, plannedAction: executed.plannedAction, stepStatus: executed.stepStatus };

  const paused = SM.pause(executed);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.resumeState, 'execution');
  assert.deepEqual(SM.allowedTransitions(paused), ['execution', 'cancelled']);
  assert.throws(() => SM.advance(paused), /paused/);
  assert.throws(() => SM.transition(paused, 'validation'), /can only resume in execution/);

  const resumed = SM.resume(paused);
  assert.equal(resumed.state, 'execution');
  assert.deepEqual({ nextState: resumed.nextState, plannedAction: resumed.plannedAction, stepStatus: resumed.stepStatus }, before);
  assert.deepEqual(history(resumed).slice(-2), ['execution→paused', 'paused→execution']);
  assert.throws(() => SM.resume(resumed), /not paused/);
});

test('a pause requested during a running step lands when the step ends; auto mode stops there', () => {
  const running = SM.advance(newTask('auto'));
  const requested = SM.pause(running);
  assert.equal(requested.state, 'planning');
  assert.equal(requested.pauseRequested, true);
  const out = SM.completeStep(requested);
  assert.equal(out.task.state, 'paused');
  assert.equal(out.task.resumeState, 'planning');
  assert.equal(out.task.nextState, 'execution');
  assert.equal(out.autoContinue, false);
});

test('a question keeps the task in its current state until the user answers', () => {
  const out = run(newTask('auto'), { needsUserInput: true, plannedAction: 'Ask which OS' });
  assert.equal(out.task.state, 'planning', 'no waiting state: the task stays in planning');
  assert.equal(out.task.awaitingInput.reason, 'question');
  assert.equal(out.task.nextState, 'planning');
  assert.equal(out.autoContinue, false, 'auto mode still stops for required information');
  assert.throws(() => SM.advance(out.task), /waiting for your answer/);
  assert.equal(SM.stateForUserMessage(out.task), 'planning');
  const again = SM.beginStep(out.task, 'planning', { reason: 'user message' });
  assert.equal(again.awaitingInput, null);
  assert.deepEqual(history(again).at(-1), 'planning→planning', 'the re-run is a recorded self-transition');
});

test('an invariant conflict stops in every mode and keeps the current valid state', () => {
  const conflict = { stage: 'plan', conflicts: [{ invariantId: 'stack', name: 'Backend stack', reason: 'Python' }], resumeIn: 'planning' };
  const out = run(newTask('auto'), { conflict, proposedNext: 'execution' });
  assert.equal(out.task.state, 'planning');
  assert.equal(out.task.awaitingInput.reason, 'invariant_conflict');
  assert.equal(out.task.pendingConflict.conflicts[0].invariantId, 'stack');
  assert.equal(out.autoContinue, false);
  assert.match(out.announce.plannedAction, /Request permission to modify the invariant "Backend stack"/);
  assert.throws(() => SM.advance(out.task), /invariant conflict needs your decision/);

  const resolved = SM.resolveAwaiting(out.task, { reason: 'keep', keepInvariants: true });
  assert.equal(resolved.state, 'planning');
  assert.equal(resolved.stepStatus, 'running');
  assert.equal(resolved.keepInvariants, true);
});

test('failed validation goes back to execution, then waits for the user after too many retries', () => {
  // From a running execution step: finish it and enter validation.
  const toValidation = (runningExecution) => SM.advance(SM.completeStep(runningExecution).task);
  let task = toValidation(SM.advance(run(newTask('auto')).task)); // validation, running
  let out = SM.completeStep(task, { verdict: { passed: false, summary: 'missing tests' }, maxValidationRetries: 1 });
  assert.equal(out.task.nextState, 'execution');
  assert.equal(out.task.validation.attempts, 1);
  const execution = SM.advance(out.task);
  assert.equal(execution.state, 'execution');

  task = toValidation(execution);
  out = SM.completeStep(task, { verdict: { passed: false }, maxValidationRetries: 1 });
  assert.equal(out.task.state, 'validation');
  assert.equal(out.task.awaitingInput.reason, 'validation_retries');
  assert.equal(SM.advance(out.task).state, 'execution', 'continue retries the execution step');
});

test('failure and retry in the same state; cancel is final', () => {
  const failed = SM.fail(SM.advance(newTask()), 'DeepSeek timeout');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.nextState, 'planning');
  assert.deepEqual(SM.allowedTransitions(failed), ['planning', 'cancelled']);
  assert.throws(() => SM.transition(failed, 'execution'), /can only be retried in planning/);
  const retried = SM.advance(failed);
  assert.equal(retried.state, 'planning');
  assert.equal(retried.stepStatus, 'running');

  const cancelled = SM.cancel(SM.completeStep(retried).task);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.completion.outcome, 'cancelled');
  assert.throws(() => SM.advance(cancelled), /cancelled/);
  assert.throws(() => SM.cancel(cancelled), /already cancelled/);
});

test('a step interrupted by a restart is re-run, not restarted from the beginning', () => {
  let task = SM.advance(run(newTask()).task); // execution, running
  task = SM.recoverInterrupted(task);
  assert.equal(task.state, 'execution');
  assert.equal(task.stepStatus, 'pending');
  const rerun = SM.advance(task);
  assert.equal(rerun.state, 'execution');
  assert.equal(rerun.stepStatus, 'running');
  assert.equal(history(rerun).at(-1), 'planning→execution', 'running the pending step is not a new transition');
});

test('mode can be switched until the task is final; current action reflects the real state', () => {
  const task = run(newTask()).task;
  assert.match(task.currentAction, /Waiting for you to continue/);
  const auto = SM.setMode(task, 'auto');
  assert.equal(auto.mode, 'auto');
  assert.throws(() => SM.setMode(auto, 'turbo'), /Invalid mode/);
  const cancelled = SM.cancel(auto);
  assert.equal(cancelled.currentAction, 'none');
  assert.throws(() => SM.setMode(cancelled, 'manual'), /cancelled/);
});
