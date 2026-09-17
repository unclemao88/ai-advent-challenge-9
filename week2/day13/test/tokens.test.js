import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { ROOT_DIR } from '../src/config.js';
import { ContextBuilder, HEADERS } from '../src/agent/ContextBuilder.js';
import { SYSTEM_INSTRUCTIONS } from '../src/agent/prompts.js';
import { TokenCounter, estimateTextTokens, renderChatTemplate } from '../src/tokens/TokenCounter.js';
import { createTask } from '../src/state-machine/StateMachine.js';
import { emptyWorkMemory } from '../src/memory/WorkMemory.js';
import { logger } from './helpers.js';

const TOKENIZER_DIR = path.join(ROOT_DIR, 'vendor', 'deepseek-tokenizer');
const hasTokenizer = existsSync(path.join(TOKENIZER_DIR, 'tokenizer.json'));
const ID = '44444444-4444-4444-8444-444444444444';

function input(overrides = {}) {
  const task = createTask({ taskId: ID, title: 't', mode: 'manual' });
  return {
    profile: { style: 'terse and technical', format: 'bullet points', limitations: 'max 100 words' },
    longTerm: {
      profile: [{ id: 'a', category: 'profile', content: 'Runs Debian 12', tags: [] }],
      solutions: [{ id: 'b', category: 'solutions', content: 'Use journalctl -u app to read logs', tags: ['systemd'] }],
      knowledge: [],
    },
    work: { ...emptyWorkMemory(ID), objective: 'Deploy the agent', requirements: ['Port 3013'] },
    shortTerm: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }],
    task,
    state: 'planning',
    userMessage: 'How do I install it?',
    ...overrides,
  };
}

test('the chat template matches DeepSeek-V3.1/V3.2 (non-thinking)', () => {
  const rendered = renderChatTemplate([
    { role: 'system', content: 'S1' }, { role: 'system', content: 'S2' },
    { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' },
  ]);
  assert.equal(rendered,
    '<｜begin▁of▁sentence｜>S1\n\nS2<｜User｜>Q1<｜Assistant｜></think>A1<｜end▁of▁sentence｜><｜User｜>Q2<｜Assistant｜></think>');
  assert.ok(renderChatTemplate([{ role: 'user', content: 'x' }], { thinking: true }).endsWith('<｜Assistant｜><think>'));
});

test('the context is built in the required order with every section', () => {
  const builder = new ContextBuilder({ tokenCounter: new TokenCounter() });
  const { messages, sections } = builder.build(input());

  assert.equal(messages[0].role, 'system');
  const system = messages[0].content;
  assert.ok(system.startsWith(`${HEADERS.system}\n`));
  // Each section starts on its own line after a blank line (the instructions mention headers only in prose).
  const order = [HEADERS.profile, HEADERS.longTerm, HEADERS.work, HEADERS.shortTerm]
    .map((header) => system.indexOf(`\n\n${header}`));
  assert.ok(order.every((pos) => pos > 0), 'every header is present');
  assert.equal(system.split('\n').filter((line) => line === HEADERS.profile).length, 1, 'the profile section appears once');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'headers are in order');
  assert.ok(system.includes(SYSTEM_INSTRUCTIONS));
  assert.ok(system.includes('Style: terse and technical'));
  assert.ok(system.includes('Format: bullet points'));
  assert.ok(system.includes('Limitations: max 100 words'));
  assert.ok(system.includes('Runs Debian 12'));
  assert.ok(system.includes('Objective: Deploy the agent'));
  assert.ok(system.includes(`Task ID: ${ID}`));

  assert.deepEqual(messages.slice(1, 3), [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]);
  const request = messages.at(-1);
  assert.equal(request.role, 'user');
  assert.ok(request.content.startsWith(HEADERS.request));
  assert.ok(request.content.includes('Current state: planning'));
  assert.ok(request.content.includes('How do I install it?'));
  assert.equal(sections.turns.length, 2);
});

test('a missing profile leaves an empty section instead of failing', () => {
  const builder = new ContextBuilder({ tokenCounter: new TokenCounter() });
  for (const profile of [null, undefined, { style: '', format: '', limitations: '' }]) {
    const { messages, tokens } = builder.build(input({ profile }));
    assert.ok(messages[0].content.includes(`${HEADERS.profile}\n\n${HEADERS.longTerm}`));
    assert.ok(tokens.profile > 0 && tokens.profile < 10, 'only the header is counted');
  }
});

