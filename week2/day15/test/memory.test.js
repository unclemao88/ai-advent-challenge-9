import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { memoryManager, tempDir } from './helpers.js';
import { KeywordRetriever } from '../src/memory/retrieval.js';
import { extractMemoryCommands } from '../src/memory/memoryCommands.js';

const readJson = async (dir, file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'));
const TASK = 'task-11111111-1111-4111-8111-111111111111';

test('short-term memory: save and load survive a new manager (restart)', async (t) => {
  const dir = await tempDir(t);
  const m1 = await memoryManager(t, { dataDir: dir });
  await m1.addMessage({ role: 'user', content: 'hello', taskId: TASK, state: 'planning' });
  await m1.addMessage({ role: 'assistant', content: 'hi there', taskId: TASK, state: 'planning' });

  const m2 = await memoryManager(t, { dataDir: dir });
  const messages = await m2.getShortTermMemory();
  assert.deepEqual(messages.map((m) => [m.role, m.content, m.state]), [['user', 'hello', 'planning'], ['assistant', 'hi there', 'planning']]);
  assert.ok(messages.every((m) => !Number.isNaN(Date.parse(m.timestamp))));

  await m2.saveShortTermMemory([messages[1]]);
  assert.equal((await m2.getShortTermMemory()).length, 1);
});

test('short-term memory keeps only the configured number of messages', async (t) => {
  const m = await memoryManager(t, { shortTermMaxMessages: 3 });
  for (let i = 0; i < 5; i += 1) await m.addMessage({ role: 'user', content: `m${i}` });
  assert.deepEqual((await m.getShortTermMemory()).map((x) => x.content), ['m2', 'm3', 'm4']);
});

test('work memory: save, load, merge and log every update', async (t) => {
  const dir = await tempDir(t);
  const m = await memoryManager(t, { dataDir: dir });
  await m.createWorkMemory(TASK, { objective: 'Build X' });
  await m.updateWorkMemory(TASK, { plan: ['a', 'b'], decisions: ['use Express'], intermediateResults: ['did a'] }, { state: 'planning' });
  await m.updateWorkMemory(TASK, { decisions: ['use Express', 'port 3015'], variables: { port: 3015 } }, { state: 'execution' });

  const again = await memoryManager(t, { dataDir: dir });
  const doc = await again.getWorkMemory(TASK);
  assert.equal(doc.objective, 'Build X');
  assert.deepEqual(doc.plan, ['a', 'b']);
  assert.deepEqual(doc.decisions, ['use Express', 'port 3015'], 'lists append without duplicates');
  assert.equal(doc.variables.port, '3015');
  assert.equal(doc.intermediateResults[0].state, 'planning');
  assert.deepEqual(doc.log.map((l) => l.state), ['planning', 'planning', 'execution']);

  await again.saveWorkMemory(TASK, { ...doc, facts: ['edited by hand'] });
  assert.deepEqual((await again.getWorkMemory(TASK)).facts, ['edited by hand']);
});

test('long-term memory: save, load, update, delete, no duplicates', async (t) => {
  const dir = await tempDir(t);
  const m = await memoryManager(t, { dataDir: dir });
  const { entry, created } = await m.addMemory('longTerm', { category: 'solutions', content: 'Use nginx as reverse proxy', tags: ['#deploy'] });
  assert.equal(created, true);
  assert.deepEqual(entry.tags, ['deploy']);
  assert.equal((await m.addMemory('longTerm', { category: 'solutions', content: 'use NGINX as reverse proxy' })).created, false);
  await m.addMemory('longTerm', { category: 'knowledge', content: 'Server runs Debian 12' });

  const again = await memoryManager(t, { dataDir: dir });
  const all = await again.getLongTermMemory();
  assert.equal(all.solutions.length, 1);
  assert.equal(all.knowledge.length, 1);
  assert.equal(all.profile, null, 'the profile belongs to long-term memory logically');

  await again.updateMemory('longTerm', entry.id, { content: 'Use Caddy', category: 'knowledge' });
  const moved = await again.getLongTermMemory();
  assert.equal(moved.solutions.length, 0);
  assert.equal(moved.knowledge.length, 2);
  await again.deleteMemory('longTerm', entry.id);
  assert.equal((await again.getLongTermMemory()).knowledge.length, 1);
});

test('the three layers stay in three separate files under data/memory/', async (t) => {
  const dir = await tempDir(t);
  const m = await memoryManager(t, { dataDir: dir });
  await m.addMessage({ role: 'user', content: 'only short-term' });
  await m.createWorkMemory(TASK, { objective: 'only work' });
  await m.addMemory('longTerm', { category: 'knowledge', content: 'only long-term' });

  const short = JSON.stringify(await readJson(dir, 'memory/short-term.json'));
  const work = JSON.stringify(await readJson(dir, 'memory/work-memory.json'));
  const long = JSON.stringify(await readJson(dir, 'memory/long-term.json'));
  assert.ok(short.includes('only short-term') && !short.includes('only work') && !short.includes('only long-term'));
  assert.ok(work.includes('only work') && !work.includes('only short-term') && !work.includes('only long-term'));
  assert.ok(long.includes('only long-term') && !long.includes('only work') && !long.includes('only short-term'));

  await m.clearShortTermMemory();
  assert.equal((await m.getWorkMemory(TASK)).objective, 'only work', 'clearing one layer leaves the others');
  assert.equal((await m.getLongTermMemory()).knowledge.length, 1);
});

test('work memory reaches long-term memory only by explicit promotion', async (t) => {
  const m = await memoryManager(t);
  await m.createWorkMemory(TASK, { objective: 'Deploy' });
  await m.updateWorkMemory(TASK, { decisions: ['Use systemd with Restart=always'] });
  assert.equal((await m.getLongTermMemory()).solutions.length, 0);

  const { entry } = await m.promoteToLongTerm({ taskId: TASK, field: 'decisions', index: 0, category: 'solutions' });
  assert.equal(entry.content, 'Use systemd with Restart=always');
  assert.equal(entry.source, 'promoted');
  assert.deepEqual(entry.origin, { taskId: TASK, field: 'decisions', index: 0 });
  assert.ok((await m.getWorkMemory(TASK)).log.at(-1).fields[0].startsWith('promoted decisions'));
  await assert.rejects(m.promoteToLongTerm({ taskId: TASK, field: 'decisions', index: 5, category: 'solutions' }), /not found/);
});

test('switching a layer to another provider copies its data and leaves the others alone', async (t) => {
  const dir = await tempDir(t);
  const m = await memoryManager(t, { dataDir: dir });
  await m.addMemory('longTerm', { category: 'knowledge', content: 'kept across the switch' });
  await m.addMessage({ role: 'user', content: 'short' });

  const { changes } = await m.updateStorage({ longTerm: { provider: 'memory' } });
  assert.deepEqual(changes.map((c) => [c.layer, c.from, c.to]), [['longTerm', 'json', 'memory']]);
  assert.equal(m.describeStorage().layers.longTerm.persistent, false);
  assert.equal(m.describeStorage().layers.shortTerm.provider, 'json');
  assert.equal((await m.getLongTermMemory()).knowledge[0].content, 'kept across the switch');

  await m.addMemory('longTerm', { category: 'knowledge', content: 'volatile only' });
  const file = JSON.stringify(await readJson(dir, 'memory/long-term.json'));
  assert.ok(!file.includes('volatile only'), 'the memory provider writes nothing to disk');

  const config = await readJson(dir, 'config/memory-storage.json');
  assert.equal(config.longTerm.provider, 'memory');
  assert.equal(config.shortTerm.provider, 'json');
  assert.throws(() => m.configStore.applyPatch(m.config, { work: { provider: 'redis' } }), /Unknown storage provider/);
});

test('a corrupt layer file is moved aside, never overwritten', async (t) => {
  const dir = await tempDir(t);
  await mkdir(path.join(dir, 'memory'), { recursive: true });
  await writeFile(path.join(dir, 'memory', 'work-memory.json'), '{ not json');
  const m = await memoryManager(t, { dataDir: dir });
  assert.deepEqual((await m.getAllWorkMemory()), {});
  assert.ok((await readdir(path.join(dir, 'memory'))).some((f) => f.startsWith('work-memory.json.corrupt-')), 'kept for inspection');
});

test('retrieval sends only relevant long-term entries', () => {
  const now = new Date();
  const items = [
    { id: 'ltm_a1', category: 'solutions', content: 'Nginx reverse proxy config for port 3015', tags: ['deploy'], updatedAt: now.toISOString() },
    { id: 'ltm_b2', category: 'knowledge', content: 'The user likes tea', tags: [] },
    { id: 'ltm_c3', category: 'knowledge', content: 'Always answer in English', tags: [], pinned: true },
    { id: 'ltm_d4', category: 'knowledge', content: 'Database backups run nightly', tags: ['ops'] },
  ];
  const retriever = new KeywordRetriever();
  const pick = (query, budgetTokens = 1000) => retriever.select(items, query, { budgetTokens, cost: () => 10 }).items.map((i) => i.id);

  assert.deepEqual(pick('configure nginx proxy'), ['ltm_c3', 'ltm_a1'], 'pinned first, then relevant; unrelated entries are left out');
  assert.deepEqual(pick('something unrelated'), ['ltm_c3']);
  assert.deepEqual(pick('see #ops'), ['ltm_c3', 'ltm_d4'], 'explicit #tag reference');
  assert.ok(pick('as in ltm_b2').includes('ltm_b2'), 'explicit id reference');
  assert.deepEqual(pick('nginx proxy', 15), ['ltm_c3'], 'the token budget is respected');
});

test('memory commands are explicit and deterministic', () => {
  const { longTerm, work } = extractMemoryCommands('remember: server is Debian\nremember solution: use nginx\nrequirement: port 3015\nplain text');
  assert.deepEqual(longTerm, [{ category: 'knowledge', content: 'server is Debian' }, { category: 'solutions', content: 'use nginx' }]);
  assert.deepEqual(work, { requirements: ['port 3015'] });
});

test('each layer\'s storage is configured independently, and the choice survives a restart', async (t) => {
  const dir = await tempDir(t);
  const m = await memoryManager(t, { dataDir: dir, providers: { shortTerm: 'memory', work: 'json', longTerm: 'json' } });
  const layers = m.describeStorage().layers;
  assert.deepEqual([layers.shortTerm.provider, layers.work.provider, layers.longTerm.provider], ['memory', 'json', 'json']);
  assert.deepEqual([layers.work.location, layers.longTerm.location], ['data/memory/work-memory.json', 'data/memory/long-term.json']);

  await m.updateStorage({ work: { provider: 'memory' }, longTerm: { options: { backup: false } } });
  const again = await memoryManager(t, { dataDir: dir });
  const stored = again.describeStorage().layers;
  assert.deepEqual([stored.shortTerm.provider, stored.work.provider, stored.longTerm.provider], ['memory', 'memory', 'json']);
  assert.equal(stored.longTerm.options.backup, false);
});
