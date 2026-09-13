'use strict';

const assert = require('assert');
const http = require('http');
const test = require('./harness').test;
const DeepSeekClient = require('../src/agent/deepseekClient').DeepSeekClient;

const KEY = 'sk-client-test-key';

/** A local stand-in for api.deepseek.com; `handler(req, body, res)` decides the reply. */
function fakeDeepSeek(handler) {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () { handler(req, body, res); });
    });
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, url: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

async function withFake(handler, fn, timeoutMs) {
  const fake = await fakeDeepSeek(handler);
  try {
    await fn(new DeepSeekClient({ apiKey: KEY, apiUrl: fake.url, timeoutMs: timeoutMs || 2000 }));
  } finally {
    fake.server.close();
  }
}

const REQUEST = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

test('sends an authorized chat-completions request and parses content and usage', async function () {
  let seen = null;
  await withFake(function (req, body, res) {
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    reply(res, 200, {
      model: 'deepseek-chat',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }
    });
  }, async function (client) {
    const result = await client.chat(Object.assign({ responseFormat: 'json_object', maxTokens: 50 }, REQUEST));
    assert.strictEqual(result.content, 'hello');
    assert.deepStrictEqual(result.usage, { input: 12, output: 3, total: 15, reasoning: null });
  });
  assert.strictEqual(seen.path, '/chat/completions');
  assert.strictEqual(seen.auth, 'Bearer ' + KEY);
  assert.deepStrictEqual(seen.body.response_format, { type: 'json_object' });
  assert.strictEqual(seen.body.max_tokens, 50);
  assert.strictEqual(seen.body.stream, false);
});

test('maps an invalid key to a readable error without leaking the key', async function () {
  await withFake(function (req, body, res) {
    reply(res, 401, { error: { message: 'Authentication Fails, Your api key: ****-key is invalid' } });
  }, async function (client) {
    await assert.rejects(client.chat(REQUEST), function (err) {
      return err.name === 'AgentError' && /rejected the API key/.test(err.message) && err.message.indexOf(KEY) === -1;
    });
  });
});

test('rejects malformed responses', async function () {
  await withFake(function (req, body, res) { reply(res, 200, '<html>proxy error</html>'); }, async function (client) {
    await assert.rejects(client.chat(REQUEST), /not JSON/);
  });
  await withFake(function (req, body, res) { reply(res, 200, { choices: [] }); }, async function (client) {
    await assert.rejects(client.chat(REQUEST), /malformed/);
  });
  await withFake(function (req, body, res) { reply(res, 500, { error: { message: 'boom' } }); }, async function (client) {
    await assert.rejects(client.chat(REQUEST), /unavailable right now \(HTTP 500\)/);
  });
});

test('times out a request that never answers', async function () {
  await withFake(function () { /* never reply */ }, async function (client) {
    await assert.rejects(client.chat(REQUEST), function (err) { return err.status === 504 && /did not answer/.test(err.message); });
  }, 150);
});

test('reports network errors and a missing key', async function () {
  const client = new DeepSeekClient({ apiKey: KEY, apiUrl: 'http://127.0.0.1:9', timeoutMs: 2000 });
  await assert.rejects(client.chat(REQUEST), /Could not reach DeepSeek/);
  await assert.rejects(new DeepSeekClient({}).chat(REQUEST), function (err) { return err.status === 503; });
});
