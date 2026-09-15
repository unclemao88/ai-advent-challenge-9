import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../src/agent/agent.js';
import { MemoryManager } from '../src/agent/memoryManager.js';
import { DeepSeekError } from '../src/agent/deepseekClient.js';
import { countMessageTokens, countRequestTokens } from '../src/agent/tokenCounter.js';
import { DEFAULT_SETTINGS } from '../src/settings/settingsStore.js';
import { tempDataDir, fakeClient } from './helpers.js';

async function setup(t, { client = fakeClient(), settings } = {}) {
  const memory = new MemoryManager({ dataDir: await tempDataDir(t), settings });
  await memory.init();
  return { agent: new Agent({ client, memory, systemPrompt: 'You are a test agent.' }), memory, client };
}

test('the current context count is taken on the exact messages sent to DeepSeek', async (t) => {
  const { agent, memory, client } = await setup(t);
  await memory.work.applyUpdates([{ field: 'task', value: 'Build a Node.js DeepSeek agent with memory' }]);
  await memory.longTerm.applyUpdates([{ category: 'profile', key: 'name', value: 'Max' }]);
  await agent.ask('What is Node.js?');

  const question = 'Explain the Express middleware chain in detail, please.';
  const result = await agent.ask(question);
  const sent = client.calls.at(-1);

  assert.equal(result.tokenCounts.currentContext, countRequestTokens(sent), 'count == tokens(final API context)');
  assert.deepEqual(sent.at(-1), { role: 'user', content: question }, 'the question is part of what was counted');
  assert.ok(result.tokenCounts.currentContext > countMessageTokens({ role: 'user', content: question }) + 10,
    'far more than the question alone');

  // Every part of the payload is represented, and the parts add up to the total.
  const { breakdown } = result.tokenCounts;
  for (const part of ['system', 'longTerm', 'work', 'shortTerm', 'request']) assert.ok(breakdown[part] > 0, part);
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.tokenCounts.currentContext);
  assert.equal(result.tokenCounts.estimated, true);
});

test('a question changes the preview count; the preview matches what ask() then sends', async (t) => {
  const { agent, client } = await setup(t);
  const empty = await agent.prepareRequest('');
  const draft = await agent.prepareRequest('How do I create an Express server?');
  assert.ok(draft.tokenCounts.currentContext > empty.tokenCounts.currentContext);

  const result = await agent.ask('How do I create an Express server?');
  assert.equal(result.tokenCounts.currentContext, draft.tokenCounts.currentContext);
  assert.equal(countRequestTokens(client.calls[0]), draft.tokenCounts.currentContext);
});

test('a successful answer updates short-term, work and long-term memory', async (t) => {
  const { agent, memory } = await setup(t);
  const result = await agent.ask('task: Ship day 11\ndecision: Use Express\nmy name is Max');

  assert.equal(result.response, 'Fake answer.');
  assert.equal(result.request.role, 'user');
  assert.equal(result.reply.role, 'assistant');
  assert.ok(Date.parse(result.reply.timestamp));

  const all = await memory.loadAll();
  assert.deepEqual(all.shortTerm.map((m) => m.role), ['user', 'assistant']);
  assert.equal(all.work.task, 'Ship day 11');
  assert.deepEqual(all.work.decisions, ['Use Express']);
  assert.deepEqual(all.longTerm.profile, { name: 'Max' });

  assert.equal(result.memoryUpdates.work.length, 2);
  assert.equal(result.memoryUpdates.longTerm.length, 1);
  assert.ok(result.memoryTokenCounts.shortTerm > 0, 'post-update counts include the new exchange');
});

test('a failed DeepSeek call changes no memory at all', async (t) => {
  const client = fakeClient(() => {
    throw new DeepSeekError('network', 'Unable to connect to DeepSeek API.');
  });
  const { agent, memory } = await setup(t, { client });

  await assert.rejects(() => agent.ask('task: never saved'), { code: 'network' });
  const all = await memory.loadAll();
  assert.equal(all.shortTerm.length, 0);
  assert.equal(all.work.task, '');
});

test('disabled layers contribute nothing to the context', async (t) => {
  const settings = structuredClone(DEFAULT_SETTINGS.memory);
  const { agent, memory, client } = await setup(t, { settings });
  await agent.ask('task: Secret task');

  await memory.applySettings({ ...settings, work: { storage: 'disabled' }, shortTerm: { storage: 'disabled', maxMessages: 20 } });
  const result = await agent.ask('Hello again');

  assert.deepEqual(client.calls.at(-1).map((m) => m.role), ['system', 'user']);
  assert.ok(!client.calls.at(-1)[0].content.includes('Secret task'));
  assert.equal(result.tokenCounts.work, 0);
  assert.equal(result.tokenCounts.shortTerm, 0);
});

test('invalid questions are rejected before anything is sent', async (t) => {
  const { agent, client } = await setup(t);
  await assert.rejects(() => agent.ask('   '), { status: 400, code: 'empty_message' });
  await assert.rejects(() => agent.ask(42), { status: 400 });
  await assert.rejects(() => agent.ask('x'.repeat(8001)), { code: 'message_too_long' });
  assert.equal(client.calls.length, 0);
});
