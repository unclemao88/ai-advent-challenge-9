import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, deferred, fakeLlm, requestedState, waitFor } from './helpers.js';
import { mockReply } from '../scripts/mock-deepseek.js';

test('tasks, conversation and memory survive an application restart', async (t) => {
  const first = await buildApp(t);
  const result = await first.agent.ask({ message: 'Write a script', mode: 'manual' });
  await first.agent.continueTask(result.task.id);
  await first.agent.pauseTask(result.task.id);

  const second = await buildApp(t, { dataDir: first.dataDir });
  const task = await second.tasks.getActiveTask();
  assert.equal(task.id, result.task.id);
  assert.equal(task.state, 'paused');
  assert.equal(task.resumeState, 'execution');
  assert.equal(task.nextState, 'validation');
  assert.equal((await second.conversation.list()).length, 3);
  assert.equal((await second.memory.getShortTermMemory()).length, 3);
  assert.ok((await second.memory.getWorkMemory(task.id)).plan.length > 0);

  const resumed = await second.agent.resumeTask(task.id);
  const next = await second.agent.continueTask(resumed.task.id);
  assert.equal(next.task.state, 'validation');
  assert.equal(requestedState(second.llm.calls[0].messages), 'validation', 'the restarted app continues, it does not start over');
});

test('a step interrupted by a restart is recovered and re-run from the same state', async (t) => {
  const gate = deferred();
  const llm = fakeLlm(async (messages, n) => {
    if (n === 2) await gate.promise; // Hang in execution.
    return mockReply(messages);
  });
  const first = await buildApp(t, { llm });
  const pending = first.agent.ask({ message: 'Long task', mode: 'auto' }).catch(() => {});
  await waitFor(async () => (await first.tasks.getActiveTask())?.state === 'execution');

  // A second process starts on the same data while the first one is "dead".
  const second = await buildApp(t, { dataDir: first.dataDir });
  const task = await second.tasks.getActiveTask();
  assert.equal(task.state, 'execution');
  assert.equal(task.stepStatus, 'pending');
  assert.match(task.plannedAction, /interrupted/);
  assert.ok(second.logger.entries.some((e) => e.event === 'task.recovered_after_restart'));

  const rerun = await second.agent.continueTask(task.id);
  assert.equal(requestedState(second.llm.calls[0].messages), 'execution');
  assert.ok(['validation', 'done'].includes(rerun.task.state));
  gate.resolve();
  await pending;
});
