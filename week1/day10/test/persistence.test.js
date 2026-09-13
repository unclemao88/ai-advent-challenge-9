'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('./harness').test;
const h = require('./helpers');
const StateStore = require('../src/storage/stateStore').StateStore;
const schema = require('../src/storage/schema');

test('save → restart → load preserves messages, settings, mode, N, facts, branches, checkpoint and statistics', async function () {
  const t = await h.makeAgent();
  await t.agent.updateContext({ mode: 'sticky-facts', stickyFacts: { N: 2 } });
  await h.askMany(t.agent, ['user_name=John', 'b', 'c']);
  await t.agent.updateContext({ slidingWindow: { N: 7 } });
  await t.agent.updateContext({ mode: 'branching' });
  const ids = (await t.agent.createCheckpoint()).result.branchIds;
  await t.agent.ask('in A');
  await t.agent.switchBranch(ids[1]);
  const before = await t.agent.getState();

  const restarted = await h.makeAgent({ dir: t.dir });
  const after = await restarted.agent.getState();
  assert.deepStrictEqual(after, before);

  assert.strictEqual(after.contextManagement.mode, 'branching');
  assert.strictEqual(after.contextManagement.slidingWindow.N, 7);
  assert.strictEqual(after.contextManagement.stickyFacts.N, 2);
  assert.strictEqual(after.contextManagement.branching.activeBranchId, ids[1]);
  assert.deepStrictEqual(after.contextManagement.branching.checkpoint.branchIds, ids);
  assert.strictEqual(after.history.storedMessages, 8);
  assert.strictEqual(after.messages.length, 6, 'Branch B shows the base only');
  assert.strictEqual(after.statistics.responseCount, 4);
  assert.strictEqual(after.statistics.api.answerCalls, 4);
  assert.ok(after.statistics.totalTokens > 0);
  assert.strictEqual(after.lastTurn.requestTokensSource, 'estimate');
  assert.strictEqual(after.lastTurn.responseTokensSource, 'api');

  await restarted.agent.updateContext({ mode: 'sticky-facts' });
  assert.deepStrictEqual(h.factsObject(await restarted.agent.getState()), { user_name: 'John' });
});

test('messages follow the documented data model', async function () {
  const t = await h.makeAgent();
  const result = await t.agent.ask('What is Docker?');
  const stored = h.readJson(t.file).messages;
  assert.deepStrictEqual(stored[0], result.request);
  assert.deepStrictEqual(stored[1], result.response);
  const req = stored[0];
  const res = stored[1];
  assert.ok(typeof req.id === 'string' && req.id !== res.id);
  assert.ok(!isNaN(Date.parse(req.timestamp)));
  assert.strictEqual(req.type, 'request');
  assert.strictEqual(req.branchId, 'main');
  assert.strictEqual(req.tokensSource, 'estimate');
  assert.strictEqual(res.type, 'response');
  assert.strictEqual(res.tokens, 7, 'response tokens come from DeepSeek usage.completion_tokens');
  assert.strictEqual(res.tokensSource, 'api');
  assert.strictEqual(res.replyTo, req.id);
  assert.strictEqual(result.turn.contextTokens, 100 + 2, 'context tokens come from usage.prompt_tokens');
});

test('a failed DeepSeek call stores nothing', async function () {
  const t = await h.makeAgent();
  await t.agent.ask('first');
  const before = fs.readFileSync(t.file, 'utf8');
  t.client.failAnswers = 1;
  await assert.rejects(t.agent.ask('second'), function (err) { return err.status === 502; });
  assert.strictEqual(fs.readFileSync(t.file, 'utf8'), before);
});

test('empty and oversized questions are rejected', async function () {
  const t = await h.makeAgent({ maxQuestionChars: 20 });
  for (const bad of ['', '   \n ', null, 42]) {
    await assert.rejects(t.agent.ask(bad), function (err) { return err.status === 400; });
  }
  await assert.rejects(t.agent.ask('x'.repeat(21)), function (err) { return err.status === 413; });
  assert.strictEqual(t.client.calls.length, 0);
});

test('concurrent asks are serialized and every pair is stored in order', async function () {
  const t = await h.makeAgent();
  await Promise.all([t.agent.ask('q1'), t.agent.ask('q2'), t.agent.ask('q3')]);
  const messages = h.readJson(t.file).messages;
  assert.deepStrictEqual(h.contents(messages), ['q1', 'answer to: q1', 'q2', 'answer to: q2', 'q3', 'answer to: q3']);
  assert.deepStrictEqual(h.historyOf(t.client.answerCalls()[2]), ['q1', 'answer to: q1', 'q2', 'answer to: q2']);
});

test('concurrent store updates never lose writes and leave no temp files', async function () {
  const dir = h.tempDir();
  const store = new StateStore({ dataDir: dir, logger: h.quietLogger });
  await store.init();
  await Promise.all(h.range(25).map(function (i) {
    return store.update(function (state) {
      state.messages.push(schema.createMessage({ type: 'request', content: 'm' + i, branchId: 'main' }));
    });
  }));
  const disk = h.readJson(store.file);
  assert.strictEqual(disk.messages.length, 25);
  assert.strictEqual(disk.statistics.requestCount, 25);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(function (f) { return /\.tmp$/.test(f); }), []);
});

test('corrupted state.json is quarantined, never overwritten', async function () {
  const dir = h.tempDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"messages": [ {"id": "trunc');
  const t = await h.makeAgent({ dir: dir });
  const state = await t.agent.getState();
  assert.strictEqual(state.messages.length, 0);
  assert.ok(state.notices.some(function (n) { return /not valid JSON/.test(n); }));
  const backup = fs.readdirSync(dir).filter(function (f) { return /^state\.corrupt-.*\.json$/.test(f); });
  assert.strictEqual(backup.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, backup[0]), 'utf8'), '{"messages": [ {"id": "trunc');
});

test('invalid parts of state.json are repaired and the original is kept', async function () {
  const dir = h.tempDir();
  const good = schema.createMessage({ type: 'request', content: 'kept', branchId: 'main' });
  const orphan = schema.createMessage({ type: 'request', content: 'orphan', branchId: 'branch-gone' });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    messages: [good, { id: 'bad' }, orphan],
    contextManagement: {
      mode: 'weird',
      slidingWindow: { N: -3 },
      stickyFacts: { N: 4, facts: { user_name: 'John', 'Bad Key': 'x' } },
      branching: { checkpoint: { id: 'cp', branchIds: ['branch-gone'] }, activeBranchId: 'branch-gone', branches: [] }
    }
  }));
  const t = await h.makeAgent({ dir: dir });
  const state = await t.agent.getState();
  assert.deepStrictEqual(h.contents(state.messages), ['kept']);
  assert.strictEqual(state.contextManagement.mode, 'sliding-window');
  assert.strictEqual(state.contextManagement.slidingWindow.N, schema.DEFAULT_SLIDING_N);
  assert.strictEqual(state.contextManagement.stickyFacts.N, 4);
  assert.strictEqual(state.contextManagement.branching.checkpoint, null);
  assert.ok(state.notices.length >= 3);

  const disk = h.readJson(t.file);
  assert.strictEqual(disk.quarantinedMessages.length, 2, 'unusable messages are kept, not dropped');
  assert.strictEqual(disk.contextManagement.stickyFacts.memories.main.facts.user_name.value, 'John');
  assert.strictEqual(fs.readdirSync(dir).filter(function (f) { return /pre-repair/.test(f); }).length, 1);
});
