'use strict';

// Runs public/agent.js (the browser half of the Agent interface) under Node
// with a stubbed fetch, so the UI's error handling is covered without a browser.
//
//   node test/browser-agent.test.js

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'agent.js'), 'utf8');

/** Evaluate agent.js against a fake window and a stubbed fetch. */
function load(fetchImpl) {
  const win = {};
  const ctx = vm.createContext({ window: win, fetch: fetchImpl, Promise: Promise, JSON: JSON, String: String, console: console });
  vm.runInContext(src, ctx);
  return win.agent;
}

function res(ok, status, body) {
  return { ok: ok, status: status, text: function () { return Promise.resolve(body); } };
}

(async function run() {
  // success + trimming
  let sent = null;
  let a = load(function (url, opts) { sent = { url: url, opts: opts }; return Promise.resolve(res(true, 200, JSON.stringify({ answer: 'hello' }))); });
  assert.strictEqual(await a.ask('  hi  '), 'hello');
  assert.strictEqual(sent.url, '/api/ask');
  assert.deepStrictEqual(JSON.parse(sent.opts.body), { question: 'hi' });
  console.log('  ok  posts trimmed question, returns answer');

  // empty question never hits the network
  let called = false;
  a = load(function () { called = true; return Promise.resolve(res(true, 200, '{}')); });
  await assert.rejects(a.ask('   '), /Please enter a question/);
  assert.strictEqual(called, false);
  console.log('  ok  empty question is not sent');

  // server error message surfaces
  a = load(function () { return Promise.resolve(res(false, 502, JSON.stringify({ error: 'DeepSeek is unavailable right now.' }))); });
  await assert.rejects(a.ask('x'), /DeepSeek is unavailable right now/);
  console.log('  ok  surfaces server error text');

  // non-JSON error body
  a = load(function () { return Promise.resolve(res(false, 500, '<html>oops</html>')); });
  await assert.rejects(a.ask('x'), /HTTP 500/);
  console.log('  ok  handles non-JSON error body');

  // 200 with garbage
  a = load(function () { return Promise.resolve(res(true, 200, 'not json')); });
  await assert.rejects(a.ask('x'), /unexpected response/);
  console.log('  ok  handles unexpected success body');

  // network failure
  a = load(function () { return Promise.reject(new Error('boom')); });
  await assert.rejects(a.ask('x'), /Could not reach the server/);
  console.log('  ok  handles network failure');
})().catch(function (err) {
  console.error('FAIL  ' + err.message);
  process.exit(1);
});
