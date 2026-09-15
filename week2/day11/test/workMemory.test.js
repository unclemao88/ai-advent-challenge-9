import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { WorkMemory } from '../src/memory/workMemory.js';
import { JsonFileStorage } from '../src/memory/storage/JsonFileStorage.js';
import { InMemoryStorage } from '../src/memory/storage/InMemoryStorage.js';
import { tempDataDir } from './helpers.js';

test('work memory stores task facts in data/work/current-task.json', async (t) => {
  const dir = await tempDataDir(t);
  const memory = new WorkMemory({ storage: new JsonFileStorage({ directory: dir }) });
  await memory.init();

  const applied = await memory.applyUpdates([
    { field: 'task', value: 'Build a Node.js DeepSeek agent' },
    { field: 'requirements', value: 'Use three memory layers' },
    { field: 'decisions', value: 'Use Express.js' },
    { field: 'currentState', value: 'Implementing memory manager' },
  ]);
  assert.equal(applied.length, 4);

  const reloaded = new WorkMemory({ storage: new JsonFileStorage({ directory: dir }) });
  const task = await reloaded.getTask();
  assert.equal(task.task, 'Build a Node.js DeepSeek agent');
  assert.deepEqual(task.requirements, ['Use three memory layers']);
  assert.deepEqual(task.decisions, ['Use Express.js']);
  assert.equal(task.currentState, 'Implementing memory manager');
  assert.ok(task.updatedAt);

  const file = JSON.parse(await readFile(path.join(dir, 'current-task.json'), 'utf8'));
  assert.equal(file.task, 'Build a Node.js DeepSeek agent');
});

test('list fields accumulate, single fields are replaced, duplicates are skipped', async () => {
  const memory = new WorkMemory({ storage: new InMemoryStorage() });
  await memory.applyUpdates([{ field: 'todos', value: 'Write tests' }, { field: 'task', value: 'First' }]);

  const applied = await memory.applyUpdates([
    { field: 'todos', value: 'write TESTS' },
    { field: 'todos', value: 'Write README' },
    { field: 'task', value: 'Second' },
    { field: 'unknown', value: 'ignored' },
    { field: 'decisions', value: '   ' },
  ]);

  assert.deepEqual(applied.map((u) => u.field), ['todos', 'task']);
  const task = await memory.getTask();
  assert.deepEqual(task.todos, ['Write tests', 'Write README']);
  assert.equal(task.task, 'Second');
});

test('clearing work memory resets the task', async () => {
  const memory = new WorkMemory({ storage: new InMemoryStorage() });
  await memory.applyUpdates([{ field: 'task', value: 'Something' }]);
  await memory.clear();

  const task = await memory.getTask();
  assert.equal(task.task, '');
  assert.deepEqual(task.decisions, []);
});
