import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mockReply } from '../scripts/mock-deepseek.js';
import { buildApp, deferred, fakeLlm, tempDir, waitFor } from './helpers.js';

test('tasks, memory, profile and settings survive an application restart', async (t) => {
  const dataDir = await tempDir(t);

  // --- First run ---
  const first = await buildApp(t, { dataDir });
  await first.profiles.saveProfile({ style: 'concise', format: 'markdown', limitations: 'none' });
  const planned = await first.agent.chat({ message: 'remember solution: restart with systemctl\nrequirement: keep it simple\nDo the thing' });
  const executed = await first.agent.continueTask(planned.task.id);
  await first.agent.pauseTask(planned.task.id);
  const other = await first.agent.chat({ message: 'blocked while paused' }).catch((e) => e);
  assert.equal(other.code, 'task_paused');
  await first.memory.updateStorage({ shortTerm: { maxMessages: 25 } });
  await first.tasks.setDefaultMode('auto');

  // --- Restart: a brand-new application on the same data directory ---
  const second = await buildApp(t, { dataDir });
  const task = await second.tasks.getActiveTask();
  assert.equal(task.taskId, planned.task.id);
  assert.equal(task.status, 'paused');
  assert.equal(task.resumeState, 'execution');
  assert.equal(task.nextState, executed.task.nextState);
  assert.equal(task.plannedAction, executed.task.plannedAction);
  assert.equal(task.mode, 'manual');
  assert.equal(task.createdAt, planned.task.createdAt);
  assert.deepEqual(task.history.map((h) => h.to), ['planning', 'execution', 'paused']);
  assert.deepEqual(task.workMemoryRef, { layer: 'work', key: `task-${task.taskId}` });

  const messages = await second.memory.getShortTermMemory();
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'assistant'], 'question, plan, result');
  assert.equal(messages[2].task.currentState, 'execution');
  assert.deepEqual((await second.memory.getWorkMemory(task.taskId)).requirements.slice(0, 1), ['keep it simple']);
  assert.equal((await second.memory.getLongTermMemory()).solutions[0].content, 'restart with systemctl');
  assert.equal((await second.profiles.getProfile()).style, 'concise');
  assert.equal(second.memory.describeStorage().shortTerm.maxMessages, 25);
  assert.equal(await second.tasks.getDefaultMode(), 'auto');

  // The restored task carries on where it stopped.
  const resumed = await second.agent.resumeTask(task.taskId);
  assert.equal(resumed.task.currentState, 'execution');
  const validated = await second.agent.continueTask(task.taskId);
  assert.equal(validated.task.currentState, 'validation');
});

test('a task interrupted mid-step is recovered after a restart and can be retried', async (t) => {
  const dataDir = await tempDir(t);
  const gate = deferred();
  const hanging = fakeLlm(async (messages) => {
    await gate.promise;
    return mockReply(messages);
  });
  const first = await buildApp(t, { dataDir, llm: hanging });
  const pending = first.agent.chat({ message: 'Crash during planning' });
  await waitFor(() => hanging.calls.length === 1);
  assert.equal((await first.tasks.getActiveTask()).status, 'running');

  // "Crash": a second process starts while the first never finished its step.
  const llm = fakeLlm();
  const second = await buildApp(t, { dataDir, llm });
  const recovered = await second.tasks.getActiveTask();
  assert.equal(recovered.status, 'waiting');
  assert.equal(recovered.currentState, 'planning');
  assert.equal(recovered.nextState, 'planning');
  assert.match(recovered.plannedAction, /interrupted/);
  assert.ok(second.logger.entries.some((e) => e.event === 'task.recovered_after_restart'));
  assert.equal((await second.memory.getShortTermMemory())[0].content, 'Crash during planning');

  const retried = await second.agent.continueTask(recovered.taskId);
  assert.equal(retried.task.status, 'waiting');
  assert.equal(retried.task.nextState, 'execution');
  assert.ok(llm.calls[0].messages.some((m) => m.content === 'Crash during planning'));

  gate.resolve();
  await pending.catch(() => {});
});

test('corrupt task files are ignored instead of crashing the app', async (t) => {
  const dataDir = await tempDir(t);
  const first = await buildApp(t, { dataDir });
  const { task } = await first.agent.chat({ message: 'ok' });
  await first.tasks.backend.put(`task-${task.id}`, { taskId: task.id, currentState: 'teleporting', status: 'running' });
  const second = await buildApp(t, { dataDir });
  assert.equal(await second.tasks.getActiveTask(), null);
  assert.deepEqual(await second.tasks.listTasks(), []);
});
