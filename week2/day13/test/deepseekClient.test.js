import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekClient, DeepSeekError, resolveEndpoint } from '../src/deepseek/DeepSeekClient.js';
import { createLlmClient } from '../src/deepseek/index.js';
import { createMemoryLogger, redact } from '../src/utils/logger.js';

const KEY = 'sk-test-key-0123456789';
const messages = [{ role: 'user', content: 'hi' }];

function mockFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const completion = (content) => json(200, {
  model: 'deepseek-chat',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
});

test('sends an authenticated chat-completions request in JSON mode', async () => {
  const fetchImpl = mockFetch(() => completion('{"response":"ok"}'));
  const client = new DeepSeekClient({ apiKey: KEY, model: 'deepseek-chat', maxTokens: 500, temperature: 0.2, fetchImpl });
  const result = await client.complete(messages, { json: true });
  assert.equal(result.content, '{"response":"ok"}');
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(call.body, {
    model: 'deepseek-chat', messages, stream: false, response_format: { type: 'json_object' }, max_tokens: 500, temperature: 0.2,
  });

  await client.complete(messages);
  assert.equal(fetchImpl.calls[1].body.response_format, undefined);
});

test('a missing or placeholder key fails before any network call', async () => {
  for (const apiKey of [undefined, '', '   ', 'your_api_key_here']) {
    const fetchImpl = mockFetch(() => completion('x'));
    const client = new DeepSeekClient({ apiKey, fetchImpl });
    assert.equal(client.configured, false);
    await assert.rejects(() => client.complete(messages), (err) => err.code === 'missing_api_key' && err.status === 503);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('HTTP errors map to user-safe errors that never contain the key', async () => {
  const cases = [
    [json(401, { error: { message: 'Authentication Fails' } }), 'auth', 502],
    [json(402, { error: { message: 'Insufficient Balance' } }), 'insufficient_balance', 502],
    [json(429, { error: { message: 'slow down' } }, { 'Retry-After': '7' }), 'rate_limited', 429],
    [json(400, { error: { message: 'bad model' } }), 'bad_request', 502],
    [json(500, { error: { message: 'oops' } }), 'api_error', 502],
    [new Response('<html>Bad Gateway</html>', { status: 502 }), 'api_error', 502],
  ];
  for (const [response, code, status] of cases) {
    const client = new DeepSeekClient({ apiKey: KEY, fetchImpl: async () => response });
    const err = await client.complete(messages).catch((e) => e);
    assert.ok(err instanceof DeepSeekError, code);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.ok(!err.message.includes(KEY));
    if (code === 'rate_limited') assert.equal(err.retryAfterSeconds, 7);
  }
});

test('invalid responses, timeouts and network failures are reported', async () => {
  const invalid = [
    new Response('not json at all', { status: 200 }),
    json(200, { choices: [] }),
    json(200, { choices: [{ message: { content: '   ' } }] }),
    json(200, { choices: [{ message: { content: null } }] }),
  ];
  for (const response of invalid) {
    const client = new DeepSeekClient({ apiKey: KEY, fetchImpl: async () => response });
    const err = await client.complete(messages).catch((e) => e);
    assert.equal(err.code, 'invalid_response');
  }

  const timeoutClient = new DeepSeekClient({
    apiKey: KEY,
    timeoutMs: 1000,
    fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
  });
  const timeout = await timeoutClient.complete(messages).catch((e) => e);
  assert.equal(timeout.code, 'timeout');
  assert.equal(timeout.status, 504);

  const offline = new DeepSeekClient({ apiKey: KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const network = await offline.complete(messages).catch((e) => e);
  assert.equal(network.code, 'network');
});

test('a real timeout aborts a hanging request', async () => {
  // The fake fetch does no I/O, and AbortSignal.timeout's timer does not hold
  // the event loop open (Node 20), so keep it alive for the duration instead.
  const keepAlive = setInterval(() => {}, 50);
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      clearInterval(keepAlive);
      reject(init.signal.reason);
    });
  });
  const client = new DeepSeekClient({ apiKey: KEY, timeoutMs: 1000, fetchImpl });
  const started = Date.now();
  const err = await client.complete(messages).catch((e) => e);
  assert.equal(err.code, 'timeout');
  assert.ok(Date.now() - started < 3000);
});

test('endpoints and providers are resolved', () => {
  assert.equal(resolveEndpoint('http://127.0.0.1:3999/'), 'http://127.0.0.1:3999/chat/completions');
  assert.equal(resolveEndpoint('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
  const client = createLlmClient({ provider: 'deepseek', apiKey: KEY });
  assert.equal(client.provider, 'deepseek');
  assert.equal(client.model, 'deepseek-chat');
  assert.ok(!JSON.stringify(client).includes(KEY), 'the key is private');
  assert.throws(() => createLlmClient({ provider: 'other' }), /Unknown LLM provider/);
});

test('the logger never writes secrets', () => {
  const logger = createMemoryLogger();
  logger.info('test', {
    apiKey: KEY, authorization: `Bearer ${KEY}`, nested: { password: 'pw', note: `key is ${KEY}` }, tokens: 42,
  });
  const line = JSON.stringify(logger.entries[0]);
  assert.ok(!line.includes(KEY));
  assert.ok(!line.includes('"pw"'));
  assert.equal(logger.entries[0].tokens, 42, 'token counts are not mistaken for secrets');
  assert.deepEqual(redact({ Authorization: 'x' }), { Authorization: '[redacted]' });
  const err = redact(new Error(`failed with ${KEY}`));
  assert.ok(!err.message.includes(KEY));
});
