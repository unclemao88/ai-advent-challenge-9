import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { JsonFileStorage } from '../src/memory/storage/JsonFileStorage.js';
import { InMemoryStorage } from '../src/memory/storage/InMemoryStorage.js';
import { DisabledStorage } from '../src/memory/storage/DisabledStorage.js';
import { createStorage, isStorageMode, listStorageModes } from '../src/memory/storageManager.js';
import { tempDataDir, quietLogger } from './helpers.js';

test('JSON storage writes one file per document and reads it back', async (t) => {
  const dir = await tempDataDir(t);
  const storage = new JsonFileStorage({ directory: dir });

  assert.equal(await storage.read('profile'), undefined, 'a missing file reads as undefined');
  await storage.write('profile', { name: 'Max' });

  assert.deepEqual(await storage.read('profile'), { name: 'Max' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8')), { name: 'Max' });
  assert.equal(storage.persistent, true);
  assert.equal(storage.enabled, true);
});

test('JSON storage survives many concurrent writes without corrupting the file', async (t) => {
  const dir = await tempDataDir(t);
  const storage = new JsonFileStorage({ directory: dir });

  const big = (n) => ({ n, padding: 'x'.repeat(50_000) });
  await Promise.all(Array.from({ length: 25 }, (_, n) => storage.write('conversation', big(n))));

  const stored = await storage.read('conversation');
  assert.equal(typeof stored.n, 'number');
  assert.equal(stored.padding.length, 50_000);
  const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temporary files are left behind');
});

test('JSON storage moves a corrupt file aside instead of overwriting it', async (t) => {
  const dir = await tempDataDir(t);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'knowledge.json'), '{ not json');
  const logger = quietLogger();
  const storage = new JsonFileStorage({ directory: dir, logger });

  assert.equal(await storage.read('knowledge'), undefined);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('knowledge.json.corrupt-')), 'the bad file is kept for recovery');
  assert.match(logger.lines.join('\n'), /not valid JSON/);
});

test('JSON storage refuses document names that could escape its directory', async (t) => {
  const storage = new JsonFileStorage({ directory: await tempDataDir(t) });
  for (const name of ['../settings', 'a/b', '..', '', 'UPPER', 'x'.repeat(80)]) {
    await assert.rejects(() => storage.write(name, {}), /Invalid memory document name/, name);
  }
});

test('in-memory storage keeps values but hands out copies', async () => {
  const storage = new InMemoryStorage();
  const value = { list: [1] };
  await storage.write('doc', value);
  value.list.push(2);

  const read = await storage.read('doc');
  assert.deepEqual(read, { list: [1] });
  read.list.push(3);
  assert.deepEqual(await storage.read('doc'), { list: [1] });
  assert.equal(storage.persistent, false);
});

test('disabled storage stores nothing and reports itself disabled', async () => {
  const storage = new DisabledStorage();
  await storage.write('doc', { a: 1 });
  assert.equal(await storage.read('doc'), undefined);
  assert.equal(storage.enabled, false);
});

test('the storage registry creates every advertised mode', async (t) => {
  const layerDirectory = await tempDataDir(t);
  const modes = listStorageModes().map((m) => m.mode);
  assert.deepEqual(modes, ['json', 'memory', 'disabled']);

  for (const mode of modes) {
    assert.ok(isStorageMode(mode));
    assert.equal(createStorage(mode, { layerDirectory }).mode, mode);
  }
  assert.equal(isStorageMode('redis'), false);
  assert.throws(() => createStorage('redis', { layerDirectory }), /Unknown storage mode/);
});
