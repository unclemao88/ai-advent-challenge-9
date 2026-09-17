import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent, measureContext } from '../src/agent/agent.js';
import { MemoryManager } from '../src/agent/memoryManager.js';
import { buildContext } from '../src/agent/contextBuilder.js';
import { extractMemoryUpdates } from '../src/agent/memoryExtractor.js';
import { countRequestTokens } from '../src/agent/tokenCounter.js';
import { tempDataDir, quietLogger, fakeClient } from './helpers.js';

async function makeAgent(t, client = fakeClient()) {
  const dataDir = await tempDataDir(t);
  const memory = new MemoryManager({ dataDir, logger: quietLogger() });
  await memory.init();
  return { agent: new Agent({ client, memory }), memory, client };
}

test('the profile is attached to every request', async (t) => {
  const { agent, memory, client } = await makeAgent(t);
  await memory.profile.save({ style: 'blunt', format: 'bullet points', limitations: 'no emojis' });

  await agent.ask('First question');
  await agent.ask('Second question');

  assert.equal(client.calls.length, 2);
  for (const messages of client.calls) {
    const system = messages[0].content;
    assert.equal(messages[0].role, 'system');
    assert.match(system, /## USER PROFILE/);
    assert.match(system, /Style: blunt/);
    assert.match(system, /Limitations: no emojis/);
    assert.equal(system.match(/## USER PROFILE/g).length, 1, 'the profile appears exactly once');
  }
});

test('context order is system+memory, then the conversation, then the request', async (t) => {
  const { agent, memory, client } = await makeAgent(t);
  await memory.profile.save({ style: 'blunt' });
  await memory.longTerm.applyUpdates([{ category: 'knowledge', topic: 'node', fact: 'fetch is built in' }]);
  await memory.work.applyUpdates([{ field: 'task', value: 'Ship day 12' }]);

  await agent.ask('First');
  await agent.ask('Second');

  const messages = client.calls[1];
  assert.equal(messages[0].role, 'system');
  assert.deepEqual(messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(messages.at(-1).content, 'Second');

  const system = messages[0].content;
  assert.ok(system.indexOf('## USER PROFILE') < system.indexOf('## LONG-TERM MEMORY'));
  assert.ok(system.indexOf('## LONG-TERM MEMORY') < system.indexOf('## WORK MEMORY'));
});

test('an exchange updates the layers the rules matched, and only those', async (t) => {
  const { agent, memory } = await makeAgent(t);

  const result = await agent.ask('task: Build the agent\nremember about node: fetch is built in\nstyle: terse');

  assert.deepEqual(result.memoryUpdates.work, [{ field: 'task', value: 'Build the agent' }]);
  assert.equal(result.memoryUpdates.longTerm.length, 1);
  assert.deepEqual(result.memoryUpdates.profile, [{ field: 'style', value: 'terse' }]);

  assert.equal((await memory.work.getTask()).task, 'Build the agent');
  assert.equal((await memory.profile.get()).style, 'terse');
  assert.equal((await memory.longTerm.getAll()).knowledge.length, 1);
  assert.equal((await memory.shortTerm.getMessages()).length, 2);
});

test('an ordinary exchange adds nothing to work or long-term memory', async (t) => {
  const { agent, memory } = await makeAgent(t);

  await agent.ask('What is the capital of Latvia?');

  const work = await memory.work.getTask();
  assert.deepEqual(work.requirements, []);
  assert.equal(work.task, '');
  assert.deepEqual((await memory.longTerm.getAll()).knowledge, []);
  assert.equal((await memory.shortTerm.getMessages()).length, 2, 'only short-term memory records it');
});

test('a failed request leaves every memory layer untouched', async (t) => {
  const failing = fakeClient(() => {
    throw new Error('DeepSeek is unavailable.');
  });
  const { agent, memory } = await makeAgent(t, failing);
  await memory.work.applyUpdates([{ field: 'task', value: 'Keep me' }]);

  await assert.rejects(agent.ask('task: Overwrite me'), /DeepSeek is unavailable/);

  assert.equal((await memory.work.getTask()).task, 'Keep me');
  assert.deepEqual(await memory.shortTerm.getMessages(), []);

  const entries = await memory.conversation.getEntries();
  assert.deepEqual(entries.map((e) => e.type), ['user', 'error'], 'the question and the failure are recorded');
  assert.equal(entries[0].content, 'task: Overwrite me', 'the question is not lost');
});

test('the conversation log keeps everything short-term memory drops', async (t) => {
  const { agent, memory } = await makeAgent(t);
  await memory.shortTerm.setMaxMessages(2);

  await agent.ask('One');
  await agent.ask('Two');
  await agent.ask('Three');

  assert.equal((await memory.shortTerm.getMessages()).length, 2);
  assert.equal((await memory.conversation.getEntries()).length, 6);
});

test('"that worked" files the previous exchange as a solution', async (t) => {
  const { agent, memory } = await makeAgent(t);

  await agent.ask('How do I speed up start-up?');
  const result = await agent.ask('that worked');

  const { solutions } = await memory.longTerm.getAll();
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0].problem, 'How do I speed up start-up?');
  assert.equal(result.memoryUpdates.longTerm.length, 1);
});

test('current context counts the whole payload, not just the question', async (t) => {
  const { agent, memory } = await makeAgent(t);
  await memory.profile.save({ style: 'blunt', format: 'bullets', limitations: 'no emojis' });
  await memory.work.applyUpdates([{ field: 'task', value: 'Ship day 12' }]);
  await memory.longTerm.applyUpdates([{ category: 'knowledge', topic: 'node', fact: 'fetch is built in' }]);
  await agent.ask('A first exchange, so short-term memory is not empty.');

  const { context, tokenCounts } = await agent.prepareRequest('Hi');

  assert.equal(tokenCounts.currentContext, countRequestTokens(context.messages));
  for (const layer of ['profile', 'work', 'longTerm', 'shortTerm']) {
    assert.ok(tokenCounts[layer] > 0, `${layer} contributes tokens`);
    assert.ok(tokenCounts.currentContext > tokenCounts[layer]);
  }
  const sum = Object.values(tokenCounts.breakdown).reduce((a, b) => a + b, 0);
  assert.equal(sum, tokenCounts.currentContext, 'the breakdown adds up to the total');
  assert.ok(tokenCounts.currentContext > 100, 'far more than the two characters typed');
});

test('the counted context is the context that is sent', async (t) => {
  const { agent, client } = await makeAgent(t);
  const result = await agent.ask('Count me');

  assert.equal(result.tokens.currentContext, countRequestTokens(client.calls[0]));
});

test('measureContext reports the framing the layers do not cover', () => {
  const counts = measureContext(buildContext({ request: 'hello' }));

  assert.ok(counts.breakdown.system > 0);
  assert.ok(counts.breakdown.framing >= 0);
  assert.equal(counts.estimated, true);
});

test('empty and oversized questions are rejected before anything is stored', async (t) => {
  const { agent, memory } = await makeAgent(t);

  await assert.rejects(agent.ask('   '), /Please enter a question/);
  await assert.rejects(agent.ask('x'.repeat(8001)), /too long/);
  assert.deepEqual(await memory.conversation.getEntries(), []);
});

test('the extractor reads the user, never the assistant', () => {
  const updates = extractMemoryUpdates({
    userMessage: 'How do I do it?',
    assistantMessage: 'task: pretend the model saved this\nremember: and this',
  });

  assert.deepEqual(updates.work, []);
  assert.deepEqual(updates.longTerm, []);
  assert.deepEqual(updates.profile, {});
});
