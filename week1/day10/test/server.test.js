'use strict';

const assert = require('assert');
const test = require('./harness').test;
const h = require('./helpers');
const loadConfig = require('../src/config');
const serverModule = require('../src/server/server');
const StateStore = require('../src/storage/stateStore').StateStore;

const SECRET = 'sk-test-secret-should-never-leak';

async function withServer(options, fn) {
  const t = await h.makeAgent(options);
  const app = serverModule.createApp({ agent: t.agent, config: loadConfig({}), logger: h.quietLogger });
  const server = await h.listen(app);
  try {
    await fn(server, t);
  } finally {
    server.close();
  }
}

test('GET /api/state restores the UI and never contains the API key', async function () {
  const dir = h.tempDir();
  const config = loadConfig({ DEEPSEEK_API_KEY: SECRET, DATA_DIR: dir, DEEPSEEK_API_URL: 'http://127.0.0.1:9' });
  const store = new StateStore({ dataDir: dir, logger: h.quietLogger });
  await store.init();
  const agent = serverModule.createAgent(config, store, h.quietLogger);
  const server = await h.listen(serverModule.createApp({ agent: agent, config: config, logger: h.quietLogger }));
  try {
    const res = await h.request(server, 'GET', '/api/state');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.agent.configured, true);
    assert.strictEqual(res.body.contextManagement.mode, 'sliding-window');
    assert.ok(Array.isArray(res.body.messages));
    assert.ok(res.text.indexOf(SECRET) === -1, 'the key is not in the state');

    const ask = await h.request(server, 'POST', '/api/ask', { question: 'hello' });
    assert.strictEqual(ask.status, 502, 'unreachable DeepSeek is a clean 502');
    assert.ok(/Could not reach DeepSeek/.test(ask.body.error));
    assert.ok(ask.text.indexOf(SECRET) === -1, 'the key is not in errors');

    const page = await h.request(server, 'GET', '/');
    const script = await h.request(server, 'GET', '/app.js');
    assert.ok(/<title>DeepSeek Agent<\/title>/.test(page.text));
    assert.ok(page.text.indexOf(SECRET) === -1 && script.text.indexOf(SECRET) === -1);
    assert.ok(/default-src 'self'/.test(page.headers['content-security-policy']));
    const shared = await h.request(server, 'GET', '/shared/tokenService.js');
    assert.strictEqual(shared.status, 200);
    assert.strictEqual((await h.request(server, 'GET', '/config.js')).status, 404, 'server source is not exposed');
  } finally {
    server.close();
  }
});

test('POST /api/ask stores and returns the pair with token information', async function () {
  await withServer({}, async function (server, t) {
    const res = await h.request(server, 'POST', '/api/ask', { question: 'What is Docker?' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.request.content, 'What is Docker?');
    assert.strictEqual(res.body.response.content, 'answer to: What is Docker?');
    assert.strictEqual(res.body.turn.responseTokens, 7);
    assert.ok(res.body.turn.requestTokens > 0);
    assert.ok(res.body.turn.contextTokens > 0);
    assert.strictEqual(res.body.state.statistics.totalTokens, res.body.request.tokens + res.body.response.tokens);
    assert.strictEqual(h.readJson(t.file).messages.length, 2);

    const reload = await h.request(server, 'GET', '/api/state');
    assert.deepStrictEqual(h.contents(reload.body.messages), ['What is Docker?', 'answer to: What is Docker?']);
  });
});

test('POST /api/ask validates input', async function () {
  await withServer({ maxQuestionChars: 100 }, async function (server, t) {
    assert.strictEqual((await h.request(server, 'POST', '/api/ask', { question: '  ' })).status, 400);
    assert.strictEqual((await h.request(server, 'POST', '/api/ask', {})).status, 400);
    assert.strictEqual((await h.request(server, 'POST', '/api/ask', { question: 'x'.repeat(101) })).status, 413);
    assert.strictEqual((await h.request(server, 'POST', '/api/ask', null, '{"question": ')).status, 400);
    assert.strictEqual((await h.request(server, 'POST', '/api/ask', { question: 'x'.repeat(70000) })).status, 413);
    assert.strictEqual(t.client.calls.length, 0);
  });
});

test('missing API key → 503; DeepSeek failure → 502; nothing is stored', async function () {
  await withServer({}, async function (server, t) {
    t.client.configured = false;
    let res = await h.request(server, 'POST', '/api/ask', { question: 'hi' });
    assert.strictEqual(res.status, 503);
    assert.ok(/DEEPSEEK_API_KEY/.test(res.body.error));

    t.client.configured = true;
    t.client.failAnswers = 1;
    res = await h.request(server, 'POST', '/api/ask', { question: 'hi' });
    assert.strictEqual(res.status, 502);
    assert.ok(/unavailable/.test(res.body.error));
    assert.strictEqual(h.readJson(t.file).messages.length, 0);
  });
});

test('context and branching endpoints drive the whole checkpoint flow', async function () {
  await withServer({}, async function (server) {
    let res = await h.request(server, 'POST', '/api/context', { slidingWindow: { N: 0 } });
    assert.strictEqual(res.status, 400);
    res = await h.request(server, 'POST', '/api/checkpoint');
    assert.strictEqual(res.status, 409, 'not in branching mode');

    res = await h.request(server, 'POST', '/api/context', { mode: 'branching' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.state.contextManagement.mode, 'branching');
    await h.request(server, 'POST', '/api/ask', { question: 'base' });

    res = await h.request(server, 'POST', '/api/checkpoint');
    assert.strictEqual(res.status, 200);
    const ids = res.body.checkpoint.branchIds;
    assert.strictEqual((await h.request(server, 'POST', '/api/checkpoint')).status, 409);

    await h.request(server, 'POST', '/api/ask', { question: 'A-only' });
    res = await h.request(server, 'POST', '/api/branch/switch', {});
    assert.strictEqual(res.body.state.contextManagement.branching.activeBranchId, ids[1]);
    assert.deepStrictEqual(h.contents(res.body.state.messages), ['base', 'answer to: base']);

    assert.strictEqual((await h.request(server, 'POST', '/api/checkpoint/delete', {})).status, 400);
    res = await h.request(server, 'POST', '/api/checkpoint/delete', { branchId: ids[1] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.state.contextManagement.branching.checkpoint, null);
    assert.deepStrictEqual(h.contents(res.body.state.messages), ['base', 'answer to: base', 'A-only', 'answer to: A-only']);

    assert.strictEqual((await h.request(server, 'GET', '/api/nope')).status, 404);
  });
});
