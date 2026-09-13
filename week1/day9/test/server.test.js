'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');

const test = require('./harness').test;
const h = require('./helpers');
const createApp = require('../src/server/server').createApp;
const loadConfig = require('../src/config');

function request(port, method, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method,
      headers: payload === null ? {} : { 'Content-Type': contentType || 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(fn) {
  const ctx = await h.makeAgent();
  const config = Object.assign(loadConfig({}), { root: path.join(__dirname, '..') });
  const app = createApp({ agent: ctx.agent, config: config, logger: h.quietLogger });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(server.address().port, ctx);
  } finally {
    server.close();
  }
}

test('GET /api/history returns summary, messages and token counts', () => withServer(async (port) => {
  const res = await request(port, 'GET', '/api/history');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.json.tokens).sort(),
    ['fullHistory', 'fullHistoryEstimated', 'historyTotal', 'historyTotalEstimated', 'summary', 'summaryEstimated']);
  assert.ok(Array.isArray(res.json.messages));
  assert.strictEqual(res.json.summary.messagesCovered, 0);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
}));

test('POST /api/ask answers, and the state survives in GET /api/history', () => withServer(async (port) => {
  const res = await request(port, 'POST', '/api/ask', { question: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.message.role, 'assistant');
  assert.strictEqual(typeof res.json.tokens.currentRequest, 'number');
  assert.ok(res.json.summary && res.json.memory);

  const history = await request(port, 'GET', '/api/history');
  assert.strictEqual(history.json.messages.length, 2);
  assert.strictEqual(history.json.messages[0].content, '<img src=x onerror=alert(1)>', 'stored verbatim, escaped on render');
}));

test('invalid bodies get 400/413 with a JSON error', () => withServer(async (port) => {
  assert.strictEqual((await request(port, 'POST', '/api/ask', { question: '' })).status, 400);
  assert.strictEqual((await request(port, 'POST', '/api/ask', { nope: 1 })).status, 400);
  assert.strictEqual((await request(port, 'POST', '/api/ask', 'question=hi', 'application/x-www-form-urlencoded')).status, 400);
  const bad = await request(port, 'POST', '/api/ask', '{"question": ');
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json.error, 'Invalid JSON in request body.');
  assert.strictEqual((await request(port, 'POST', '/api/ask', { question: 'x'.repeat(8001) })).status, 413);
  assert.strictEqual((await request(port, 'POST', '/api/ask', { question: 'x'.repeat(70000) })).status, 413);
}));

test('DeepSeek failure returns an error status plus the stored question', () => withServer(async (port, ctx) => {
  ctx.client.failAnswers = 1;
  const res = await request(port, 'POST', '/api/ask', { question: 'hello?' });
  assert.strictEqual(res.status, 502);
  assert.ok(res.json.error);
  assert.strictEqual(res.json.userMessage.content, 'hello?');
  assert.strictEqual(res.json.memory.messages.length, 1);
}));

test('clearing history requires explicit confirmation', () => withServer(async (port) => {
  await request(port, 'POST', '/api/ask', { question: 'remember me' });
  assert.strictEqual((await request(port, 'POST', '/api/history/clear', {})).status, 400);
  assert.strictEqual((await request(port, 'GET', '/api/history')).json.messages.length, 2);
  const res = await request(port, 'POST', '/api/history/clear', { confirm: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.memory.messages.length, 0);
}));

test('static assets, shared token service, vendor scripts, security headers', () => withServer(async (port) => {
  const page = await request(port, 'GET', '/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.indexOf('placeholder="ask your question, master"') !== -1);
  assert.ok(/script-src 'self'/.test(page.headers['content-security-policy']));
  assert.strictEqual(page.headers['x-powered-by'], undefined);
  assert.strictEqual((await request(port, 'GET', '/shared/tokenService.js')).status, 200);
  assert.strictEqual((await request(port, 'GET', '/vendor/marked.min.js')).status, 200);
  assert.strictEqual((await request(port, 'GET', '/vendor/purify.min.js')).status, 200);
  assert.strictEqual((await request(port, 'GET', '/vendor/other.js')).status, 404);
  assert.strictEqual((await request(port, 'GET', '/config.js')).status, 404, 'src/ is not served');
  const missing = await request(port, 'GET', '/api/nope');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.error, 'Not found.');
}));
