'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const test = require('./harness').test;
const h = require('./helpers');
const storage = require('../src/storage/historyStore');

async function newStore(dir) {
  const store = new storage.HistoryStore({ dataDir: dir || h.tempDir(), logger: h.quietLogger });
  await store.init();
  return store;
}

test('init creates history.json and summary.json with the documented shape', async () => {
  const store = await newStore();
  const history = h.readJson(store.historyFile);
  const summary = h.readJson(store.summaryFile);
  assert.deepStrictEqual(history.messages, []);
  assert.strictEqual(summary.summary, '');
  assert.strictEqual(summary.messagesCovered, 0);
  assert.strictEqual(summary.tokens, 0);
});

test('messages persist across store instances, unchanged', async () => {
  const dir = h.tempDir();
  const store = await newStore(dir);
  const q = storage.createMessage('user', '  What is <b>Docker</b>?\n', { tokens: 5, tokensSource: 'estimate' });
  const a = storage.createMessage('assistant', 'Docker is…', { tokens: 42, tokensSource: 'api' });
  await store.appendMessage(q);
  await store.appendMessage(a);

  const reopened = await newStore(dir);
  const state = await reopened.getState();
  assert.strictEqual(state.messages.length, 2);
  assert.deepStrictEqual(state.messages[0], q);
  assert.strictEqual(state.messages[0].content, '  What is <b>Docker</b>?\n', 'content stored exactly');
  assert.strictEqual(state.messages[0].tag, 'you asked');
  assert.strictEqual(state.messages[1].tag, 'agent answered');
  assert.strictEqual(state.messages[1].tokens, 42);
  assert.ok(!isNaN(Date.parse(q.timestamp)) && q.timestamp === new Date(q.timestamp).toISOString(), 'ISO 8601');
});

test('100 concurrent appends: none lost, file valid, no temp files left', async () => {
  const store = await newStore();
  const writes = [];
  for (let i = 0; i < 100; i += 1) {
    writes.push(store.appendMessage(storage.createMessage(i % 2 ? 'assistant' : 'user', 'message ' + i)));
  }
  await Promise.all(writes);
  const history = h.readJson(store.historyFile);
  assert.strictEqual(history.messages.length, 100);
  assert.strictEqual(new Set(history.messages.map((m) => m.content)).size, 100);
  assert.deepStrictEqual(fs.readdirSync(store.dataDir).filter((f) => /\.tmp$/.test(f)), []);
});

test('corrupt history.json is quarantined, reported, and replaced', async () => {
  const dir = h.tempDir();
  fs.writeFileSync(path.join(dir, 'history.json'), '{"messages": [ {"id": "x", ');
  const store = await newStore(dir);
  assert.strictEqual((await store.getState()).messages.length, 0);
  assert.strictEqual(store.notices.length, 1);
  const backups = fs.readdirSync(dir).filter((f) => /^history\.corrupt-.*\.json$/.test(f));
  assert.strictEqual(backups.length, 1, 'the broken file is kept for inspection');
  assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{"messages": [ {"id": "x", ');
  assert.deepStrictEqual(h.readJson(path.join(dir, 'history.json')).messages, []);
});

test('empty files are treated as a new conversation', async () => {
  const dir = h.tempDir();
  fs.writeFileSync(path.join(dir, 'history.json'), '');
  fs.writeFileSync(path.join(dir, 'summary.json'), '   ');
  const store = await newStore(dir);
  const state = await store.getState();
  assert.strictEqual(state.messages.length, 0);
  assert.strictEqual(store.notices.length, 0);
});

test('entries this version cannot use are skipped but preserved in the file', async () => {
  const dir = h.tempDir();
  const good = storage.createMessage('user', 'hi');
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
    messages: [{ role: 'tool', content: 'future schema' }, good]
  }));
  const store = await newStore(dir);
  await store.appendMessage(storage.createMessage('assistant', 'hello'));
  assert.strictEqual((await store.getState()).messages.length, 2);
  const raw = h.readJson(store.historyFile).messages;
  assert.strictEqual(raw.length, 3);
  assert.strictEqual(raw[0].role, 'tool');
});

test('saveSummary records coverage; a summary out of line with history is ignored', async () => {
  const store = await newStore();
  const msgs = [];
  for (let i = 0; i < 4; i += 1) {
    msgs.push(storage.createMessage(i % 2 ? 'assistant' : 'user', 'm' + i));
    await store.appendMessage(msgs[i]);
  }
  const state = await store.saveSummary({ summary: 'S', tokens: 3, tokensSource: 'api', messagesCovered: 2 });
  assert.strictEqual(state.summary.messagesCovered, 2);
  const file = h.readJson(store.summaryFile);
  assert.strictEqual(file.coveredThroughId, msgs[1].id);
  assert.ok(file.updatedAt);

  await assert.rejects(store.saveSummary({ summary: 'S', tokens: 3, messagesCovered: 9 }), /only 4 exist/);

  // history.json replaced underneath the summary → the summary is not trusted.
  fs.writeFileSync(store.historyFile, JSON.stringify({ messages: [storage.createMessage('user', 'other')] }));
  const after = await store.getState();
  assert.strictEqual(after.summary.messagesCovered, 0);
  assert.strictEqual(after.summary.summary, '');
});

test('clear empties both files', async () => {
  const store = await newStore();
  await store.appendMessage(storage.createMessage('user', 'hi'));
  await store.saveSummary({ summary: 'S', tokens: 1, messagesCovered: 1 });
  const state = await store.clear();
  assert.strictEqual(state.messages.length, 0);
  assert.strictEqual(h.readJson(store.summaryFile).summary, '');
});
