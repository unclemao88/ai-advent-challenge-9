import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as SM from '../src/state-machine/StateMachine.js';

const ID = '33333333-3333-4333-8333-333333333333';
const fresh = (mode = 'manual') => SM.createTask({ taskId: ID, title: 'Test', mode });
const finishStep = (task, outcome = {}) => SM.completeStep(task, outcome).task;
const path = (task) => task.history.map((h) => h.to);

test('a new task starts running its planning step', () => {
  const task = fresh();
  assert.equal(task.currentState, 'planning');
  assert.equal(task.nextState, 'execution');
  assert.equal(task.status, 'running');
  assert.equal(task.plannedAction, SM.STATE_ACTIONS.planning);
  assert.deepEqual(task.history, [{ from: null, to: 'planning', timestamp: task.createdAt, reason: 'task created' }]);
  assert.deepEqual(task.workMemoryRef, { layer: 'work', key: `task-${ID}` });
  assert.throws(() => SM.createTask({ taskId: ID, title: 'x', mode: 'turbo' }), /Invalid mode/);
});

test('valid transitions: planning → execution → validation → done', () => {
  let task = finishStep(fresh());
  assert.equal(task.status, 'waiting');
  task = SM.advance(task);
  assert.equal(task.currentState, 'execution');
  assert.equal(task.nextState, 'validation');
  task = SM.advance(finishStep(task));
  assert.equal(task.currentState, 'validation');
  task = finishStep(task, { validationPassed: true });
  assert.equal(task.nextState, 'done');
  task = SM.advance(task);
  assert.equal(task.currentState, 'done');
  assert.equal(task.status, 'completed');
  assert.equal(task.nextState, null);
  assert.ok(task.completedAt);
  assert.deepEqual(path(task), ['planning', 'execution', 'validation', 'done']);
  assert.deepEqual(task.history.slice(1).map((h) => h.from), ['planning', 'execution', 'validation']);
});

test('invalid transitions are refused', () => {
  const task = finishStep(fresh());
  assert.equal(SM.canTransition(task, 'done'), false);
  assert.equal(SM.canTransition(task, 'validation'), false);
  assert.throws(() => SM.transition(task, 'done'), SM.InvalidTransitionError);
  assert.throws(() => SM.transition(task, 'flying'), /unknown state/);
  assert.throws(() => SM.beginStep(task, 'done'), /not an executable state/);
  assert.throws(() => SM.beginStep(fresh(), 'planning'), /already running/);

  const done = SM.advance(finishStep(SM.advance(finishStep(SM.advance(task))), { validationPassed: true }));
  for (const to of SM.ALL_STATES) assert.equal(SM.canTransition(done, to), false, `done → ${to}`);
  assert.throws(() => SM.advance(done), /already finished/);
  assert.throws(() => SM.pause(done), SM.InvalidTransitionError);
  assert.throws(() => SM.setMode(done, 'auto'), /finished/);
});

test('the model can only suggest allowed next states', () => {
  assert.equal(SM.resolveNextState('planning', 'done'), 'execution');
  assert.equal(SM.resolveNextState('planning', 'paused'), 'execution');
  assert.equal(SM.resolveNextState('planning', 'error'), 'execution');
  assert.equal(SM.resolveNextState('planning', 'planning'), 'planning');
  assert.equal(SM.resolveNextState('execution', 'planning'), 'planning');
  assert.equal(SM.resolveNextState('execution', 'nonsense'), 'validation');
  const task = finishStep(fresh(), { suggestedNext: 'done', plannedAction: 'Skip ahead' });
  assert.equal(task.nextState, 'execution');
  assert.equal(task.plannedAction, 'Skip ahead');
});

test('pause and resume keep current state, next state and planned action', () => {
  const waiting = finishStep(fresh(), { plannedAction: 'Write the code.' });
  const paused = SM.pause(waiting);
  assert.equal(paused.currentState, 'paused');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.resumeState, 'planning');
  assert.equal(paused.nextState, 'execution');
  assert.equal(paused.plannedAction, 'Write the code.');
  assert.equal(SM.pause(paused), paused, 'pausing twice is a no-op');

  assert.equal(SM.canTransition(paused, 'execution'), false, 'paused can only return to where it was');
  assert.throws(() => SM.advance(paused), /paused; resume it first/);

  const resumed = SM.resume(paused);
  assert.equal(resumed.currentState, 'planning');
  assert.equal(resumed.status, 'waiting');
  assert.equal(resumed.nextState, 'execution');
  assert.equal(resumed.plannedAction, 'Write the code.');
  assert.deepEqual(path(resumed), ['planning', 'paused', 'planning']);
  assert.throws(() => SM.resume(resumed), /not paused/);
});

test('pausing a running step takes effect when the step completes', () => {
  const requested = SM.pause(fresh('auto'));
  assert.equal(requested.status, 'running');
  assert.equal(requested.pauseRequested, true);
  const { task, autoContinue } = SM.completeStep(requested);
  assert.equal(autoContinue, false, 'auto mode stops for the pause');
  assert.equal(task.status, 'paused');
  assert.equal(task.resumeState, 'planning');
  assert.equal(task.nextState, 'execution');
  assert.equal(task.pauseRequested, false);
});

