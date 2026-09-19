import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, deferred, fakeLlm, requestedState, waitFor } from './helpers.js';
import { mockReply } from '../scripts/mock-deepseek.js';

const stackInvariant = { id: 'stack', name: 'Backend stack', value: 'Backend must use Node.js + Express.', category: 'stackLimitations' };

test('manual mode: one state per call, each answer exposes current state, next state and planned action', async (t) => {
  const { agent, llm, history } = await buildApp(t);
  let result = await agent.ask({ message: 'Write a hello world script', mode: 'manual' });
  assert.equal(result.task.state, 'planning');
  assert.equal(result.task.stepStatus, 'completed');
  assert.equal(result.task.nextState, 'execution');
  assert.ok(result.task.plannedAction);
  const answer = result.messages.at(-1);
  assert.equal(answer.tag, 'agent answered');
  assert.deepEqual([answer.task.state, answer.task.nextState, answer.task.mode], ['planning', 'execution', 'manual']);
  assert.equal(llm.calls.length, 1);

  result = await agent.continueTask(result.task.id);
  assert.equal(result.task.state, 'execution');
  result = await agent.continueTask(result.task.id);
  assert.equal(result.task.state, 'validation');
  assert.equal(result.task.nextState, 'done');
  result = await agent.continueTask(result.task.id);
  assert.equal(result.task.state, 'done');
  assert.equal(result.task.nextState, null);
  assert.equal(result.task.plannedAction, 'none');
  assert.equal(result.task.completion.outcome, 'done');
  assert.equal(llm.calls.length, 3, 'finishing does not call DeepSeek');
  assert.deepEqual(llm.calls.map((c) => requestedState(c.messages)), ['planning', 'execution', 'validation']);

  const log = await history.list();
  assert.deepEqual(log.filter((m) => m.role === 'user').map((m) => m.tag), ['you asked']);
  assert.ok(log.filter((m) => m.role === 'assistant').every((m) => m.tag === 'agent answered'));
  assert.ok(log.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date) && /^\d{2}:\d{2}:\d{2}$/.test(m.time)));
});

test('auto mode runs planning → execution → validation → done without confirmation', async (t) => {
  const { agent, llm, memory, tasks } = await buildApp(t);
  const result = await agent.ask({ message: 'Write a hello world script', mode: 'auto' });
  assert.equal(result.task.state, 'done');
  assert.equal(llm.calls.length, 3);
  const task = await tasks.getTask(result.task.id);
  assert.deepEqual(task.history.map((h) => h.to), ['planning', 'execution', 'validation', 'done'], 'no stage skipped');
  const work = await memory.getWorkMemory(result.task.id);
  assert.equal(work.plan.length, 3);
  assert.equal(work.validationResults.at(-1).passed, true);
  assert.equal((await memory.getLongTermMemory()).solutions.length, 0, 'nothing is promoted automatically');
});

test('completion offers promotion candidates; only an explicit save reaches long-term memory', async (t) => {
  const { agent, memory } = await buildApp(t);
  const result = await agent.ask({ message: 'Write a hello world script', mode: 'auto' });
  const status = result.messages.at(-1);
  assert.equal(status.kind, 'status');
  assert.match(status.content, /Nothing is kept in long-term memory automatically/);
  assert.ok(status.proposals.length >= 2);
  assert.ok(status.proposals.some((p) => p.origin === 'agent suggestion'));
  assert.ok(status.proposals.some((p) => p.origin === 'task decision' && p.category === 'solutions'));
  assert.equal(result.task.completion.promotionCandidates, status.proposals.length);
  const before = await memory.getLongTermMemory();
  assert.equal(before.solutions.length + before.knowledge.length, 0);
});

test('switching to auto carries on through the legal states; switching to manual stops the chain', async (t) => {
  const { agent, llm } = await buildApp(t);
  const planned = await agent.ask({ message: 'Write a script', mode: 'manual' });
  const auto = await agent.setMode(planned.task.id, 'auto');
  assert.equal(auto.task.mode, 'auto');
  assert.equal(auto.task.state, 'done');
  assert.deepEqual(llm.calls.map((c) => requestedState(c.messages)), ['planning', 'execution', 'validation']);

  const gate = deferred();
  const slow = fakeLlm(async (messages, n) => {
    if (n === 1) await gate.promise;
    return mockReply(messages);
  });
  const second = await buildApp(t, { llm: slow });
  const running = second.agent.ask({ message: 'Long task', mode: 'auto' });
  await waitFor(async () => (await second.tasks.getActiveTask())?.stepStatus === 'running');
  const task = await second.tasks.getActiveTask();
  const manual = await second.agent.setMode(task.id, 'manual');
  assert.equal(manual.task.mode, 'manual');
  gate.resolve();
  const result = await running;
  assert.equal(result.task.state, 'planning', 'the auto chain stopped after the running step');
  assert.equal(result.task.nextState, 'execution');
  assert.equal(slow.calls.length, 1);
});

