import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { MemoryManager } from '../src/agent/memoryManager.js';
import { createConversationMessage } from '../src/memory/shortTermMemory.js';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings/settingsStore.js';
import { tempDataDir, quietLogger } from './helpers.js';

const settingsWith = (overrides) => {
  const memory = structuredClone(DEFAULT_SETTINGS.memory);
  for (const [layer, value] of Object.entries(overrides)) Object.assign(memory[layer], value);
  return memory;
};

async function seed(manager) {
  await manager.shortTerm.append(createConversationMessage('user', 'hi'), createConversationMessage('assistant', 'hello'));
  await manager.work.applyUpdates([{ field: 'task', value: 'Ship it' }]);
  await manager.longTerm.applyUpdates([{ category: 'profile', key: 'name', value: 'Max' }]);
}

test('first start creates a separate directory and files for every layer', async (t) => {
  const dataDir = await tempDataDir(t);
  const manager = new MemoryManager({ dataDir });
  await manager.init();

  for (const file of [
    'short-term/conversation.json',
    'work/current-task.json',
    'long-term/profile.json',
    'long-term/preferences.json',
    'long-term/solutions.json',
    'long-term/knowledge.json',
  ]) {
    assert.ok((await stat(path.join(dataDir, file))).isFile(), file);
  }
});

test('clearing one layer leaves the other two untouched', async (t) => {
  const manager = new MemoryManager({ dataDir: await tempDataDir(t) });
  await manager.init();

  await seed(manager);
  await manager.clear('work');
  let all = await manager.loadAll();
  assert.equal(all.work.task, '');
  assert.equal(all.shortTerm.length, 2);
  assert.deepEqual(all.longTerm.profile, { name: 'Max' });

  await seed(manager);
  await manager.clear('shortTerm');
  all = await manager.loadAll();
  assert.equal(all.shortTerm.length, 0);
  assert.equal(all.work.task, 'Ship it');

  await manager.clear('longTerm');
  all = await manager.loadAll();
  assert.deepEqual(all.longTerm.profile, {});
  assert.equal(all.work.task, 'Ship it');

  assert.throws(() => manager.layer('everything'), /Unknown memory layer/);
});

test('switching JSON → in-memory carries contents over and stops writing the file', async (t) => {
  const dataDir = await tempDataDir(t);
  const manager = new MemoryManager({ dataDir });
  await manager.init();
  await seed(manager);

  await manager.applySettings(settingsWith({ work: { storage: 'memory' } }));
  assert.equal(manager.work.storageMode, 'memory');
  assert.equal((await manager.work.getTask()).task, 'Ship it', 'the agent still remembers the task');

  await manager.work.applyUpdates([{ field: 'task', value: 'Changed in memory' }]);
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'work/current-task.json'), 'utf8'));
  assert.equal(onDisk.task, 'Ship it', 'the file is no longer updated');

  // Back to JSON: the in-memory contents are written to disk.
  await manager.applySettings(settingsWith({}));
  const written = JSON.parse(await readFile(path.join(dataDir, 'work/current-task.json'), 'utf8'));
  assert.equal(written.task, 'Changed in memory');
});

test('a disabled layer reads as empty, keeps its files, and comes back when re-enabled', async (t) => {
  const dataDir = await tempDataDir(t);
  const manager = new MemoryManager({ dataDir });
  await manager.init();
  await seed(manager);

  await manager.applySettings(settingsWith({ longTerm: { storage: 'disabled' } }));
  assert.equal(manager.longTerm.enabled, false);
  assert.deepEqual((await manager.loadAll()).longTerm.profile, {});

  await manager.longTerm.applyUpdates([{ category: 'profile', key: 'name', value: 'Ignored' }]);
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'long-term/profile.json'), 'utf8'));
  assert.deepEqual(onDisk, { name: 'Max' }, 'nothing is written while disabled');

  await manager.applySettings(settingsWith({}));
  assert.deepEqual((await manager.loadAll()).longTerm.profile, { name: 'Max' });
});

test('in-memory mode starts empty after a restart', async (t) => {
  const dataDir = await tempDataDir(t);
  const settings = settingsWith({ shortTerm: { storage: 'memory' } });

  const first = new MemoryManager({ dataDir, settings });
  await first.init();
  await seed(first);

  const restarted = new MemoryManager({ dataDir, settings });
  await restarted.init();
  const all = await restarted.loadAll();
  assert.equal(all.shortTerm.length, 0);
  assert.equal(all.work.task, 'Ship it', 'JSON-backed layers are unaffected');
});

test('settings persist separately from memory and reject invalid values', async (t) => {
  const dataDir = await tempDataDir(t);
  const file = path.join(dataDir, 'settings.json');
  const store = new SettingsStore({ file, logger: quietLogger() });

  assert.deepEqual(await store.load(), DEFAULT_SETTINGS);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), DEFAULT_SETTINGS, 'defaults are written on first start');

  await store.save({ memory: { work: { storage: 'disabled' }, shortTerm: { maxMessages: 50 } } });
  const reloaded = await new SettingsStore({ file }).load();
  assert.equal(reloaded.memory.work.storage, 'disabled');
  assert.equal(reloaded.memory.shortTerm.maxMessages, 50);
  assert.equal(reloaded.memory.longTerm.storage, 'json');

  await assert.rejects(() => store.save({ memory: { work: { storage: 'cloud' } } }), /must be one of/);
  await assert.rejects(() => store.save({ memory: { shortTerm: { maxMessages: 1 } } }), /maxMessages/);
  await assert.rejects(() => store.save({ memory: { brain: {} } }), /Unknown memory layer/);
  assert.equal(store.get().memory.work.storage, 'disabled', 'a rejected save changes nothing');
});