test('manual mode waits after each state; auto mode continues', () => {
  assert.equal(SM.completeStep(fresh('manual')).autoContinue, false);
  assert.equal(SM.completeStep(fresh('auto')).autoContinue, true);
  assert.equal(SM.completeStep(fresh('auto'), { needsUserInput: true }).autoContinue, false, 'a question stops auto mode');
  const switched = SM.setMode(finishStep(fresh('manual')), 'auto');
  assert.equal(switched.mode, 'auto');
  assert.throws(() => SM.setMode(switched, 'fast'), /Invalid mode/);
});

test('a failed validation goes back to execution, and stops after the retry limit', () => {
  let task = SM.advance(finishStep(SM.advance(finishStep(fresh('auto')))));
  assert.equal(task.currentState, 'validation');

  let outcome = SM.completeStep(task, { validationPassed: false, suggestedNext: 'done', maxValidationRetries: 1 });
  assert.equal(outcome.task.nextState, 'execution', 'a failed verdict overrides the suggestion');
  assert.equal(outcome.autoContinue, true);
  assert.equal(outcome.task.validationAttempts, 1);

  task = SM.advance(finishStep(SM.advance(outcome.task)));
  outcome = SM.completeStep(task, { validationPassed: false, maxValidationRetries: 1 });
  assert.equal(outcome.autoContinue, false);
  assert.match(outcome.task.plannedAction, /Validation failed 2 times/);
  assert.equal(outcome.task.nextState, 'execution');

  const replan = SM.completeStep(SM.advance(finishStep(SM.advance(outcome.task))), { validationPassed: false, suggestedNext: 'planning' });
  assert.equal(replan.task.nextState, 'planning');

  const passed = SM.completeStep(SM.advance(finishStep(SM.advance(outcome.task))), { validationPassed: true, suggestedNext: 'execution' });
  assert.equal(passed.task.nextState, 'done', 'a passed verdict leads to done');
});

test('a failed step moves to error and continue retries the same state', () => {
  const running = SM.advance(finishStep(fresh()));
  const failed = SM.fail(running, 'DeepSeek timed out');
  assert.equal(failed.currentState, 'error');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.resumeState, 'execution');
  assert.equal(failed.nextState, 'execution');
  assert.equal(failed.lastError, 'DeepSeek timed out');
  assert.equal(SM.canTransition(failed, 'planning'), false);
  assert.throws(() => SM.pause(failed), SM.InvalidTransitionError);
  assert.throws(() => SM.fail(failed, 'again'), SM.InvalidTransitionError);

  const retried = SM.advance(failed);
  assert.equal(retried.currentState, 'execution');
  assert.equal(retried.status, 'running');
  assert.equal(retried.lastError, null);
  assert.deepEqual(path(retried).slice(-3), ['execution', 'error', 'execution']);
});

test('user messages re-run the current state, or execution after validation', () => {
  const planning = finishStep(fresh());
  assert.equal(SM.stateForUserMessage(planning), 'planning');
  const rerun = SM.beginStep(planning, 'planning', { reason: 'user message' });
  assert.equal(rerun.history.at(-1).from, 'planning');
  assert.equal(rerun.history.at(-1).reason, 'user message');

  const validation = finishStep(SM.advance(finishStep(SM.advance(planning))), { validationPassed: true });
  assert.equal(SM.stateForUserMessage(validation), 'execution');
  assert.equal(SM.stateForUserMessage(SM.fail(SM.advance(planning), 'x')), 'execution');
  assert.equal(SM.stateForUserMessage(SM.pause(planning)), null);
  assert.equal(SM.stateForUserMessage(fresh()), null);
});

test('a task interrupted by a restart waits to re-run its step', () => {
  const running = SM.advance(finishStep(fresh()));
  const recovered = SM.recoverInterrupted(running);
  assert.equal(recovered.status, 'waiting');
  assert.equal(recovered.currentState, 'execution');
  assert.equal(recovered.nextState, 'execution');
  assert.match(recovered.plannedAction, /interrupted/);
  const again = SM.advance(recovered);
  assert.equal(again.currentState, 'execution');
  assert.equal(again.status, 'running');

  const withPause = SM.recoverInterrupted(SM.pause(running));
  assert.equal(withPause.status, 'paused');
  assert.equal(SM.recoverInterrupted(recovered), recovered, 'non-running tasks are left alone');
});

test('publicTask exposes the fields the UI shows', () => {
  const view = SM.publicTask(finishStep(fresh()));
  for (const key of ['id', 'currentState', 'nextState', 'plannedAction', 'mode', 'status', 'createdAt', 'updatedAt', 'history', 'workMemoryRef']) {
    assert.ok(key in view, key);
  }
  assert.equal(SM.publicTask(null), null);
});
