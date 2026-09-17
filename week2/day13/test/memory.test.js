import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractMemoryCommands } from '../src/memory/memoryCommands.js';
import { memoryManager, tempDir } from './helpers.js';

const TASK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// --- Short-term ----------------------------------------------------------------

test('short-term memory saves, loads, deletes and clears messages', async (t) => {
  const memory = await memoryManager(t);
  assert.deepEqual(await memory.getShortTermMemory(), []);

  const q = await memory.addMessage({ role: 'user', content: 'Hello', taskId: TASK });
  const a = await memory.addMessage({ role: 'assistant', content: 'Hi there', taskId: TASK, task: { currentState: 'planning' } });
  const list = await memory.getShortTermMemory();
  assert.deepEqual(list.map((m) => [m.role, m.content]), [['user', 'Hello'], ['assistant', 'Hi there']]);
  assert.ok(q.id && q.timestamp && !Number.isNaN(Date.parse(q.timestamp)));
  assert.equal(list[1].task.currentState, 'planning');

  assert.equal(await memory.deleteMessage(q.id), true);
  assert.equal(await memory.deleteMessage(q.id), false);
  assert.deepEqual((await memory.getShortTermMemory()).map((m) => m.id), [a.id]);

  await memory.clearShortTermMemory();
  assert.deepEqual(await memory.getShortTermMemory(), []);
});

test('short-term memory keeps only the configured number of messages', async (t) => {
  const memory = await memoryManager(t, { shortTermMaxMessages: 3 });
  for (let i = 1; i <= 5; i += 1) await memory.addMessage({ role: 'user', content: `m${i}` });
  assert.deepEqual((await memory.getShortTermMemory()).map((m) => m.content), ['m3', 'm4', 'm5']);

  await memory.updateStorage({ shortTerm: { maxMessages: 2 } });
  assert.deepEqual((await memory.getShortTermMemory()).map((m) => m.content), ['m4', 'm5']);
});

test('short-term token count grows with content and ignores status notes', async (t) => {
  const memory = await memoryManager(t);
  assert.equal(await memory.shortTerm.calculateTokenCount(), 0);
  await memory.addMessage({ role: 'user', content: 'How do I configure systemd?' });
  const one = await memory.shortTerm.calculateTokenCount();
  assert.ok(one > 5);
  await memory.addMessage({ role: 'assistant', kind: 'status', content: 'Task complete. Long status text here.' });
  assert.equal(await memory.shortTerm.calculateTokenCount(), one);
  await memory.addMessage({ role: 'assistant', content: 'Write a unit file.' });
  assert.ok(await memory.shortTerm.calculateTokenCount() > one);
});

test('short-term memory rejects invalid messages', async (t) => {
  const memory = await memoryManager(t);
  assert.throws(() => memory.addMessage({ role: 'system', content: 'x' }), /Invalid role/);
  assert.throws(() => memory.addMessage({ role: 'user', content: '   ' }), /needs content/);
});

// --- Work ----------------------------------------------------------------------

test('work memory is created, merged, loaded, replaced, cleared and deleted per task', async (t) => {
  const memory = await memoryManager(t);
  const created = await memory.createWorkMemory(TASK, { objective: 'Deploy the app' });
  assert.equal(created.objective, 'Deploy the app');

  await memory.updateWorkMemory(TASK, { requirements: ['Use systemd', 'use SYSTEMD'], decisions: ['Port 3013'], plan: ['a', 'b'] });
  await memory.updateWorkMemory(TASK, { requirements: ['Run as deepseek-app'], intermediateResults: ['Unit written'], variables: { port: 3013 } }, { state: 'execution' });
  await memory.updateWorkMemory(TASK, { validationResults: [{ text: 'All good', passed: true }] }, { state: 'validation' });

  const work = await memory.getWorkMemory(TASK);
  assert.deepEqual(work.requirements, ['Use systemd', 'Run as deepseek-app'], 'duplicates are dropped case-insensitively');
  assert.deepEqual(work.plan, ['a', 'b']);
  assert.equal(work.intermediateResults[0].state, 'execution');
  assert.equal(work.validationResults[0].passed, true);
  assert.deepEqual(work.variables, { port: '3013' });
  assert.ok(memory.work.calculateTokenCount(work) > 10);

  const replaced = await memory.replaceWorkMemory(TASK, { objective: 'New', requirements: ['Only one'] });
  assert.deepEqual(replaced.requirements, ['Only one']);
  assert.deepEqual(replaced.decisions, []);
  assert.equal(replaced.intermediateResults.length, 1, 'results are a record and survive an edit');

  const cleared = await memory.clearWorkMemory(TASK);
  assert.equal(cleared.objective, '');
  assert.deepEqual(cleared.intermediateResults, []);

  assert.equal(await memory.deleteWorkMemory(TASK), true);
  assert.deepEqual((await memory.getWorkMemory(TASK)).requirements, []);
});