test('continue requests say that there is no new user message', () => {
  const builder = new ContextBuilder({ tokenCounter: new TokenCounter() });
  const { messages } = builder.build(input({ userMessage: null, state: 'execution' }));
  assert.match(messages.at(-1).content, /User message:\n\(none: the user pressed "continue"\)/);
  assert.match(messages.at(-1).content, /Current state: execution/);
});

for (const kind of ['estimate', 'exact']) {
  test(`the current-request count includes every part of the context (${kind})`, { skip: kind === 'exact' && !hasTokenizer && 'tokenizer not installed' }, async () => {
    const counter = kind === 'exact' ? await TokenCounter.create({ directory: TOKENIZER_DIR, logger: logger() }) : new TokenCounter();
    assert.equal(counter.info.exact, kind === 'exact');
    const builder = new ContextBuilder({ tokenCounter: counter });
    const full = builder.build(input());

    // The total is exactly the rendered payload.
    assert.equal(full.tokens.total, counter.countRequest(full.messages));

    // Removing any one part lowers the total by at least that part's size (minus template noise).
    const without = {
      profile: builder.build(input({ profile: null })),
      longTerm: builder.build(input({ longTerm: null })),
      work: builder.build(input({ work: null })),
      shortTerm: builder.build(input({ shortTerm: [] })),
      request: builder.build(input({ userMessage: 'Hi' })), // shorter than the default question
    };
    for (const [part, ctx] of Object.entries(without)) {
      assert.ok(ctx.tokens.total < full.tokens.total, `${part} is counted in the total`);
    }
    const sum = ['system', 'profile', 'longTerm', 'work', 'shortTerm', 'request'].reduce((n, k) => n + full.tokens[k], 0);
    assert.ok(Math.abs(full.tokens.total - sum) <= 12, `sum of parts ${sum} ≈ total ${full.tokens.total}`);
    // The system instructions alone are hundreds of tokens: the count is not just the typed text.
    assert.ok(full.tokens.total > counter.countText('How do I install it?') + 300);
  });
}

test('exact tokenizer reproduces known DeepSeek token counts', { skip: !hasTokenizer && 'tokenizer not installed' }, async () => {
  const counter = await TokenCounter.create({ directory: TOKENIZER_DIR, logger: logger() });
  assert.equal(counter.info.method, 'exact');
  assert.equal(counter.countText('Hello World'), 2);
  // bos + "You are helpful." (4) + <｜User｜> + "hi" + <｜Assistant｜> + </think>
  assert.equal(counter.countRequest([{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }]), 9);
});

test('a missing tokenizer falls back to a labelled estimate', async () => {
  const log = logger();
  const counter = await TokenCounter.create({ directory: '/nonexistent/tokenizer', logger: log });
  assert.equal(counter.info.method, 'estimate');
  assert.equal(counter.info.exact, false);
  assert.match(counter.info.note, /estimate/i);
  assert.ok(log.entries.some((e) => e.event === 'tokens.tokenizer_unavailable'));
});

test('a tokenizer that throws degrades to the estimate instead of failing requests', () => {
  const broken = { encode: () => { throw new Error('boom'); } };
  const counter = new TokenCounter({ tokenizer: broken });
  assert.equal(counter.info.exact, true);
  const n = counter.countText('some words here');
  assert.equal(n, estimateTextTokens('some words here'));
  assert.equal(counter.info.exact, false);
  assert.match(counter.info.note, /failed/);
});

test('the estimate is reasonable for common text', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('hello'), 1);
  assert.ok(estimateTextTokens('The quick brown fox jumps over the lazy dog.') >= 9);
  assert.equal(estimateTextTokens('你好世界'), 4);
  assert.ok(estimateTextTokens('1234567890') >= 3);
});

test('old turns are dropped (oldest first) when the context exceeds its budget', () => {
  const counter = new TokenCounter();
  const turns = [];
  for (let i = 0; i < 40; i += 1) {
    turns.push({ role: 'user', content: `question ${i} ${'word '.repeat(40)}` });
    turns.push({ role: 'assistant', content: `answer ${i} ${'word '.repeat(40)}` });
  }
  const builder = new ContextBuilder({ tokenCounter: counter, maxContextTokens: 2500 });
  const { tokens, droppedTurns, sections, messages } = builder.build(input({ shortTerm: turns }));
  assert.ok(droppedTurns > 0);
  assert.ok(tokens.total <= 2500, `total ${tokens.total}`);
  assert.equal(sections.turns[0].role, 'user', 'the replay starts with a user turn');
  assert.ok(messages.at(-2).content.startsWith('answer 39'), 'the newest turns are kept');
});
