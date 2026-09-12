'use strict';

// Exercises the agent against a stub of DeepSeek's endpoint, so the whole
// request/response path is covered without a key or network access.
//
//   node test/agent.test.js

const assert = require('assert');
const http = require('http');

const createAgent = require('../agent').createAgent;
const AgentError = require('../agent').AgentError;
const DeepSeekAgent = require('../agent').DeepSeekAgent;

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/** Stub endpoint; `handler(body, res)` decides what DeepSeek "replies". */
function stub(handler) {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      let raw = '';
      req.on('data', function (c) { raw += c; });
      req.on('end', function () {
        handler({ headers: req.headers, body: JSON.parse(raw), path: req.url }, res);
      });
    });
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port + '/chat/completions',
        close: function () { server.close(); }
      });
    });
  });
}

function completion(text) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

test('returns the answer and sends a well-formed request', async function () {
  let seen = null;
  const s = await stub(function (req, res) {
    seen = req;
    reply(res, 200, completion('42'));
  });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'sk-test', apiUrl: s.url, model: 'deepseek-chat' });
    assert.strictEqual(await agent.ask('  the answer?  '), '42');
    assert.strictEqual(seen.headers.authorization, 'Bearer sk-test');
    assert.strictEqual(seen.body.model, 'deepseek-chat');
    assert.strictEqual(seen.body.stream, false);
    assert.deepStrictEqual(seen.body.messages, [{ role: 'user', content: 'the answer?' }]);
  } finally { s.close(); }
});

test('prepends the system prompt when configured', async function () {
  let seen = null;
  const s = await stub(function (req, res) { seen = req; reply(res, 200, completion('ok')); });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url, systemPrompt: 'Be brief.' });
    await agent.ask('hi');
    assert.deepStrictEqual(seen.body.messages[0], { role: 'system', content: 'Be brief.' });
  } finally { s.close(); }
});

test('rejects an empty question without calling the API', async function () {
  let called = false;
  const s = await stub(function (req, res) { called = true; reply(res, 200, completion('x')); });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url });
    await assert.rejects(agent.ask('   '), function (err) {
      return err instanceof AgentError && err.status === 400;
    });
    assert.strictEqual(called, false);
  } finally { s.close(); }
});

test('maps a 401 to a readable error that does not leak the key', async function () {
  const s = await stub(function (req, res) {
    reply(res, 401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
  });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'sk-secret', apiUrl: s.url });
    await assert.rejects(agent.ask('hi'), function (err) {
      assert.ok(err instanceof AgentError);
      assert.ok(/API key/i.test(err.message), err.message);
      assert.ok(err.message.indexOf('sk-secret') === -1);
      return true;
    });
  } finally { s.close(); }
});

test('maps a 429 to status 429', async function () {
  const s = await stub(function (req, res) { reply(res, 429, JSON.stringify({ error: { message: 'slow down' } })); });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url });
    await assert.rejects(agent.ask('hi'), function (err) { return err.status === 429; });
  } finally { s.close(); }
});

test('reports non-JSON responses instead of throwing a parse error', async function () {
  const s = await stub(function (req, res) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>gateway</html>');
  });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url });
    await assert.rejects(agent.ask('hi'), function (err) {
      return err instanceof AgentError && /not JSON/.test(err.message);
    });
  } finally { s.close(); }
});

test('rejects a response with no message content', async function () {
  const s = await stub(function (req, res) { reply(res, 200, JSON.stringify({ choices: [] })); });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url });
    await assert.rejects(agent.ask('hi'), function (err) {
      return err instanceof AgentError && /no message content/.test(err.message);
    });
  } finally { s.close(); }
});

test('times out a slow provider', async function () {
  const s = await stub(function (req, res) {
    setTimeout(function () { reply(res, 200, completion('too late')); }, 2000).unref();
  });
  try {
    const agent = new DeepSeekAgent({ apiKey: 'k', apiUrl: s.url, timeoutMs: 150 });
    await assert.rejects(agent.ask('hi'), function (err) {
      return err instanceof AgentError && err.status === 504 && /did not answer/.test(err.message);
    });
  } finally { s.close(); }
});

test('createAgent selects a provider and refuses unknown ones', async function () {
  const echo = createAgent({ AGENT_PROVIDER: 'echo' });
  assert.ok((await echo.ask('ping')).indexOf('ping') !== -1);

  const deepseek = createAgent({ AGENT_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODEL: 'deepseek-reasoner' });
  assert.strictEqual(deepseek.model, 'deepseek-reasoner');

  assert.throws(function () { createAgent({ AGENT_PROVIDER: 'gpt' }); }, /Unknown AGENT_PROVIDER/);
  assert.throws(function () { createAgent({ AGENT_PROVIDER: 'deepseek' }); }, /DEEPSEEK_API_KEY/);
});

(async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ok  ' + t.name);
    } catch (err) {
      console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + '/' + tests.length + ' passed');
})();