test('auto mode still stops when the agent needs information, in the same state', async (t) => {
  const { agent } = await buildApp(t);
  const result = await agent.ask({ message: 'Plan a deploy, ask me first', mode: 'auto' });
  assert.equal(result.task.state, 'planning');
  assert.equal(result.task.awaitingInput.reason, 'question');
  await assert.rejects(agent.continueTask(result.task.id), (err) => err.name === 'InvalidTransitionError');
  const next = await agent.ask({ message: 'Debian 12' });
  assert.equal(next.task.state, 'done');
});

test('an illegal state proposal from the model is rejected, shown, and the task keeps its lifecycle', async (t) => {
  const { agent, tasks, logger } = await buildApp(t);
  const result = await agent.ask({ message: 'Please skip ahead to the end', mode: 'manual' });
  assert.equal(result.task.state, 'planning');
  assert.equal(result.task.nextState, 'execution');
  const answer = result.messages.at(-1);
  assert.deepEqual(answer.rejectedTransition, { from: 'planning', to: 'done', reason: 'it would skip execution and validation' });
  assert.equal((await tasks.getTask(result.task.id)).rejectedTransitions.length, 1);
  assert.ok(logger.entries.some((e) => e.event === 'state.proposal_rejected'));
});

test('a request that conflicts with an invariant stops before any API call, in the current state', async (t) => {
  const { agent, llm, invariants, memory } = await buildApp(t);
  await invariants.create(stackInvariant);

  const result = await agent.ask({ message: 'Rewrite backend in Python', mode: 'auto' });
  assert.equal(llm.calls.length, 0, 'no DeepSeek call for a request that plainly breaks an invariant');
  assert.equal(result.task.state, 'planning');
  assert.equal(result.task.awaitingInput.reason, 'invariant_conflict');
  assert.equal(result.task.pendingConflict.conflicts[0].invariantId, 'stack');
  const answer = result.messages.at(-1);
  assert.equal(answer.kind, 'conflict');
  assert.match(answer.content, /Conflict detected with invariant "Backend stack"/);
  assert.deepEqual([answer.task.state, answer.task.nextState], ['planning', 'planning']);
  assert.match(answer.task.plannedAction, /Request permission to modify the invariant/);
  assert.equal((await invariants.get('stack')).value, stackInvariant.value, 'the invariant is untouched');
  const work = await memory.getWorkMemory(result.task.id);
  assert.equal(work.invariantChecks.at(-1).ok, false);
});

test('conflict resolution: keep re-plans within the invariant, disable changes it, cancel ends the task', async (t) => {
  const { agent, llm, invariants } = await buildApp(t);
  await invariants.create(stackInvariant);

  let result = await agent.ask({ message: 'Rewrite backend in Python', mode: 'auto' });
  result = await agent.resolveConflict(result.task.id, 'keep');
  assert.equal(result.task.state, 'done');
  assert.match(llm.calls[0].messages.at(-1).content, /KEEP the active invariants/);
  assert.equal((await invariants.get('stack')).enabled, true);

  await agent.startNewTask();
  result = await agent.ask({ message: 'Rewrite backend in Python', mode: 'manual' });
  result = await agent.resolveConflict(result.task.id, 'disable');
  assert.equal(result.task.state, 'planning');
  assert.equal(result.task.stepStatus, 'completed');
  assert.equal((await invariants.get('stack')).enabled, false, 'changed only by the explicit decision');

  await agent.startNewTask();
  await invariants.setEnabled('stack', true);
  result = await agent.ask({ message: 'Rewrite backend in Python' });
  result = await agent.resolveConflict(result.task.id, 'cancel');
  assert.equal(result.task.state, 'cancelled');
  await assert.rejects(agent.resolveConflict(result.task.id, 'keep'), (err) => err.status === 409);
});

