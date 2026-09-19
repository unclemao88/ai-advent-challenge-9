import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as SM from '../src/agent/stateMachine.js';

const ID = 'task-11111111-1111-4111-8111-111111111111';
const newTask = (mode = 'manual') => SM.createTask({ id: ID, title: 't', request: 'r', mode });
const history = (task) => task.history.map((h) => `${h.from ?? '∅'}→${h.to}`);

test('idle → planning', () => {
  const task = newTask();
  assert.equal(task.state, 'idle');
  assert.equal(task.nextState, 'planning');
  const planning = SM.advance(task);
  assert.equal(planning.state, 'planning');
  assert.equal(planning.stepStatus, 'running');
});

test('planning → execution → validation → done (manual mode stops after each state)', () => {
  let task = SM.advance(newTask());
  let out = SM.completeStep(task);
  assert.equal(out.autoContinue, false, 'manual mode waits for continue');
  assert.deepEqual(out.announce, { currentState: 'planning', nextState: 'execution', plannedAction: SM.STATE_ACTIONS.execution });

  task = SM.advance(out.task);
  assert.equal(task.state, 'execution');
  task = SM.advance(SM.completeStep(task).task);
  assert.equal(task.state, 'validation');
  out = SM.completeStep(task, { validationPassed: true });
  assert.equal(out.task.nextState, 'done');
  task = SM.advance(out.task);
  assert.equal(task.state, 'done');
  assert.equal(task.status, 'done');
  assert.deepEqual(history(task), ['∅→idle', 'idle→planning', 'planning→execution', 'execution→validation', 'validation→done']);
  assert.throws(() => SM.advance(task), SM.InvalidTransitionError);
});

test('auto mode continues without confirmation', () => {
  const out = SM.completeStep(SM.advance(newTask('auto')));
  assert.equal(out.autoContinue, true);
});

test('planning → waiting_for_user → planning (a question)', () => {
  const out = SM.completeStep(SM.advance(newTask('auto')), { needsUserInput: true, plannedAction: 'Ask which OS' });
  assert.equal(out.task.state, 'waiting_for_user');
  assert.equal(out.task.nextState, 'planning');
  assert.equal(out.task.waitingReason, 'question');
  assert.equal(out.autoContinue, false, 'auto mode still stops for required information');
  assert.equal(out.announce.nextState, 'waiting_for_user');
  assert.equal(SM.stateForUserMessage(out.task), 'planning');
  const again = SM.beginStep(out.task, 'planning', { reason: 'user message' });
  assert.equal(again.state, 'planning');
});

test('an invariant conflict stops in waiting_for_user in every mode', () => {
  const conflict = { stage: 'plan', conflicts: [{ invariantId: 'stack', name: 'Backend stack', reason: 'Python' }], resumeIn: 'planning' };
  const out = SM.completeStep(SM.advance(newTask('auto')), { conflict });
  assert.equal(out.task.state, 'waiting_for_user');
  assert.equal(out.task.waitingReason, 'invariant_conflict');
  assert.equal(out.task.pendingConflict.conflicts[0].invariantId, 'stack');
  assert.equal(out.autoContinue, false);
  assert.match(out.announce.plannedAction, /Request permission to modify the invariant "Backend stack"/);
});

test('execution → paused → execution, keeping next state and planned action', () => {
  let task = SM.advance(SM.completeStep(SM.advance(newTask())).task); // execution, running
  task = SM.completeStep(task).task;
  const before = { nextState: task.nextState, plannedAction: task.plannedAction, stepStatus: task.stepStatus };
  const paused = SM.pause(task);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.resumeState, 'execution');
  assert.throws(() => SM.advance(paused), /paused/);
  assert.throws(() => SM.transition(paused, 'validation'), /can only return to execution/);

  const resumed = SM.resume(paused);
  assert.equal(resumed.state, 'execution');
  assert.deepEqual({ nextState: resumed.nextState, plannedAction: resumed.plannedAction, stepStatus: resumed.stepStatus }, before);
  assert.deepEqual(history(resumed).slice(-2), ['execution→paused', 'paused→execution']);
});

test('a pause requested during a running step lands when the step ends', () => {
  const running = SM.advance(newTask('auto'));
  const requested = SM.pause(running);
  assert.equal(requested.state, 'planning');
  assert.equal(requested.pauseRequested, true);
  const out = SM.completeStep(requested);
  assert.equal(out.task.state, 'paused');
  assert.equal(out.autoContinue, false);
});

test('failed validation goes back to execution, then waits for the user after too many retries', () => {
  let task = SM.advance(SM.completeStep(SM.advance(newTask('auto'))).task);
  task = SM.advance(SM.completeStep(task).task); // validation
  let out = SM.completeStep(task, { validationPassed: false, maxValidationRetries: 1 });
  assert.equal(out.task.nextState, 'execution');
  const execution = SM.advance(out.task);
  assert.equal(execution.state, 'execution');
  task = SM.advance(SM.completeStep(execution).task); // validation again
  out = SM.completeStep(task, { validationPassed: false, maxValidationRetries: 1 });
  assert.equal(out.task.state, 'waiting_for_user');
  assert.equal(out.task.waitingReason, 'validation_retries');
});

test('failure and retry; cancel is final', () => {
  const failed = SM.fail(SM.advance(newTask()), 'DeepSeek timeout');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.nextState, 'planning');
  const retried = SM.advance(failed);
  assert.equal(retried.state, 'planning');

  const cancelled = SM.cancel(SM.completeStep(retried).task);
  assert.equal(cancelled.status, 'failed');
  assert.throws(() => SM.advance(cancelled), /cancelled/);
});

test('a step interrupted by a restart is re-run, not restarted from the beginning', () => {
  let task = SM.advance(SM.completeStep(SM.advance(newTask())).task); // execution, running
  task = SM.recoverInterrupted(task);
  assert.equal(task.state, 'execution');
  assert.equal(task.stepStatus, 'pending');
  const rerun = SM.advance(task);
  assert.equal(rerun.state, 'execution');
  assert.equal(rerun.stepStatus, 'running');
});

test('invalid transitions are rejected; suggestions outside the table are ignored', () => {
  assert.throws(() => SM.transition(newTask(), 'execution'), SM.InvalidTransitionError);
  assert.throws(() => SM.transition(newTask(), 'done'), SM.InvalidTransitionError);
  assert.equal(SM.resolveNextState('planning', 'done'), 'execution');
  assert.equal(SM.resolveNextState('planning', 'paused'), 'execution');
  assert.equal(SM.resolveNextState('validation', 'planning'), 'planning');
});
