import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ShortTermMemory, createConversationMessage } from '../src/memory/shortTermMemory.js';
import { JsonFileStorage } from '../src/memory/storage/JsonFileStorage.js';
import { InMemoryStorage } from '../src/memory/storage/InMemoryStorage.js';
import { tempDataDir } from './helpers.js';

const user = (text, when) => createConversationMessage('user', text, when);
const agent = (text, when) => createConversationMessage('assistant', text, when);

test('short-term memory keeps the conversation in order and persists it as JSON', async (t) => {
  const dir = await tempDataDir(t);
  const memory = new ShortTermMemory({ storage: new JsonFileStorage({ directory: dir }) });
  await memory.init();

  const asked = new Date('2026-09-15T10:32:00Z');
  await memory.append(user('What is Node.js?', asked), agent('Node.js is a runtime.'));
  await memory.append(user('And Express?'), agent('A web framework.'));

  // A new instance over the same directory: what a restart sees.
  const reloaded = new ShortTermMemory({ storage: new JsonFileStorage({ directory: dir }) });
  const messages = await reloaded.getMessages();
  assert.deepEqual(messages.map((m) => m.content), ['What is Node.js?', 'Node.js is a runtime.', 'And Express?', 'A web framework.']);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(messages[0].timestamp, '2026-09-15T10:32:00.000Z', 'timestamps are stored as ISO 8601');

  const file = JSON.parse(await readFile(path.join(dir, 'conversation.json'), 'utf8'));
  assert.equal(file.messages.length, 4);
});

test('short-term memory drops the oldest messages beyond its maximum', async () => {
  const memory = new ShortTermMemory({ storage: new InMemoryStorage(), maxMessages: 4 });
  for (let i = 1; i <= 3; i += 1) await memory.append(user(`q${i}`), agent(`a${i}`));

  assert.deepEqual((await memory.getMessages()).map((m) => m.content), ['q2', 'a2', 'q3', 'a3']);
});

test('a trimmed window never starts with an answer whose question was dropped', async () => {
  const memory = new ShortTermMemory({ storage: new InMemoryStorage(), maxMessages: 3 });
  await memory.append(user('q1'), agent('a1'));
  await memory.append(user('q2'), agent('a2'));

  assert.deepEqual((await memory.getMessages()).map((m) => m.content), ['q2', 'a2']);
});

test('lowering the maximum trims the stored conversation immediately', async () => {
  const memory = new ShortTermMemory({ storage: new InMemoryStorage(), maxMessages: 20 });
  for (let i = 1; i <= 5; i += 1) await memory.append(user(`q${i}`), agent(`a${i}`));

  await memory.setMaxMessages(2);
  assert.deepEqual((await memory.getMessages()).map((m) => m.content), ['q5', 'a5']);
  assert.equal(memory.maxMessages, 2);
});

test('concurrent appends keep every question next to its answer', async () => {
  const memory = new ShortTermMemory({ storage: new InMemoryStorage(), maxMessages: 100 });
  await Promise.all(Array.from({ length: 10 }, (_, i) => memory.append(user(`q${i}`), agent(`a${i}`))));

  const messages = await memory.getMessages();
  assert.equal(messages.length, 20);
  for (let i = 0; i < messages.length; i += 2) {
    assert.equal(messages[i + 1].content, messages[i].content.replace('q', 'a'));
  }
});

test('clearing short-term memory empties the conversation', async () => {
  const memory = new ShortTermMemory({ storage: new InMemoryStorage() });
  await memory.append(user('hello'), agent('hi'));
  await memory.clear();
  assert.deepEqual(await memory.getMessages(), []);
});

test('malformed stored messages are dropped, not fatal', async () => {
  const storage = new InMemoryStorage();
  await storage.write('conversation', {
    messages: [
      { role: 'user', content: 'ok', timestamp: '2026-09-15T10:00:00Z' },
      { role: 'system', content: 'injected' },
      { role: 'assistant' },
      null,
    ],
  });
  const memory = new ShortTermMemory({ storage });
  const messages = await memory.getMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'ok');
  assert.ok(messages[0].id);
});
