import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, estimateCounter, fakeLlm } from './helpers.js';
import { ContextBuilder, HEADERS, SECTION_ORDER } from '../src/agent/contextBuilder.js';
import { TokenCounter } from '../src/token/tokenCounter.js';
import { ROOT_DIR } from '../src/config/index.js';

const task = { id: 'task-11111111-1111-4111-8111-111111111111', mode: 'manual' };
const base = {
  profile: null, invariants: [], shortTerm: [], work: null, longTerm: null, task, state: 'planning', userMessage: 'hi',
};

test('the context contains every section, in the specified order', () => {
  const builder = new ContextBuilder({ tokenCounter: estimateCounter() });
  const ctx = builder.build({
    ...base,
    profile: { style: 'terse', format: 'markdown', limitations: 'none' },
    invariants: [{ id: 'stack', name: 'Stack', value: 'Node.js', category: 'stack', enabled: true, forbidden: [] }],
    shortTerm: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
    work: { objective: 'Ship it', plan: ['a'], requirements: [], decisions: [], facts: [], intermediateResults: [], validationResults: [], variables: {} },
    longTerm: { solutions: [{ id: 'ltm_x1', content: 'Use nginx', tags: [] }], knowledge: [] },
    userMessage: 'current question',
  });
  const all = ctx.messages.map((m) => m.content).join('\n');
  const positions = SECTION_ORDER.filter((k) => k !== 'shortTerm').map((k) => all.indexOf(`${HEADERS[k]}\n`)); // The instructions mention the labels too.
  assert.ok(positions.every((p) => p >= 0), 'every header is present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in order');
  assert.equal(ctx.messages[1].content, 'earlier question');
  assert.match(ctx.messages.at(-1).content, /\[TASK STATE\][\s\S]*Current state: planning[\s\S]*\[CURRENT REQUEST\]\ncurrent question/);
});

test('the current context count includes profile, invariants, memories, task state and request', () => {
  const tc = estimateCounter();
  const builder = new ContextBuilder({ tokenCounter: tc });
  const total = (input) => builder.build({ ...base, ...input }).tokens.total;
  const empty = total({});

  const withProfile = total({ profile: { style: 'very detailed explanations with many examples', format: 'markdown', limitations: '' } });
  const withInvariants = total({ invariants: [{ id: 'a', name: 'Backend', value: 'Node.js and Express only', category: 'stack', enabled: true, forbidden: [] }] });
  const withShort = total({ shortTerm: [{ role: 'user', content: 'a previous question about deployment' }, { role: 'assistant', content: 'a previous answer' }] });
  const withWork = total({ work: { objective: 'Deploy the service on Debian with systemd', plan: [], requirements: [], decisions: [], facts: [], intermediateResults: [], validationResults: [], variables: {} } });
  const withLong = total({ longTerm: { solutions: [{ id: 'ltm_a', content: 'Use nginx as a reverse proxy in front of port 3014', tags: [] }], knowledge: [] } });
  const withState = total({ state: 'validation' });
  const withRequest = total({ userMessage: 'hi and a much longer question about everything under the sun' });

  for (const [name, value] of Object.entries({ withProfile, withInvariants, withShort, withWork, withLong, withState, withRequest })) {
    assert.ok(value > empty, `${name} (${value}) > empty (${empty})`);
  }
});

test('the displayed count is computed from exactly the messages that are sent', async (t) => {
  const { agent, llm, profiles, invariants } = await buildApp(t, { llm: fakeLlm() });
  await profiles.updateProfile({ style: 'terse' });
  await invariants.create({ name: 'Stack', value: 'Node.js' });

  const draft = 'How do I deploy?';
  const { context } = await agent.preview(draft);
  const summary = await agent.tokenSummary(draft);
  assert.equal(summary.currentContext, estimateCounter().countRequest(context.messages));
  assert.ok(summary.currentContext > summary.breakdown.request, 'not just the typed text');

  await agent.ask({ message: draft });
  const sent = llm.calls[0].messages;
  const normalize = (text) => text.replace(/task-[0-9a-f-]{36}/g, 'TASK');
  assert.equal(normalize(sent[0].content), normalize(context.messages[0].content), 'the previewed context is what was sent');

  const after = await agent.tokenSummary();
  assert.equal(after.apiInput, 111, 'DeepSeek-reported usage is shown as authoritative');
  assert.equal(after.apiOutput, 22);
  assert.equal(after.total, 133);
  assert.ok(after.shortTerm > 0 && after.work > 0 && after.longTerm > 0);
});

test('old chat turns are dropped first when the context exceeds its budget', () => {
  const builder = new ContextBuilder({ tokenCounter: estimateCounter(), maxContextTokens: 2000 });
  const turns = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(20) }));
  const ctx = builder.build({ ...base, shortTerm: turns });
  assert.ok(ctx.droppedTurns > 0);
  assert.ok(ctx.sections.turns.length > 0, 'the newest turns are kept');
  assert.ok(ctx.tokens.total <= 2000 || ctx.sections.turns.length === 0);
  assert.equal(ctx.sections.turns[0].role, 'user');
  assert.match(ctx.messages[0].content, /\[SYSTEM INSTRUCTIONS\]/, 'instructions are never cut');
});

test('the DeepSeek tokenizer, when installed, counts exactly; otherwise counts are labelled estimates', async () => {
  const estimate = new TokenCounter();
  assert.equal(estimate.info.exact, false);
  assert.ok(estimate.countText('hello world') > 0);

  const counter = await TokenCounter.create({ directory: `${ROOT_DIR}/vendor/deepseek-tokenizer`, model: 'deepseek-chat' });
  if (!counter.info.exact) return; // Tokenizer not downloaded in this checkout.
  assert.equal(counter.countText('Hello, world!'), 4);
  assert.ok(counter.countRequest([{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }]) >= 4);
});
