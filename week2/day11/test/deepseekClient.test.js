import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekClient, DeepSeekError, resolveEndpoint } from '../src/agent/deepseekClient.js';

const messages = [{ role: 'user', content: 'Hi' }];

const json = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const clientReturning = (response) => new DeepSeekClient({ apiKey: 'sk-test', fetchImpl: async () => response() });

const neverCalled = async () => {
  throw new Error('fetch must not be called');
};

test('a missing or placeholder key fails before any network call', async () => {
  for (const apiKey of [undefined, '', '   ', 'your_api_key_here']) {
    const client = new DeepSeekClient({ apiKey, fetchImpl: neverCalled });
    assert.equal(client.configured, false);
    await assert.rejects(() => client.send(messages), (err) => {
      assert.ok(err instanceof DeepSeekError);
      assert.equal(err.code, 'missing_api_key');
      assert.equal(err.status, 503);
      assert.match(err.message, /DeepSeek API key is missing/);
      return true;
    });
  }
});

test('a successful call sends the messages with the key and parses the answer', async () => {
  let captured;
  const client = new DeepSeekClient({
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return json(200, {
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    },
  });

  const result = await client.send(messages);
  assert.deepEqual(result, {
    content: 'Hello!',
    model: 'deepseek-chat',
    finishReason: 'stop',
    usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
  });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'deepseek-chat', messages, stream: false });
  assert.ok(captured.init.signal, 'every request carries a timeout signal');
});

test('HTTP errors map to clear, specific errors', async () => {
  const cases = [
    [json(401, { error: { message: 'Authentication Fails' } }), 'auth', 502, /rejected the API key/],
    [json(402, { error: { message: 'Insufficient Balance' } }), 'insufficient_balance', 502, /insufficient balance/],
    [json(429, { error: { message: 'Rate limit' } }, { 'Retry-After': '7' }), 'rate_limited', 429, /retry in 7s/],
    [json(400, { error: { message: 'Invalid model' } }), 'bad_request', 502, /DeepSeek API returned an error: Invalid model/],
    [json(503, { error: { message: 'Overloaded' } }), 'api_error', 502, /DeepSeek API returned an error \(HTTP 503\)/],
    [new Response('<html>Bad gateway</html>', { status: 502 }), 'api_error', 502, /HTTP 502/],
  ];

  for (const [response, code, status, message] of cases) {
    await assert.rejects(() => clientReturning(() => response).send(messages), (err) => {
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.match(err.message, message);
      assert.doesNotMatch(err.message, /sk-test/, 'the key never appears in an error');
      return true;
    });
  }

  const rateLimited = await clientReturning(() => json(429, {}, { 'Retry-After': '7' })).send(messages).catch((e) => e);
  assert.equal(rateLimited.retryAfterSeconds, 7);
});

test('invalid successful responses are reported, not passed on', async () => {
  const cases = [
    [() => new Response('not json', { status: 200 }), /not JSON/],
    [() => json(200, { choices: [] }), /without an answer/],
    [() => json(200, { choices: [{ message: { content: '   ' } }] }), /empty answer/],
  ];
  for (const [response, message] of cases) {
    await assert.rejects(() => clientReturning(response).send(messages), { code: 'invalid_response', message });
  }
});

test('network failures and timeouts are distinguished', async () => {
  const offline = new DeepSeekClient({
    apiKey: 'sk-test',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(() => offline.send(messages), { code: 'network', message: /Unable to connect to DeepSeek API/ });

  const slow = new DeepSeekClient({
    apiKey: 'sk-test',
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  await assert.rejects(() => slow.send(messages), { code: 'timeout', status: 504 });
});

test('the endpoint accepts a base URL or a full path', () => {
  assert.equal(resolveEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(resolveEndpoint('http://localhost:9/v1/chat/completions'), 'http://localhost:9/v1/chat/completions');
  assert.equal(resolveEndpoint(undefined), 'https://api.deepseek.com/chat/completions');
});
