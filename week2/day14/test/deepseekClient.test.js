import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekClient, resolveEndpoint } from '../src/api/deepseek.js';
import { logger } from './helpers.js';

const KEY = 'sk-unit-test-key-abcdef123456';
const messages = [{ role: 'user', content: 'hi' }];

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function client(fetchImpl, options = {}) {
  return new DeepSeekClient({ apiKey: KEY, fetchImpl, logger: options.logger, timeoutMs: options.timeoutMs, model: 'deepseek-chat' });
}

test('sends a chat completion and returns content and usage', async () => {
  let seen;
  const c = client(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return jsonResponse(200, {
      model: 'deepseek-chat',
      choices: [{ message: { content: '{"response":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    });
  });
  const out = await c.complete(messages, { json: true });
  assert.equal(seen.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(seen.body.model, 'deepseek-chat');
  assert.equal(out.content, '{"response":"ok"}');
  assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 3, totalTokens: 13 });
});

test('base URL or full endpoint are both accepted', () => {
  assert.equal(resolveEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(resolveEndpoint('http://127.0.0.1:3999/v1/chat/completions'), 'http://127.0.0.1:3999/v1/chat/completions');
});

test('missing or placeholder key fails fast without a network call', async () => {
  let called = false;
  for (const apiKey of ['', 'your_api_key_here', undefined]) {
    const c = new DeepSeekClient({ apiKey, fetchImpl: async () => { called = true; } });
    assert.equal(c.configured, false);
    await assert.rejects(c.complete(messages), (err) => err.code === 'missing_api_key' && err.status === 503);
  }
  assert.equal(called, false);
});

test('HTTP errors are mapped to clear, safe errors', async () => {
  const cases = [
    [401, 'auth', 502], [402, 'insufficient_balance', 502], [429, 'rate_limited', 429], [400, 'bad_request', 502], [503, 'api_error', 502],
  ];
  for (const [status, code, httpStatus] of cases) {
    const c = client(async () => jsonResponse(status, { error: { message: 'nope' } }, status === 429 ? { 'Retry-After': '7' } : {}));
    await assert.rejects(c.complete(messages), (err) => {
      assert.equal(err.code, code);
      assert.equal(err.status, httpStatus);
      if (status === 429) assert.equal(err.retryAfterSeconds, 7);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test('timeouts, network failures and malformed responses', async () => {
  const slow = client((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }), { timeoutMs: 1000 });
  await assert.rejects(slow.complete(messages), (err) => err.code === 'timeout' && err.status === 504);

  const down = client(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.complete(messages), (err) => err.code === 'network');

  const html = client(async () => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(html.complete(messages), (err) => err.code === 'invalid_response');

  const noChoices = client(async () => jsonResponse(200, { choices: [] }));
  await assert.rejects(noChoices.complete(messages), (err) => err.code === 'invalid_response');

  const empty = client(async () => jsonResponse(200, { choices: [{ message: { content: '  ' } }] }));
  await assert.rejects(empty.complete(messages), (err) => err.code === 'invalid_response');
});

test('logs timings and token counts, never the key or the text', async () => {
  const log = logger();
  const c = client(async () => jsonResponse(200, {
    choices: [{ message: { content: 'secret answer text' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), { logger: log });
  await c.complete([{ role: 'user', content: 'private question text' }], { requestId: 'req-12345678', taskId: 'task-x' });
  const entry = log.entries.find((e) => e.event === 'deepseek.request');
  assert.equal(entry.requestId, 'req-12345678');
  assert.equal(entry.promptTokens, 5);
  assert.equal(typeof entry.ms, 'number');
  const all = JSON.stringify(log.entries);
  assert.ok(!all.includes(KEY) && !all.includes('private question') && !all.includes('secret answer'));
});
