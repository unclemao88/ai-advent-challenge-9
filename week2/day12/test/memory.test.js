import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { JsonFileStorage } from '../src/memory/storage/JsonFileStorage.js';
import { InMemoryStorage } from '../src/memory/storage/InMemoryStorage.js';
import { DisabledStorage } from '../src/memory/storage/DisabledStorage.js';
import { ProfileStore } from '../src/memory/profile.js';
import { WorkMemory } from '../src/memory/workMemory.js';
import { LongTermMemory } from '../src/memory/longTermMemory.js';
import { ConversationStore, createEntry } from '../src/memory/conversationStore.js';
import { ShortTermMemory, createConversationMessage } from '../src/memory/shortTermMemory.js';
import { tempDataDir, quietLogger } from './helpers.js';

const storage = () => new InMemoryStorage();

test('profile keeps only known fields and trims them', async () => {
  const profile = new ProfileStore({ storage: storage() });
  const saved = await profile.save({ style: '  direct  ', nonsense: 'x', limitations: 'no emojis' });

  assert.equal(saved.style, 'direct');
  assert.equal(saved.limitations, 'no emojis');
  assert.equal(saved.nonsense, undefined);
  assert.ok(saved.createdAt);
});

test('profile: a partial save leaves other fields alone', async () => {
  const profile = new ProfileStore({ storage: storage() });
  await profile.save({ style: 'direct', format: 'bullets' });
  const after = await profile.save({ style: 'warm' });

  assert.equal(after.style, 'warm');
  assert.equal(after.format, 'bullets');
});

test('profile: clear empties the fields but keeps the record; delete resets it', async () => {
  const profile = new ProfileStore({ storage: storage() });
  await profile.save({ style: 'direct' });

  const cleared = await profile.clearFields();
  assert.equal(cleared.style, '');
  assert.ok(cleared.createdAt, 'clearing keeps the creation date');
  assert.ok(ProfileStore.isEmpty(cleared));

  const removed = await profile.remove();
  assert.equal(removed.createdAt, null);
});

test('work memory collects updates and skips duplicates', async () => {
  const work = new WorkMemory({ storage: storage() });
  await work.applyUpdates([{ field: 'decisions', value: 'Use Express' }]);
  const second = await work.applyUpdates([
    { field: 'decisions', value: 'use express' },
    { field: 'task', value: 'Ship day 12' },
    { field: 'nope', value: 'ignored' },
  ]);

  assert.deepEqual(second, [{ field: 'task', value: 'Ship day 12' }]);
  const task = await work.getTask();
  assert.deepEqual(task.decisions, ['Use Express']);
  assert.equal(task.task, 'Ship day 12');
});

test('work memory can be replaced wholesale by an edit', async () => {
  const work = new WorkMemory({ storage: storage() });
  await work.applyUpdates([{ field: 'todos', value: 'old' }]);
  const replaced = await work.replace({ task: 'New task', todos: ['a', '  ', 'b'], junk: 1 });

  assert.equal(replaced.task, 'New task');
  assert.deepEqual(replaced.todos, ['a', 'b']);
  assert.equal(replaced.junk, undefined);
});

test('long-term memory stores solutions and knowledge with ids', async () => {
  const longTerm = new LongTermMemory({ storage: storage() });
  await longTerm.applyUpdates([
    { category: 'solutions', problem: 'Slow start', solution: 'Cache the index' },
    { category: 'knowledge', topic: 'node', fact: 'fetch is built in' },
    { category: 'knowledge', topic: 'node', fact: 'FETCH IS BUILT IN' },
  ]);

  const { solutions, knowledge } = await longTerm.getAll();
  assert.equal(solutions.length, 1);
  assert.equal(knowledge.length, 1, 'the duplicate fact is skipped');
  assert.match(solutions[0].id, /[0-9a-f-]{36}/);

  assert.equal(await longTerm.removeEntry('knowledge', knowledge[0].id), true);
  assert.equal(await longTerm.removeEntry('knowledge', knowledge[0].id), false);
  assert.deepEqual((await longTerm.getAll()).knowledge, []);
});

test('long-term memory: solving the same problem again updates the entry', async () => {
  const longTerm = new LongTermMemory({ storage: storage() });
  await longTerm.applyUpdates([{ category: 'solutions', problem: 'P', solution: 'first' }]);
  await longTerm.applyUpdates([{ category: 'solutions', problem: 'p', solution: 'second' }]);

  const { solutions } = await longTerm.getAll();
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0].solution, 'second');
});

test('conversation entries carry id, date, time and a derived tag', async () => {
  const log = new ConversationStore({ storage: storage(), maxEntries: 3 });
  const entry = createEntry('user', 'hello', new Date('2026-09-16T09:15:00Z'));

  assert.equal(entry.date, '2026-09-16');
  assert.equal(entry.time, '09:15:00');
  assert.equal(entry.tag, 'you asked');

  await log.append(entry, createEntry('assistant', 'hi'), createEntry('user', 'more'), createEntry('assistant', 'ok'));
  const entries = await log.getEntries();
  assert.equal(entries.length, 3, 'the oldest entry is dropped at the cap');
  assert.equal(entries.at(-1).tag, 'agent answered');
});

test('conversation store rewrites a hand-edited tag from the type', async () => {
  const log = new ConversationStore({ storage: storage() });
  await log.append({ id: 'x', type: 'user', tag: 'agent answered', content: 'hi', timestamp: new Date().toISOString() });

  assert.equal((await log.getEntries())[0].tag, 'you asked');
});

test('short-term memory keeps the newest N messages', async () => {
  const shortTerm = new ShortTermMemory({ storage: storage(), maxMessages: 2 });
  await shortTerm.append(
    createConversationMessage('user', 'one'),
    createConversationMessage('assistant', 'two'),
    createConversationMessage('user', 'three'),
  );

  const messages = await shortTerm.getMessages();
  assert.deepEqual(messages.map((m) => m.content), ['three'], 'an orphaned answer is dropped with its question');
});

test('every layer writes its own file, and files survive a reload', async (t) => {
  const dir = await tempDataDir(t);
  const logger = quietLogger();
  const make = (Class, name) => new Class({
    storage: new JsonFileStorage({ directory: path.join(dir, name), logger }),
  });

  const profile = make(ProfileStore, 'profile');
  const work = make(WorkMemory, 'work');
  const longTerm = make(LongTermMemory, 'long-term');

  await profile.save({ style: 'direct' });
  await work.applyUpdates([{ field: 'task', value: 'Ship it' }]);
  await longTerm.applyUpdates([{ category: 'knowledge', topic: 'x', fact: 'y' }]);

  const written = JSON.parse(await readFile(path.join(dir, 'profile', 'profile.json'), 'utf8'));
  assert.equal(written.style, 'direct');
  assert.equal(written.task, undefined, 'the profile file holds no work memory');

  const reloaded = make(ProfileStore, 'profile');
  assert.equal((await reloaded.get()).style, 'direct');
});

test('a disabled layer reads empty and stores nothing', async () => {
  const work = new WorkMemory({ storage: new DisabledStorage() });
  await work.applyUpdates([{ field: 'task', value: 'ignored' }]);

  assert.equal(work.enabled, false);
  assert.equal((await work.getTask()).task, '');
});

test('switching storage carries the contents across', async () => {
  const work = new WorkMemory({ storage: storage() });
  await work.applyUpdates([{ field: 'task', value: 'Carry me' }]);
  await work.switchStorage(new InMemoryStorage());

  assert.equal((await work.getTask()).task, 'Carry me');
});
