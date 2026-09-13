'use strict';

const assert = require('assert');
const test = require('./harness').test;
const h = require('./helpers');
const SlidingWindowManager = require('../src/agent/slidingWindow').SlidingWindowManager;

test('select(): 20 messages with N=5 keeps the latest 5 and excludes the other 15', function () {
  const path = h.range(20).map(function (i) { return { id: 'm' + i, content: String(i) }; });
  const sel = new SlidingWindowManager().select(path, 5);
  assert.deepStrictEqual(h.contents(sel.history), ['16', '17', '18', '19', '20']);
  assert.strictEqual(sel.excluded.length, 15);
  assert.strictEqual(path.length, 20, 'the input is not modified');
});

test('20 stored messages, N=5: DeepSeek gets only the latest 5, history keeps all 20', async function () {
  const t = await h.makeAgent();
  await h.askMany(t.agent, h.range(10).map(function (i) { return 'question ' + i; }));
  await t.agent.updateContext({ slidingWindow: { N: 5 } });

  const state = await t.agent.getState();
  assert.strictEqual(state.messages.length, 20, 'all 20 messages stay visible');
  assert.deepStrictEqual(state.context.historyIds, state.messages.slice(15).map(function (m) { return m.id; }));
  assert.deepStrictEqual(state.messages.slice(0, 15).map(function (m) { return m.contextStatus; }), new Array(15).fill('out'));
  assert.deepStrictEqual(state.messages.slice(15).map(function (m) { return m.contextStatus; }), new Array(5).fill('in'));

  await t.agent.ask('question 11');
  const call = t.client.answerCalls().pop();
  assert.deepStrictEqual(h.historyOf(call), h.contents(state.messages.slice(15)));
  assert.strictEqual(call.messages[0].role, 'system');
  assert.deepStrictEqual(call.messages[call.messages.length - 1], { role: 'user', content: 'question 11' });

  const disk = h.readJson(t.file);
  assert.strictEqual(disk.messages.length, 22, 'nothing was deleted from state.json');
  assert.strictEqual(disk.contextManagement.slidingWindow.N, 5);
});

test('changing N affects the very next request', async function () {
  const t = await h.makeAgent();
  await h.askMany(t.agent, ['a', 'b', 'c']);
  await t.agent.updateContext({ slidingWindow: { N: 2 } });
  await t.agent.ask('d');
  assert.deepStrictEqual(h.historyOf(t.client.answerCalls().pop()), ['c', 'answer to: c']);
  await t.agent.updateContext({ slidingWindow: { N: 3 } });
  await t.agent.ask('e');
  assert.deepStrictEqual(h.historyOf(t.client.answerCalls().pop()), ['answer to: c', 'd', 'answer to: d']);
});

test('invalid N values are rejected with 400 and change nothing', async function () {
  const t = await h.makeAgent();
  for (const bad of [0, -1, 501, 2.5, 'abc', null, '']) {
    await assert.rejects(t.agent.updateContext({ slidingWindow: { N: bad } }), function (err) {
      return err.status === 400 && /whole number from 1 to 500/.test(err.message);
    });
  }
  await assert.rejects(t.agent.updateContext({ mode: 'everything' }), function (err) { return err.status === 400; });
  await assert.rejects(t.agent.updateContext({ mode: 'sticky-facts', slidingWindow: { N: 0 } }), function (err) { return err.status === 400; });
  const disk = h.readJson(t.file);
  assert.strictEqual(disk.contextManagement.slidingWindow.N, 10);
  assert.strictEqual(disk.contextManagement.mode, 'sliding-window', 'a rejected patch applies no part of itself');
  await t.agent.updateContext({ slidingWindow: { N: '7' } });
  assert.strictEqual(h.readJson(t.file).contextManagement.slidingWindow.N, 7, 'numeric strings from a form are accepted');
});

test('each mode keeps its own settings when switching back and forth', async function () {
  const t = await h.makeAgent();
  await t.agent.updateContext({ slidingWindow: { N: 7 } });
  await t.agent.updateContext({ mode: 'sticky-facts', stickyFacts: { N: 3 } });
  await t.agent.updateContext({ mode: 'branching' });
  const out = await t.agent.updateContext({ mode: 'sliding-window' });
  assert.strictEqual(out.state.contextManagement.mode, 'sliding-window');
  assert.strictEqual(out.state.contextManagement.slidingWindow.N, 7);
  assert.strictEqual(out.state.contextManagement.stickyFacts.N, 3);
});

test('the context limit trims the oldest messages instead of failing', async function () {
  // Budget = (limit − output) × 0.85 ≈ 510 estimated tokens, the system prompt alone is ~220.
  const t = await h.makeAgent({ contextLimitTokens: 1000, maxOutputTokens: 400 });
  const long = new Array(60).fill('word').join(' '); // ~60 tokens per message
  await h.askMany(t.agent, h.range(6).map(function (i) { return long + ' ' + i; }));
  const state = await t.agent.getState();
  assert.ok(state.context.trimmedIds.length > 0, 'something was trimmed');
  assert.ok(state.context.estimatedTokens <= state.context.budgetTokens);
  assert.ok(state.messages.some(function (m) { return m.contextStatus === 'trimmed'; }));
  assert.strictEqual(state.messages.length, 12, 'trimmed messages stay in history');

  await assert.rejects(t.agent.ask(new Array(600).fill('word').join(' ')), function (err) { return err.status === 413; });
});
