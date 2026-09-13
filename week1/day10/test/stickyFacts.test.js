'use strict';

const assert = require('assert');
const test = require('./harness').test;
const h = require('./helpers');
const sticky = require('../src/agent/stickyFacts');

async function stickyAgent(N, options) {
  const t = await h.makeAgent(options);
  await t.agent.updateContext({ mode: 'sticky-facts', stickyFacts: { N: N } });
  return t;
}

test('context = persistent facts + latest N messages; older messages are represented by facts', async function () {
  const t = await stickyAgent(4);
  await h.askMany(t.agent, ['user_name=John', 'project=Monitoring', 'what is docker', 'explain networking']);

  const state = await t.agent.getState();
  assert.deepStrictEqual(h.factsObject(state), { project: 'Monitoring', user_name: 'John' });
  assert.strictEqual(state.contextManagement.stickyFacts.messagesCovered, 4);
  assert.deepStrictEqual(state.context.historyIds, state.messages.slice(4).map(function (m) { return m.id; }), 'latest 4 retained');
  assert.deepStrictEqual(state.messages.map(function (m) { return m.contextStatus; }),
    ['facts', 'facts', 'facts', 'facts', 'in', 'in', 'in', 'in']);

  await t.agent.ask('who am I?');
  const call = t.client.answerCalls().pop();
  const system = call.messages[0].content;
  assert.ok(/=== PERSISTENT FACTS ===\nproject = Monitoring\nuser_name = John\n=== END OF PERSISTENT FACTS ===/.test(system), system);
  assert.ok(/=== RECENT CONVERSATION ===/.test(system));
  assert.deepStrictEqual(h.historyOf(call), h.contents(state.messages.slice(4)));
  assert.ok(!h.historyOf(call).some(function (c) { return /user_name=John/.test(c); }), 'the old message itself is not sent');
});

