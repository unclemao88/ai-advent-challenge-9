import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { LongTermMemory } from '../src/memory/longTermMemory.js';
import { JsonFileStorage } from '../src/memory/storage/JsonFileStorage.js';
import { InMemoryStorage } from '../src/memory/storage/InMemoryStorage.js';
import { tempDataDir } from './helpers.js';

test('long-term memory keeps each category in its own file and survives a restart', async (t) => {
  const dir = await tempDataDir(t);
  const memory = new LongTermMemory({ storage: new JsonFileStorage({ directory: dir }) });
  await memory.init();

  await memory.applyUpdates([
    { category: 'profile', key: 'name', value: 'Max' },
    { category: 'preferences', value: 'Short answers' },
    { category: 'solutions', problem: 'Port in use', solution: 'Change PORT' },
    { category: 'knowledge', topic: 'Node.js', fact: 'It is single-threaded' },
  ]);

  assert.deepEqual((await readdir(dir)).sort(), ['knowledge.json', 'preferences.json', 'profile.json', 'solutions.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8')), { name: 'Max' });

  const reloaded = await new LongTermMemory({ storage: new JsonFileStorage({ directory: dir }) }).read();
  assert.deepEqual(reloaded.profile, { name: 'Max' });
  assert.deepEqual(reloaded.preferences, ['Short answers']);
  assert.equal(reloaded.solutions[0].solution, 'Change PORT');
  assert.equal(reloaded.knowledge[0].topic, 'Node.js');
  assert.ok(reloaded.knowledge[0].savedAt);
});

test('long-term updates are deduplicated and invalid ones ignored', async () => {
  const memory = new LongTermMemory({ storage: new InMemoryStorage() });
  await memory.applyUpdates([{ category: 'preferences', value: 'Dark mode' }]);

  const applied = await memory.applyUpdates([
    { category: 'preferences', value: 'dark MODE' },
    { category: 'profile', key: '../evil', value: 'x' },
    { category: 'profile', key: 'name', value: '' },
    { category: 'knowledge', fact: 'No topic given' },
    { category: 'secrets', value: 'nope' },
  ]);

  assert.equal(applied.length, 1);
  const data = await memory.read();
  assert.deepEqual(data.preferences, ['Dark mode']);
  assert.deepEqual(data.profile, {});
  assert.equal(data.knowledge[0].topic, 'general');
});

test('clearing long-term memory empties every category', async () => {
  const memory = new LongTermMemory({ storage: new InMemoryStorage() });
  await memory.applyUpdates([
    { category: 'profile', key: 'name', value: 'Max' },
    { category: 'knowledge', topic: 't', fact: 'f' },
  ]);
  await memory.clear();
  assert.deepEqual(await memory.read(), { profile: {}, preferences: [], solutions: [], knowledge: [] });
});
