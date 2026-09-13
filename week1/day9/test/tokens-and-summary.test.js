'use strict';

const assert = require('assert');

const test = require('./harness').test;
const T = require('../src/services/tokenService');
const summary = require('../src/services/summaryService');

test('tokenService.count estimates plausibly', () => {
  assert.strictEqual(T.count(''), 0);
  assert.strictEqual(T.count(null), 0);
  assert.strictEqual(T.count('What is Docker?'), 4);
  assert.ok(T.count('你好世界') === 4, 'CJK ~1 per character');
  const prose = 'Kubernetes is an open-source system for automating deployment, scaling, and management of containerized applications.';
  const n = T.count(prose);
  assert.ok(n > 15 && n < 30, 'prose estimate in a sane range, got ' + n);
});

test('countMessages prefers stored counts and flags estimates', () => {
  const exact = T.countMessages([
    { content: 'x', tokens: 40, tokensSource: 'api' },
    { content: 'y', tokens: 2, tokensSource: 'api' }
  ]);
  assert.deepStrictEqual(exact, { tokens: 42, estimated: false });

  const mixed = T.countMessages([
    { content: 'x', tokens: 40, tokensSource: 'api' },
    { content: 'What is Docker?', tokens: 4, tokensSource: 'estimate' }
  ]);
  assert.deepStrictEqual(mixed, { tokens: 44, estimated: true });

  assert.deepStrictEqual(T.countMessages([]), { tokens: 0, estimated: false });
  assert.deepStrictEqual(T.countMessages([{ content: 'What is Docker?' }]), { tokens: 4, estimated: true });
});

test('countSummary and labels', () => {
  assert.deepStrictEqual(T.countSummary({ summary: '', tokens: 0 }), { tokens: 0, estimated: false });
  assert.deepStrictEqual(T.countSummary({ summary: 'abc', tokens: 850, tokensSource: 'api' }), { tokens: 850, estimated: false });
  assert.strictEqual(T.label(1270, false), '1,270 tokens');
  assert.strictEqual(T.label(38, true), '~38 tokens (estimated)');
});

test('planSummary: the last 10 individual messages stay out of the summary', () => {
  assert.strictEqual(summary.planSummary(0, 0, 10), null);
  assert.strictEqual(summary.planSummary(10, 0, 10), null, 'exactly 10 messages: nothing to summarize');
  assert.deepStrictEqual(summary.planSummary(11, 0, 10), { from: 0, to: 1 });
  assert.deepStrictEqual(summary.planSummary(12, 0, 10), { from: 0, to: 2 });
  assert.strictEqual(summary.planSummary(12, 2, 10), null, 'already covered');
  assert.deepStrictEqual(summary.planSummary(14, 2, 10), { from: 2, to: 4 }, 'incremental: only the new leavers');
  assert.deepStrictEqual(summary.planSummary(40, 4, 10), { from: 4, to: 30 }, 'catch-up after failures');
});

test('contentTokens excludes reasoning tokens', () => {
  assert.strictEqual(summary.contentTokens({ output: 100, reasoning: 60 }), 40);
  assert.strictEqual(summary.contentTokens({ output: 42, reasoning: null }), 42);
  assert.strictEqual(summary.contentTokens({ output: null, reasoning: null }), null);
});

test('summary prompt carries the existing summary and only the new messages, numbered', () => {
  const service = new summary.SummaryService({ client: null, model: 'm', tokenService: T });
  const prompt = service.buildPrompt('## Facts\n- User project uses Node.js', [
    { role: 'user', content: 'Use port 3008', timestamp: '2026-09-13T16:00:00.000Z' },
    { role: 'assistant', content: 'Noted.', timestamp: '2026-09-13T16:00:02.000Z' }
  ], 20);
  assert.strictEqual(prompt[0].role, 'system');
  assert.ok(/memory module/.test(prompt[0].content));
  const user = prompt[1].content;
  assert.ok(user.indexOf('User project uses Node.js') !== -1);
  assert.ok(user.indexOf('covers messages #1–#20') !== -1);
  assert.ok(user.indexOf('[#21 user · 2026-09-13T16:00:00.000Z]\nUse port 3008') !== -1);
  assert.ok(user.indexOf('[#22 assistant') !== -1);
});

test('large backlogs are summarized in bounded batches', () => {
  const service = new summary.SummaryService({ client: null, model: 'm', tokenService: T });
  const messages = [];
  for (let i = 0; i < 95; i += 1) messages.push({ role: 'user', content: 'short', tokens: 1 });
  const batches = service.batches(messages, 0);
  assert.deepStrictEqual(batches.map((b) => b.messages.length), [40, 40, 15]);
  assert.deepStrictEqual(batches.map((b) => b.firstIndex), [0, 40, 80]);
});