test('results that violate an invariant are rejected and revised: stack, architecture, business rule', async (t) => {
  const { agent, llm, invariants, history } = await buildApp(t);
  await invariants.addExamples();

  for (const message of ['Give me python code for a greeting', 'Split it up like microservices would', 'Remember to store the card for refunds']) {
    await agent.startNewTask();
    const before = llm.calls.length;
    const result = await agent.ask({ message, mode: 'auto' });
    assert.equal(result.task.state, 'done', message);
    const executions = llm.calls.slice(before).filter((c) => requestedState(c.messages) === 'execution');
    assert.equal(executions.length, 2, `${message}: one rejected draft, one revision`);
    assert.match(executions[1].messages.at(-1).content, /REJECTED by the invariant check/);
  }
  const log = await history.list();
  assert.equal(log.filter((m) => m.kind === 'status' && /rejected by the invariant check/.test(m.content)).length, 3);
  assert.ok(!log.some((m) => m.kind === 'message' && /```python|microservices, one per module|full credit card number in the orders/.test(m.content)),
    'a violating draft is never shown as an answer');
});

test('a result that keeps violating an invariant ends in a conflict in execution, not in done', async (t) => {
  const { agent, invariants } = await buildApp(t);
  await invariants.create(stackInvariant);
  const result = await agent.ask({ message: 'always python for this one', mode: 'auto' });
  assert.equal(result.task.state, 'execution');
  assert.equal(result.task.awaitingInput.reason, 'invariant_conflict');
  assert.equal(result.task.nextState, 'execution');
  assert.equal(result.task.pendingConflict.stage, 'response');
});

test('conflicts the model reports itself are enforced', async (t) => {
  const { agent, invariants } = await buildApp(t);
  await invariants.create(stackInvariant);
  const result = await agent.ask({ message: 'model conflict please', mode: 'auto' });
  assert.equal(result.task.awaitingInput.reason, 'invariant_conflict');
  assert.equal(result.task.pendingConflict.conflicts[0].method, 'model');
});

test('a response that breaks the profile is corrected before the user sees it', async (t) => {
  const { agent, llm, profiles, memory } = await buildApp(t);
  await profiles.updateProfile({ style: 'concise', format: 'plain text', limitations: 'max 60 words, no code' });
  const result = await agent.ask({ message: 'A verbose answer please', mode: 'manual' });
  assert.equal(llm.calls.length, 2, 'one rejected response, one correction');
  assert.match(llm.calls[1].messages.at(-1).content, /did NOT FOLLOW THE USER PROFILE[\s\S]*at most 60/i);
  const answer = result.messages.at(-1);
  assert.ok(!answer.content.includes('```'));
  assert.deepEqual(answer.profileCheck, { ok: true, issues: [], revisions: 1 });
  const work = await memory.getWorkMemory(result.task.id);
  assert.equal(work.profileChecks.at(-1).revisions, 1);
});

test('a profile violation that survives the correction is shown, not hidden', async (t) => {
  const llm = fakeLlm((messages) => ({ ...mockReply(messages), response: 'word '.repeat(80) }));
  const { agent, profiles } = await buildApp(t, { llm });
  await profiles.updateProfile({ limitations: 'max 20 words' });
  const result = await agent.ask({ message: 'Hello', mode: 'manual' });
  const answer = result.messages.at(-1);
  assert.equal(answer.profileCheck.ok, false);
  assert.equal(answer.profileCheck.issues[0].rule, 'length');
  assert.equal(llm.calls.length, 2);
});

test('invariants are included in every request as constraints', async (t) => {
  const { agent, llm, invariants } = await buildApp(t);
  await invariants.create(stackInvariant);
  await invariants.create({ id: 'off', name: 'Disabled rule', value: 'Use COBOL', category: 'stackLimitations', enabled: false });
  await agent.ask({ message: 'Add a /health endpoint', mode: 'auto' });
  for (const call of llm.calls) {
    assert.match(call.messages[0].content, /\[AGENT INVARIANTS\]\nStack limitation:\n- \[stack\] Backend stack: Backend must use Node\.js \+ Express\./);
    assert.ok(!call.messages[0].content.includes('COBOL'), 'disabled invariants are not sent');
  }
});

test('pause and resume keep the task where it was', async (t) => {
  const { agent, llm } = await buildApp(t);
  let result = await agent.ask({ message: 'Write a script', mode: 'manual' });
  result = await agent.continueTask(result.task.id); // execution done
  const paused = await agent.pauseTask(result.task.id);
  assert.equal(paused.task.state, 'paused');
  assert.equal(paused.task.resumeState, 'execution');
  await assert.rejects(agent.ask({ message: 'more' }), (err) => err.status === 409 && err.code === 'task_paused');
  await assert.rejects(agent.continueTask(result.task.id), /paused/);

  const resumed = await agent.resumeTask(result.task.id);
  assert.equal(resumed.task.state, 'execution');
  assert.equal(resumed.task.nextState, 'validation');
  const calls = llm.calls.length;
  const next = await agent.continueTask(result.task.id);
  assert.equal(next.task.state, 'validation', 'continues from the saved state, not from the beginning');
  assert.equal(llm.calls.length, calls + 1);
});

test('a pause requested during a running step lands after it; auto mode stops there and resumes on', async (t) => {
  const gate = deferred();
  const llm = fakeLlm(async (messages, n) => {
    if (n === 1) await gate.promise;
    return mockReply(messages);
  });
  const { agent, tasks } = await buildApp(t, { llm });
  const running = agent.ask({ message: 'Long task', mode: 'auto' });
  await waitFor(async () => (await tasks.getActiveTask())?.stepStatus === 'running');
  const task = await tasks.getActiveTask();
  const requested = await agent.pauseTask(task.id);
  assert.equal(requested.task.pauseRequested, true);
  await assert.rejects(agent.continueTask(task.id), (err) => err.status === 409 && err.code === 'task_busy');
  gate.resolve();
  const result = await running;
  assert.equal(result.task.state, 'paused');
  assert.equal(result.task.resumeState, 'planning');
  assert.equal(llm.calls.length, 1);

  const resumed = await agent.resumeTask(task.id);
  assert.equal(resumed.task.state, 'done', 'auto mode runs on after resume');
});

test('API failures move the task to failed without losing anything; retry continues the same state', async (t) => {
  let fail = true;
  const llm = fakeLlm((messages) => {
    if (fail) {
      const err = new Error('DeepSeek API did not answer within 60s. Please try again.');
      Object.assign(err, { name: 'DeepSeekError', code: 'timeout', status: 504 });
      throw err;
    }
    return mockReply(messages);
  });
  const { agent, tasks, history, memory } = await buildApp(t, { llm });
  const err = await agent.ask({ message: 'Hello', mode: 'manual' }).catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.equal(err.result.task.state, 'failed');
  assert.equal(err.result.task.nextState, 'planning');
  const log = await history.list();
  assert.ok(log.some((m) => m.role === 'user' && m.content === 'Hello'), 'the question is kept');
  assert.ok(log.some((m) => m.kind === 'error'));
  assert.equal((await memory.getWorkMemory(err.result.task.id)).objective, 'Hello');

  fail = false;
  const task = await tasks.getActiveTask();
  const retried = await agent.continueTask(task.id);
  assert.equal(retried.task.state, 'planning');
  assert.equal(retried.task.status, 'active');
});

test('memory commands update the right layer only', async (t) => {
  const { agent, memory } = await buildApp(t);
  const result = await agent.ask({ message: 'remember solution: use nginx for TLS\nrequirement: port 3015\nPlan the deploy' });
  assert.deepEqual(result.memoryUpdates.map((u) => u.layer), ['longTerm', 'work']);
  assert.equal((await memory.getLongTermMemory()).solutions[0].content, 'use nginx for TLS');
  assert.ok((await memory.getWorkMemory(result.task.id)).requirements.includes('port 3015'));
});

test('relevant long-term memory is retrieved, irrelevant memory is not sent', async (t) => {
  const { agent, llm, memory } = await buildApp(t);
  await memory.addMemory('longTerm', { category: 'solutions', content: 'Nginx proxy config for port 3015', tags: ['deploy'] });
  await memory.addMemory('longTerm', { category: 'knowledge', content: 'The cat is called Tom' });
  await agent.ask({ message: 'Configure nginx for the app' });
  const system = llm.calls[0].messages[0].content;
  assert.ok(system.includes('Nginx proxy config'));
  assert.ok(!system.includes('Tom'));
});