test('facts are extracted incrementally, only from messages that left the window', async function () {
  const t = await stickyAgent(4);
  await h.askMany(t.agent, ['one=1', 'two=2']);
  assert.strictEqual(t.client.factCalls().length, 0, 'nothing is outside the window yet');
  await t.agent.ask('three=3');
  const calls = t.client.factCalls();
  assert.strictEqual(calls.length, 1);
  assert.ok(/#1–#2/.test(calls[0].messages[1].content), 'only messages 1-2 are folded');
  assert.strictEqual(calls[0].responseFormat, 'json_object');
});

test('facts are persisted in state.json and survive a restart', async function () {
  const t = await stickyAgent(2);
  await h.askMany(t.agent, ['user_name=John', 'server_os=Ubuntu', 'hi']);
  const disk = h.readJson(t.file);
  const facts = disk.contextManagement.stickyFacts.memories.main.facts;
  assert.strictEqual(facts.user_name.value, 'John');
  assert.strictEqual(facts.server_os.value, 'Ubuntu');
  assert.ok(facts.user_name.updatedAt && facts.user_name.createdAt, 'facts carry timestamps');

  const restarted = await h.makeAgent({ dir: t.dir });
  const state = await restarted.agent.getState();
  assert.deepStrictEqual(h.factsObject(state), { server_os: 'Ubuntu', user_name: 'John' });
  await restarted.agent.ask('and now?');
  assert.ok(/user_name = John/.test(restarted.client.answerCalls().pop().messages[0].content));
});

test('newer information updates an existing fact instead of keeping both', async function () {
  const t = await stickyAgent(2);
  await h.askMany(t.agent, ['user_name=John', 'filler']);
  let state = await t.agent.getState();
  assert.strictEqual(h.factsObject(state).user_name, 'John');
  const firstUpdate = state.contextManagement.stickyFacts.facts[0].updatedAt;

  await new Promise(function (r) { setTimeout(r, 5); });
  await h.askMany(t.agent, ['user_name=Mike', 'filler again']);
  state = await t.agent.getState();
  assert.deepStrictEqual(h.factsObject(state), { user_name: 'Mike' });
  const fact = state.contextManagement.stickyFacts.facts[0];
  assert.notStrictEqual(fact.updatedAt, firstUpdate);
  assert.ok(fact.createdAt <= firstUpdate, 'createdAt is kept');
});

test('failed extraction keeps the previous facts, reports it, and sends the uncovered messages in full', async function () {
  const t = await stickyAgent(2);
  await h.askMany(t.agent, ['user_name=John', 'filler']);
  t.client.factsMode = 'invalid-json';

  const result = await t.agent.ask('project=Gateway');
  assert.ok(result.warnings.some(function (w) { return /not fully updated/.test(w); }));
  let state = result.state;
  assert.deepStrictEqual(h.factsObject(state), { user_name: 'John' }, 'previous facts preserved');
  assert.ok(/valid JSON/.test(state.contextManagement.stickyFacts.lastError.message));
  assert.strictEqual(state.context.uncoveredIncluded, 2, 'messages not yet in facts stay in context');
  assert.strictEqual(state.context.historyIds.length, 4);

  t.client.factsMode = 'throw';
  await t.agent.ask('still broken');
  assert.deepStrictEqual(h.factsObject(await t.agent.getState()), { user_name: 'John' });

  t.client.factsMode = 'ok';
  await t.agent.ask('recovered');
  state = await t.agent.getState();
  assert.deepStrictEqual(h.factsObject(state), { project: 'Gateway', user_name: 'John' });
  assert.strictEqual(state.contextManagement.stickyFacts.lastError, null);
  assert.strictEqual(state.context.uncoveredIncluded, 0);
  assert.strictEqual(state.context.historyIds.length, 2);
});

test('switching into sticky facts after a long conversation catches up before answering', async function () {
  const t = await h.makeAgent();
  await h.askMany(t.agent, ['user_name=John', 'b', 'c', 'd', 'e']);
  await t.agent.updateContext({ mode: 'sticky-facts', stickyFacts: { N: 2 } });
  await t.agent.ask('who am I?');
  const answer = t.client.answerCalls().pop();
  assert.ok(/user_name = John/.test(answer.messages[0].content), 'facts were extracted before the answer');
  assert.strictEqual(h.historyOf(answer).length, 2);
});

test('parseExtraction validates and normalizes model output', function () {
  assert.deepStrictEqual(sticky.parseExtraction('```json\n{"factsToSet": {"Preferred Language": "Russian", "Project-Name": "AI Gateway"}}\n```'),
    { set: { preferred_language: 'Russian', project_name: 'AI Gateway' }, remove: [] });
  assert.deepStrictEqual(sticky.parseExtraction('{"factsToSet": {"ok": 42, "nested": {"x": 1}, "list": ["a", "b"], "gone": null}, "factsToUpdate": {"x": true}, "factsToRemove": ["Old Key", 5]}'),
    { set: { ok: '42', list: 'a, b', x: 'true' }, remove: ['gone', 'old_key'] });
  assert.throws(function () { sticky.parseExtraction('user_name is John'); }, /valid JSON/);
  assert.throws(function () { sticky.parseExtraction('[1, 2]'); }, /JSON object/);
  assert.throws(function () { sticky.parseExtraction('{"facts": {}}'); }, /none of/);
  assert.throws(function () { sticky.parseExtraction('{"factsToSet": "x"}'); }, /must be an object/);
  assert.throws(function () { sticky.parseExtraction('{"factsToRemove": "x"}'); }, /must be an array/);
});

test('applyUpdate: newer value wins, removals apply, input is not mutated', function () {
  const then = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-02-01T00:00:00Z');
  const facts = {
    user_name: { value: 'John', createdAt: then.toISOString(), updatedAt: then.toISOString() },
    old_os: { value: 'Debian 11', createdAt: then.toISOString(), updatedAt: then.toISOString() }
  };
  const result = sticky.applyUpdate(facts, { set: { user_name: 'Mike', language: 'JS' }, remove: ['old_os'] }, now);
  assert.deepStrictEqual(result.facts.user_name, { value: 'Mike', createdAt: then.toISOString(), updatedAt: now.toISOString() });
  assert.strictEqual(result.facts.language.value, 'JS');
  assert.strictEqual(result.facts.old_os, undefined);
  assert.deepStrictEqual(result.changed, { set: ['user_name', 'language'], removed: ['old_os'] });
  assert.strictEqual(facts.user_name.value, 'John');
});
