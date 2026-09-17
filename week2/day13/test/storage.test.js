import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { JsonFileBackend } from '../src/storage/JsonFileBackend.js';
import { MemoryBackend } from '../src/storage/MemoryBackend.js';
import { createBackend, isBackendType, listBackends, normalizeBackendOptions } from '../src/storage/registry.js';
import { logger, tempDir } from './helpers.js';

async function jsonBackend(t, options = {}) {
  const dataDir = await tempDir(t);
  const backend = new JsonFileBackend({ directory: path.join(dataDir, 'layer'), dataDir, logger: logger(), ...options });
  await backend.init();
  return { backend, dataDir, dir: path.join(dataDir, 'layer') };
}

test('JSON backend stores, lists and deletes documents', async (t) => {
  const { backend } = await jsonBackend(t);
  assert.equal(await backend.get('doc'), undefined);
  await backend.put('doc', { a: 1 });
  await backend.put('task-1', { b: 2 });
  assert.deepEqual(await backend.get('doc'), { a: 1 });
  assert.deepEqual(await backend.list(), ['doc', 'task-1']);
  assert.deepEqual(await backend.list('task-'), ['task-1']);
  assert.equal(await backend.delete('doc'), true);
  assert.equal(await backend.delete('doc'), false);
  assert.deepEqual(await backend.list(), ['task-1']);
  assert.equal(backend.location, 'data/layer/');
});

test('JSON backend writes atomically and keeps the previous version as .bak', async (t) => {
  const { backend, dir } = await jsonBackend(t);
  await backend.put('doc', { version: 1 });
  await backend.put('doc', { version: 2 });
  const files = await readdir(dir);
  assert.deepEqual(files.sort(), ['doc.json', 'doc.json.bak']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'doc.json.bak'), 'utf8')), { version: 1 });

  // Concurrent writes never interleave or leave temporary files behind.
  await Promise.all(Array.from({ length: 20 }, (_, i) => backend.put('doc', { i })));
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')));
  assert.equal(typeof (await backend.get('doc')).i, 'number');
});

test('JSON backend without backups writes no .bak file', async (t) => {
  const { backend, dir } = await jsonBackend(t, { backup: false });
  await backend.put('doc', 1);
  await backend.put('doc', 2);
  assert.deepEqual(await readdir(dir), ['doc.json']);
});

test('a corrupt file is moved aside, not overwritten', async (t) => {
  const { backend, dir } = await jsonBackend(t);
  await writeFile(path.join(dir, 'doc.json'), '{ broken');
  assert.equal(await backend.get('doc'), undefined);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('doc.json.corrupt-')));
  assert.ok(!files.includes('doc.json'));
});

test('keys that could escape the directory are rejected', async (t) => {
  const { backend } = await jsonBackend(t);
  for (const key of ['../evil', '..', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(200), 'a.json']) {
    await assert.rejects(() => backend.put(key, 1), /Invalid storage key/, key);
    await assert.rejects(() => backend.get(key), /Invalid storage key/, key);
  }
});

test('snapshot copies every document into data/backups', async (t) => {
  const { backend, dataDir } = await jsonBackend(t);
  assert.equal(await backend.snapshot('layer'), null, 'nothing to back up yet');
  await backend.put('one', 1);
  await backend.put('two', 2);
  const location = await backend.snapshot('layer');
  assert.match(location, /^data\/backups\/layer-/);
  const files = await readdir(path.join(dataDir, location.replace(/^data\//, '')));
  assert.deepEqual(files.sort(), ['one.json', 'two.json']);
});

test('memory backend clones values and is not persistent', async () => {
  const backend = new MemoryBackend();
  const value = { list: [1] };
  await backend.put('doc', value);
  value.list.push(2);
  const read = await backend.get('doc');
  assert.deepEqual(read, { list: [1] });
  read.list.push(3);
  assert.deepEqual(await backend.get('doc'), { list: [1] });
  assert.equal(backend.persistent, false);
});

test('registry validates backend types and options', async (t) => {
  assert.ok(isBackendType('json'));
  assert.ok(isBackendType('memory'));
  assert.ok(!isBackendType('sqlite'));
  assert.deepEqual(normalizeBackendOptions('json', {}), { backup: true });
  assert.deepEqual(normalizeBackendOptions('json', { backup: false, unknown: 1 }), { backup: false });
  assert.throws(() => normalizeBackendOptions('json', { backup: 'yes' }), /must be a boolean/);
  assert.ok(listBackends().every((b) => b.label && b.description));
  const dir = await tempDir(t);
  const backend = await createBackend('json', { directory: path.join(dir, 'x'), dataDir: dir, options: {}, logger: logger() });
  assert.equal(backend.type, 'json');
  await assert.rejects(() => createBackend('nope', { directory: dir, dataDir: dir, options: {}, logger: logger() }), /Unknown storage backend/);
});
