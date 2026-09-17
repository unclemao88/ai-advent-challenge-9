import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekError } from '../src/deepseek/DeepSeekClient.js';
import { mockReply } from '../scripts/mock-deepseek.js';
import { buildApp, deferred, fakeLlm, requestedState, waitFor } from './helpers.js';

const states = (llm) => llm.calls.map((c) => requestedState(c.messages));

test('manual mode runs one state per call and waits for continue', async (t) => {
  const llm = fakeLlm();
  const { agent, memory } = await buildApp(t, { llm });

  const planned = await agent.chat({ message: 'Explain systemd timers' });
  assert.equal(planned.task.currentState, 'planning');
  assert.equal(planned.task.nextState, 'execution');
  assert.equal(planned.task.status, 'waiting');
  assert.equal(planned.task.mode, 'manual');
  assert.match(planned.response, /Plan/);
  assert.deepEqual(planned.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(planned.messages[1].task.currentState, 'planning', 'the answer carries the task state');
  for (const key of ['shortTerm', 'workMemory', 'longTerm', 'currentRequestContext']) {
    assert.equal(typeof planned.tokens[key], 'number', key);
  }
  assert.equal(llm.calls[0].options.json, true, 'JSON output mode is requested');

  const executed = await agent.continueTask(planned.task.id);
  assert.equal(executed.task.currentState, 'execution');
  assert.equal(executed.task.nextState, 'validation');
  const validated = await agent.continueTask(planned.task.id);
  assert.equal(validated.task.currentState, 'validation');
  assert.equal(validated.task.nextState, 'done');
  const done = await agent.continueTask(planned.task.id);
  assert.equal(done.task.currentState, 'done');
  assert.equal(done.task.status, 'completed');
  assert.equal(done.messages[0].kind, 'status');
  assert.deepEqual(states(llm), ['planning', 'execution', 'validation'], 'done needs no model call');
  await assert.rejects(() => agent.continueTask(planned.task.id), /already finished/);

  const work = await memory.getWorkMemory(planned.task.id);
  assert.equal(work.objective, 'Explain systemd timers');
  assert.deepEqual(work.plan, ['Understand the request', 'Produce the answer', 'Check it']);
  assert.equal(work.intermediateResults[0].state, 'execution');
  assert.equal(work.validationResults[0].passed, true);

  const next = await agent.chat({ message: 'A new question' });
  assert.notEqual(next.task.id, planned.task.id, 'after done, a message starts a new task');
});

test('auto mode runs planning → execution → validation → done without stopping', async (t) => {
  const llm = fakeLlm();
  const { agent, tasks } = await buildApp(t, { llm });
  const result = await agent.chat({ message: 'Write a hello script', mode: 'auto' });
  assert.equal(result.task.status, 'completed');
  assert.deepEqual(states(llm), ['planning', 'execution', 'validation']);
  assert.deepEqual(result.task.history.map((h) => h.to), ['planning', 'execution', 'validation', 'done']);
  assert.deepEqual(result.messages.map((m) => m.kind ?? 'message'), ['message', 'message', 'message', 'message', 'status']);
  assert.equal((await tasks.getDefaultMode()), 'manual', 'passing a mode for one task does not change the default');
});

test('auto mode loops back after a failed validation', async (t) => {
  const llm = fakeLlm();
  const { agent } = await buildApp(t, { llm });
  const result = await agent.chat({ message: 'Write a script, fail validation', mode: 'auto' });
  assert.equal(result.task.status, 'completed');
  assert.deepEqual(states(llm), ['planning', 'execution', 'validation', 'execution', 'validation']);
  assert.equal(result.task.validationAttempts, 1);
});

test('auto mode stops when the model needs the user, and a reply re-runs planning', async (t) => {
  const llm = fakeLlm();
  const { agent } = await buildApp(t, { llm });
  const asked = await agent.chat({ message: 'Plan a deployment, ask me first', mode: 'auto' });
  assert.equal(asked.task.status, 'waiting');
  assert.equal(asked.task.currentState, 'planning');
  assert.match(asked.task.plannedAction, /Re-plan|answer/);
  assert.deepEqual(states(llm), ['planning']);

  const answered = await agent.chat({ message: 'Debian 12' });
  assert.equal(answered.task.id, asked.task.id);
  assert.equal(answered.task.status, 'completed', 'auto mode continues after the answer');
  assert.deepEqual(states(llm), ['planning', 'planning', 'execution', 'validation']);
  assert.equal(answered.task.history[1].reason, 'user message');
});

test('switching modes applies to the task and becomes the default', async (t) => {
  const llm = fakeLlm();
  const { agent, tasks } = await buildApp(t, { llm });
  const first = await agent.chat({ message: 'Question' });
  const switched = await agent.setMode(first.task.id, 'auto');
  assert.equal(switched.task.mode, 'auto');
  assert.equal(switched.task.status, 'waiting', 'switching does not run anything by itself');
  assert.equal(await tasks.getDefaultMode(), 'auto');
  const finished = await agent.continueTask(first.task.id);
  assert.equal(finished.task.status, 'completed', 'continue in auto mode runs to the end');
  const second = await agent.chat({ message: 'Another' });
  assert.equal(second.task.mode, 'auto');
  assert.equal(second.task.status, 'completed');
});

test('pausing during a running step pauses after it; resume keeps everything and continues', async (t) => {
  const gate = deferred();
  let call = 0;
  const llm = fakeLlm(async (messages) => {
    call += 1;
    if (call === 2) await gate.promise; // Hold the execution step.
    return mockReply(messages);
  });
  const { agent, tasks, memory } = await buildApp(t, { llm });

  const running = agent.chat({ message: 'Long job', mode: 'auto' });
  await waitFor(() => llm.calls.length === 2);
  const active = await tasks.getActiveTask();
  assert.equal(active.currentState, 'execution');
  assert.equal(active.status, 'running');

  const pauseResult = await agent.pauseTask(active.taskId);
  assert.equal(pauseResult.task.status, 'running');
  assert.equal(pauseResult.task.pauseRequested, true);
  await assert.rejects(() => agent.chat({ message: 'interrupt' }), /still working/);
  await assert.rejects(() => agent.continueTask(active.taskId), /still working/);

  gate.resolve();
  const result = await running;
  assert.equal(result.task.status, 'paused');
  assert.equal(result.task.currentState, 'paused');
  assert.equal(result.task.resumeState, 'execution');
  assert.equal(result.task.nextState, 'validation');
  assert.equal(llm.calls.length, 2, 'nothing ran after the pause');
  const workBefore = await memory.getWorkMemory(active.taskId);
  assert.equal(workBefore.intermediateResults.length, 1);

  await assert.rejects(() => agent.chat({ message: 'while paused' }), /paused/);
  await assert.rejects(() => agent.continueTask(active.taskId), /resume it first/);

  const resumed = await agent.resumeTask(active.taskId);
  assert.equal(resumed.task.status, 'completed', 'auto mode continues after resume');
  assert.deepEqual(states(llm), ['planning', 'execution', 'validation']);
  const path = resumed.task.history.map((h) => h.to);
  assert.deepEqual(path, ['planning', 'execution', 'paused', 'execution', 'validation', 'done']);
});

test('resume in manual mode only returns to the state', async (t) => {
  const { agent, llm } = await buildApp(t);
  const first = await agent.chat({ message: 'Question' });
  const paused = await agent.pauseTask(first.task.id);
  assert.equal(paused.task.status, 'paused');
  const resumed = await agent.resumeTask(first.task.id);
  assert.equal(resumed.task.status, 'waiting');
  assert.equal(resumed.task.currentState, 'planning');
  assert.equal(resumed.task.nextState, 'execution');
  assert.equal(llm.calls.length, 1);
});

test('an API failure keeps the user message, puts the task in error, and continue retries', async (t) => {
  let fail = true;
  const llm = fakeLlm((messages) => {
    if (fail) throw new DeepSeekError('timeout', 'DeepSeek API did not answer within 60s. Please try again.', { status: 504 });
    return mockReply(messages);
  });
  const { agent, memory } = await buildApp(t, { llm });

  const err = await agent.chat({ message: 'Will this survive?' }).catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.equal(err.status, 504);
  assert.equal(err.result.task.currentState, 'error');
  assert.equal(err.result.task.status, 'failed');
  assert.equal(err.result.task.nextState, 'planning');
  assert.match(err.result.task.lastError, /did not answer/);
  assert.deepEqual(err.result.messages.map((m) => m.content), ['Will this survive?']);
  assert.deepEqual((await memory.getShortTermMemory()).map((m) => m.content), ['Will this survive?']);

  fail = false;
  const retried = await agent.continueTask(err.result.task.id);
  assert.equal(retried.task.currentState, 'planning');
  assert.equal(retried.task.status, 'waiting');
  const lastRequest = llm.calls.at(-1).messages;
  assert.ok(lastRequest.some((m) => m.role === 'user' && m.content === 'Will this survive?'), 'the saved question is in the retried context');
});

test('a failure in the middle of an auto run keeps the answers already given', async (t) => {
  const llm = fakeLlm((messages) => {
    if (requestedState(messages) === 'validation') throw new DeepSeekError('network', 'Unable to connect to DeepSeek API.');
    return mockReply(messages);
  });
  const { agent } = await buildApp(t, { llm });
  const err = await agent.chat({ message: 'Go', mode: 'auto' }).catch((e) => e);
  assert.equal(err.code, 'network');
  assert.equal(err.result.messages.length, 3, 'question, plan and result are returned');
  assert.equal(err.result.task.resumeState, 'validation');
});

test('a missing API key is reported and nothing is lost', async (t) => {
  const llm = fakeLlm(() => {
    throw new DeepSeekError('missing_api_key', 'DeepSeek API key is missing.', { status: 503 });
  });
  const { agent } = await buildApp(t, { llm });
  const err = await agent.chat({ message: 'Hello?' }).catch((e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.result.messages[0].content, 'Hello?');
});

test('malformed or non-JSON model output is handled without failing the step', async (t) => {
  const replies = ['Just prose, no JSON at all.', '```json\n{"response": "Fenced", "nextState": "validation"}\n```', '{"response": 42, "nextState": "teleport"}'];
  const llm = fakeLlm((messages, n) => replies[n - 1]);
  const { agent } = await buildApp(t, { llm });
  const a = await agent.chat({ message: 'Q' });
  assert.equal(a.response, 'Just prose, no JSON at all.');
  assert.equal(a.task.nextState, 'execution', 'default transition when nothing is suggested');
  const b = await agent.continueTask(a.task.id);
  assert.equal(b.response, 'Fenced');
  assert.equal(b.task.nextState, 'validation');
  const c = await agent.continueTask(a.task.id);
  assert.equal(c.response, 'The agent returned no text for this step.');
  assert.equal(c.task.nextState, 'done', 'an invalid suggestion falls back to the default');
});

test('an invalid state suggestion from the model is ignored', async (t) => {
  const llm = fakeLlm((messages) => ({ ...mockReply(messages), nextState: 'done' }));
  const { agent } = await buildApp(t, { llm });
  const result = await agent.chat({ message: 'Try to skip ahead' });
  assert.equal(result.task.nextState, 'execution');
});

test('the request context contains every layer in order', async (t) => {
  const llm = fakeLlm();
  const { agent, memory, profiles } = await buildApp(t, { llm });
  await profiles.saveProfile({ style: 'brief' });
  await memory.saveFact({ category: 'knowledge', content: 'The build server is ci.example.com' });
  const first = await agent.chat({ message: 'requirement: use port 3013\nSet up the service' });
  await agent.continueTask(first.task.id);

  const [system, ...rest] = llm.calls[1].messages;
  const text = system.content;
  const at = (s) => text.indexOf(s);
  assert.ok(at('Style: brief') > 0);
  assert.ok(at('The build server is ci.example.com') > at('Style: brief'));
  assert.ok(at('- use port 3013') > at('The build server'), 'work memory after long-term memory');
  assert.ok(at('\n\n[SHORT-TERM MEMORY]') > at('- use port 3013'));
  assert.deepEqual(rest.slice(0, -1).map((m) => m.role), ['user', 'assistant'], 'short-term turns before the request');
  assert.match(rest.at(-1).content, /^\[CURRENT REQUEST\][\s\S]*Current state: execution/);
  assert.equal(first.memoryUpdates[0].field, 'requirements');
});

test('long-term memory is only written by explicit commands, not by conversation or suggestions', async (t) => {
  const llm = fakeLlm();
  const { agent, memory } = await buildApp(t, { llm });
  const result = await agent.chat({ message: 'I like tea and my server runs Debian', mode: 'auto' });
  assert.equal(result.task.status, 'completed');
  const proposals = result.messages.flatMap((m) => m.proposals ?? []);
  assert.equal(proposals.length, 1, 'the model suggested something');
  const lt = await memory.getLongTermMemory();
  assert.deepEqual([lt.profile.length, lt.solutions.length, lt.knowledge.length], [0, 0, 0]);

  const withCommand = await agent.chat({ message: 'remember preference: I like tea' });
  assert.deepEqual(withCommand.memoryUpdates, [{
    layer: 'longTerm', category: 'profile', content: 'I like tea', id: withCommand.memoryUpdates[0].id, created: true,
  }]);
  assert.equal((await memory.getLongTermMemory()).profile.length, 1);

  // A suggestion that is already stored is not offered again.
  await memory.saveFact({ category: 'solutions', content: 'Print a greeting in sh with: echo "hello"' });
  const again = await agent.continueTask(withCommand.task.id);
  assert.deepEqual(again.messages.flatMap((m) => m.proposals ?? []), []);
});

test('preview counts the next request without sending or storing anything', async (t) => {
  const llm = fakeLlm();
  const { agent, memory, tasks } = await buildApp(t, { llm });
  const empty = await agent.tokenSummary('');
  const typed = await agent.tokenSummary('A fairly long question about configuring nginx reverse proxies');
  assert.ok(typed.currentRequestContext > empty.currentRequestContext);
  assert.ok(empty.currentRequestContext > 300, 'system instructions are always counted');
  assert.equal(typed.target.newTask, true);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(await memory.getShortTermMemory(), []);
  assert.deepEqual(await tasks.listTasks(), []);

  const first = await agent.chat({ message: 'Question one' });
  const preview = await agent.preview('Follow-up');
  assert.equal(preview.target.newTask, false);
  assert.equal(preview.target.taskId, first.task.id);
  assert.equal(preview.target.state, 'planning');
  // Same builder as the real request: previewing then sending gives the same count.
  await agent.chat({ message: 'Follow-up' });
  assert.equal(llm.calls.at(-1).messages.length, preview.context.messages.length);
});

test('new task detaches the active one; tasks can be reactivated and deleted', async (t) => {
  const { agent, tasks, memory } = await buildApp(t);
  const first = await agent.chat({ message: 'First' });
  await agent.startNewSession();
  assert.equal(await tasks.getActiveTask(), null);
  const second = await agent.chat({ message: 'Second' });
  assert.notEqual(second.task.id, first.task.id);

  const reactivated = await agent.activateTask(first.task.id);
  assert.equal(reactivated.task.id, first.task.id);
  assert.equal((await tasks.getActiveTask()).taskId, first.task.id);

  await agent.deleteTask(first.task.id);
  assert.equal(await tasks.getTask(first.task.id), null);
  assert.equal(await tasks.getActiveTask(), null);
  assert.deepEqual((await memory.work.listTaskIds()), [second.task.id]);
});
