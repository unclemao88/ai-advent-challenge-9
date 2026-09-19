import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, deferred, fakeLlm, requestedState, waitFor } from './helpers.js';
import { mockReply } from '../scripts/mock-deepseek.js';
import { resolveInside } from '../src/persistence/dataPaths.js';

const readJson = async (dir, file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'));

test('each persistent domain has its own directory and file', async (t) => {
  const { agent, dataDir, profiles, invariants } = await buildApp(t);
  await profiles.updateProfile({ style: 'concise' });
  await invariants.addExamples();
  const { task } = await agent.ask({ message: 'Write a script', mode: 'manual' });

  assert.deepEqual((await readdir(dataDir)).sort(), ['config', 'history', 'invariants', 'memory', 'profile', 'tasks']);
  assert.deepEqual((await readdir(path.join(dataDir, 'memory'))).filter((f) => f.endsWith('.json')).sort(),
    ['long-term.json', 'short-term.json', 'work-memory.json']);
  assert.equal((await readJson(dataDir, 'profile/profile.json')).profile.style, 'concise');
  assert.equal((await readJson(dataDir, 'invariants/invariants.json')).stackLimitations[0].id, 'stack');
  assert.equal((await readJson(dataDir, 'config/memory-storage.json')).work.provider, 'json');
  assert.equal((await readJson(dataDir, 'tasks/active.json')).activeTaskId, task.id);

  const stored = await readJson(dataDir, `tasks/${task.id}.json`);
  assert.equal(stored.state, 'planning');
  assert.deepEqual(stored.workMemory, { layer: 'work', key: task.id });
  const history = await readJson(dataDir, 'history/chat-history.json');
  assert.deepEqual(history.messages.map((m) => m.tag), ['you asked', 'agent answered']);
  const historyText = JSON.stringify(history);
  assert.ok(!historyText.includes('"history":['), 'tasks are not stored in the chat history');
  assert.ok(!JSON.stringify(await readJson(dataDir, 'memory/short-term.json')).includes('stackLimitations'), 'invariants are not in the conversation');
});

test('tasks, chat history, profile, invariants and memory survive an application restart', async (t) => {
  const first = await buildApp(t);
  await first.profiles.updateProfile({ style: 'kept' });
  await first.invariants.create({ name: 'Keep me', value: 'Node.js', category: 'stackLimitations' });
  const result = await first.agent.ask({ message: 'Write a script', mode: 'manual' });
  await first.agent.continueTask(result.task.id);
  await first.agent.pauseTask(result.task.id);

  const second = await buildApp(t, { dataDir: first.dataDir });
  const task = await second.tasks.getActiveTask();
  assert.equal(task.id, result.task.id);
  assert.equal(task.state, 'paused');
  assert.equal(task.resumeState, 'execution');
  assert.equal(task.nextState, 'validation');
  assert.equal((await second.history.list()).length, 3);
  assert.equal((await second.memory.getShortTermMemory()).length, 3);
  assert.ok((await second.memory.getWorkMemory(task.id)).plan.length > 0);
  assert.equal((await second.profiles.getProfile()).style, 'kept');
  assert.equal((await second.invariants.list()).length, 1);

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

test('a corrupt data file is moved aside and never takes the app down', async (t) => {
  const first = await buildApp(t);
  await first.profiles.updateProfile({ style: 'x' });
  const { task } = await first.agent.ask({ message: 'Hello', mode: 'manual' });
  await writeFile(path.join(first.dataDir, 'profile', 'profile.json'), '{ broken');
  await writeFile(path.join(first.dataDir, 'tasks', `${task.id}.json`), 'nope');

  const second = await buildApp(t, { dataDir: first.dataDir });
  assert.equal(await second.profiles.getProfile(), null);
  assert.equal(await second.tasks.getActiveTask(), null, 'the broken task reads as missing');
  assert.equal((await second.history.list()).length, 2, 'other domains are untouched');
  assert.ok((await readdir(path.join(first.dataDir, 'profile'))).some((f) => f.startsWith('profile.json.corrupt-')));
  const next = await second.agent.ask({ message: 'Start again', mode: 'manual' });
  assert.equal(next.task.state, 'planning');
});

test('writes are atomic: no temporary files are left behind', async (t) => {
  const { agent, dataDir } = await buildApp(t);
  await agent.ask({ message: 'Write a script', mode: 'auto' });
  const all = [];
  for (const dir of await readdir(dataDir)) all.push(...await readdir(path.join(dataDir, dir)));
  assert.ok(!all.some((f) => f.endsWith('.tmp')));
});

test('file access is restricted to the data directory', () => {
  const dir = '/srv/data';
  assert.equal(resolveInside(dir, 'memory/short-term.json'), '/srv/data/memory/short-term.json');
  for (const bad of ['../etc/passwd.json', '/etc/passwd.json', 'a/b/c.json', 'memory/../../x.json', 'x.txt', '', null]) {
    assert.throws(() => resolveInside(dir, bad), /Invalid data file name|outside/, String(bad));
  }
});