test('work memory of different tasks is kept apart and bounded', async (t) => {
  const memory = await memoryManager(t);
  await memory.createWorkMemory(TASK, { objective: 'A' });
  await memory.createWorkMemory(OTHER, { objective: 'B' });
  await memory.updateWorkMemory(TASK, { facts: Array.from({ length: 50 }, (_, i) => `fact ${i}`) });
  assert.equal((await memory.getWorkMemory(TASK)).facts.length, 30);
  assert.deepEqual((await memory.getWorkMemory(OTHER)).facts, []);
  assert.deepEqual((await memory.work.listTaskIds()).sort(), [TASK, OTHER].sort());
});

// --- Long-term -----------------------------------------------------------------

test('long-term memory saves, deduplicates, updates, moves, searches and deletes entries', async (t) => {
  const memory = await memoryManager(t);
  const { fact, created } = await memory.saveFact({ category: 'solutions', content: 'Restart nginx with systemctl reload nginx', tags: ['nginx', 'Linux'] });
  assert.equal(created, true);
  assert.deepEqual(fact.tags, ['nginx', 'linux']);
  const again = await memory.saveFact({ category: 'solutions', content: '  restart NGINX with systemctl reload nginx ' });
  assert.equal(again.created, false);
  assert.equal(again.fact.id, fact.id);

  await memory.saveFact({ category: 'knowledge', content: 'The office VPN uses WireGuard' });
  await memory.saveFact({ category: 'profile', content: 'The user runs Debian 12' });

  const results = await memory.searchMemory('how to reload nginx');
  assert.equal(results[0].id, fact.id);
  assert.ok(results[0].score > 0);
  assert.deepEqual(await memory.searchMemory('kubernetes'), []);

  const moved = await memory.updateFact(fact.id, { category: 'knowledge', content: 'nginx reload: systemctl reload nginx' });
  assert.equal(moved.category, 'knowledge');
  const all = await memory.getLongTermMemory();
  assert.equal(all.solutions.length, 0);
  assert.equal(all.knowledge.length, 2);
  assert.equal(await memory.updateFact('ltm_missing', { content: 'x' }), null);

  assert.equal(await memory.deleteFact(fact.id), true);
  assert.equal(await memory.deleteFact(fact.id), false);

  await memory.clearMemory('knowledge');
  const after = await memory.getLongTermMemory();
  assert.equal(after.knowledge.length, 0);
  assert.equal(after.profile.length, 1, 'clearing one category leaves the others');
  await memory.clearMemory();
  assert.equal((await memory.getLongTermMemory()).profile.length, 0);
});

test('long-term memory rejects unknown categories and empty content', async (t) => {
  const memory = await memoryManager(t);
  assert.throws(() => memory.saveFact({ category: 'secrets', content: 'x' }), /Unknown long-term memory category/);
  assert.throws(() => memory.saveFact({ category: 'knowledge', content: '  ' }), /needs content/);
});

test('long-term context selection stays within the budget and prefers profile notes and relevance', async (t) => {
  const memory = await memoryManager(t);
  await memory.saveFact({ category: 'profile', content: 'The user prefers Debian' });
  await memory.saveFact({ category: 'knowledge', content: 'PostgreSQL listens on port 5432 by default' });
  for (let i = 0; i < 30; i += 1) {
    await memory.saveFact({ category: 'knowledge', content: `Unrelated note number ${i} about gardening and tomatoes in the summer` });
  }
  const everything = await memory.longTerm.selectForContext('postgres port', 100_000);
  assert.equal(everything.included, 32);

  const limited = await memory.longTerm.selectForContext('which port does postgresql use', 40);
  assert.ok(limited.included < 32);
  assert.equal(limited.memory.profile.length, 1);
  assert.ok(limited.memory.knowledge.some((k) => k.content.includes('PostgreSQL')));
  assert.ok(memory.longTerm.calculateTokenCount(limited.memory) <= 40 + 5);
});

// --- Separation and storage configuration ------------------------------------------

test('the three layers are stored in separate directories and cleared independently', async (t) => {
  const dataDir = await tempDir(t);
  const memory = await memoryManager(t, { dataDir });
  await memory.addMessage({ role: 'user', content: 'short-term text' });
  await memory.createWorkMemory(TASK, { objective: 'work text' });
  await memory.saveFact({ category: 'knowledge', content: 'long-term text' });

  assert.deepEqual(await readdir(path.join(dataDir, 'short-term')), ['conversation.json']);
  assert.deepEqual(await readdir(path.join(dataDir, 'work-memory')), [`task-${TASK}.json`]);
  assert.deepEqual((await readdir(path.join(dataDir, 'long-term'))).filter((f) => f.endsWith('.json')), ['knowledge.json']);

  const shortFile = await readFile(path.join(dataDir, 'short-term', 'conversation.json'), 'utf8');
  assert.ok(shortFile.includes('short-term text'));
  assert.ok(!shortFile.includes('work text') && !shortFile.includes('long-term text'));

  await memory.clearShortTermMemory();
  assert.equal((await memory.getWorkMemory(TASK)).objective, 'work text');
  assert.equal((await memory.getLongTermMemory()).knowledge.length, 1);
});

