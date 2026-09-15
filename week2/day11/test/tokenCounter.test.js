import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countMessageTokens, countRequestTokens, countTextTokens, TOKENIZER } from '../src/agent/tokenCounter.js';

test('the counter declares itself an estimate', () => {
  assert.equal(TOKENIZER.exact, false);
});

test('text counts are sane non-negative integers', () => {
  assert.equal(countTextTokens(''), 0);
  assert.equal(countTextTokens(null), 0);
  assert.equal(countTextTokens('hello'), 1);

  const sentence = countTextTokens('How do I create an Express server?');
  assert.ok(sentence >= 7 && sentence <= 10, `got ${sentence}`);

  assert.equal(countTextTokens('你好世界'), 4, 'one token per CJK character');
  assert.equal(countTextTokens('123456'), 2, 'digits in groups of three');
  assert.ok(Number.isInteger(countTextTokens('🚀 emoji & symbols!')));
});

test('longer text never counts fewer tokens', () => {
  const base = 'Node.js is a JavaScript runtime built on V8.';
  assert.ok(countTextTokens(`${base} ${base}`) > countTextTokens(base));
});

test('message and request counts include chat-template overhead', () => {
  const content = 'What is Node.js?';
  const text = countTextTokens(content);

  assert.equal(countMessageTokens({ role: 'system', content }), text);
  assert.equal(countMessageTokens({ role: 'user', content }), text + 1);
  assert.equal(countMessageTokens({ role: 'assistant', content }), text + 2);

  const messages = [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content }];
  const sumOfContents = messages.reduce((n, m) => n + countTextTokens(m.content), 0);
  assert.ok(countRequestTokens(messages) > sumOfContents, 'a request costs more than its texts');
  assert.equal(countRequestTokens([]), 0);
});