test('switching a layer to another backend copies its data and never deletes the old files', async (t) => {
  const dataDir = await tempDir(t);
  const memory = await memoryManager(t, { dataDir });
  await memory.saveFact({ category: 'knowledge', content: 'kept across the switch' });

  const toMemory = await memory.updateStorage({ layers: { longTerm: { backend: 'memory' } } });
  assert.equal(toMemory.storage.layers.longTerm.backend, 'memory');
  assert.equal(toMemory.storage.layers.longTerm.persistent, false);
  assert.equal(toMemory.changes[0].copied, 1);
  assert.equal((await memory.getLongTermMemory()).knowledge[0].content, 'kept across the switch');

  // Written only to the in-memory backend; the file on disk is untouched.
  await memory.saveFact({ category: 'knowledge', content: 'volatile entry' });
  const onDisk = await readFile(path.join(dataDir, 'long-term', 'knowledge.json'), 'utf8');
  assert.ok(onDisk.includes('kept across the switch'));
  assert.ok(!onDisk.includes('volatile entry'));

  // Back to JSON: the current contents are copied and the old files are backed up first.
  const back = await memory.updateStorage({ layers: { longTerm: { backend: 'json' } } });
  assert.match(back.changes[0].backup, /^data\/backups\/longTerm-/);
  const contents = (await memory.getLongTermMemory()).knowledge.map((k) => k.content);
  assert.deepEqual(contents, ['kept across the switch', 'volatile entry']);
  const backups = await readdir(path.join(dataDir, 'backups'));
  assert.equal(backups.length, 1);
});

test('storage configuration is validated and persisted', async (t) => {
  const dataDir = await tempDir(t);
  const memory = await memoryManager(t, { dataDir });
  await assert.rejects(() => memory.updateStorage({ layers: { nope: { backend: 'json' } } }), /Unknown memory layer/);
  await assert.rejects(() => memory.updateStorage({ layers: { work: { backend: 'sqlite' } } }), /Unknown storage backend/);
  await assert.rejects(() => memory.updateStorage({ layers: { work: { options: { backup: 'no' } } } }), /must be a boolean/);
  await assert.rejects(() => memory.updateStorage({ shortTerm: { maxMessages: 1 } }), /whole number/);

  await memory.updateStorage({ layers: { work: { backend: 'json', options: { backup: false } } }, shortTerm: { maxMessages: 12 } });
  const restarted = await memoryManager(t, { dataDir });
  const described = restarted.describeStorage();
  assert.deepEqual(described.layers.work.options, { backup: false });
  assert.equal(described.shortTerm.maxMessages, 12);
  assert.equal(described.layers.shortTerm.location, 'data/short-term/');
});

test('memory survives a restart', async (t) => {
  const dataDir = await tempDir(t);
  const first = await memoryManager(t, { dataDir });
  await first.addMessage({ role: 'user', content: 'persisted question' });
  await first.createWorkMemory(TASK, { objective: 'persisted objective' });
  await first.saveFact({ category: 'solutions', content: 'persisted solution' });

  const second = await memoryManager(t, { dataDir });
  assert.equal((await second.getShortTermMemory())[0].content, 'persisted question');
  assert.equal((await second.getWorkMemory(TASK)).objective, 'persisted objective');
  assert.equal((await second.getLongTermMemory()).solutions[0].content, 'persisted solution');
});

// --- Explicit memory rules -----------------------------------------------------------

test('memory commands are recognised only in explicit lines', () => {
  const { longTerm, work } = extractMemoryCommands([
    'Please help me.',
    'remember: the staging host is 10.0.0.5',
    'remember solution: clear the cache with npm cache clean --force',
    '- remember preference: answers in English',
    'requirement: must run on Debian',
    'decision: use port 3013',
    'fact: node 22 is installed',
    'I want you to remember everything', // not a command
  ].join('\n'));
  assert.deepEqual(longTerm, [
    { category: 'knowledge', content: 'the staging host is 10.0.0.5' },
    { category: 'solutions', content: 'clear the cache with npm cache clean --force' },
    { category: 'profile', content: 'answers in English' },
  ]);
  assert.deepEqual(work, { requirements: ['must run on Debian'], decisions: ['use port 3013'], facts: ['node 22 is installed'] });
  assert.deepEqual(extractMemoryCommands('Just a normal question about memory: how does it work?'), { longTerm: [], work: {} });
});
