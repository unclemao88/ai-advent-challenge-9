import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp, listen } from './helpers.js';
import { DeepSeekClient } from '../src/api/deepseek.js';

const DATA_FILES = [
  'history/chat-history.json', 'memory/short-term.json', 'memory/work-memory.json', 'memory/long-term.json',
  'profile/profile.json', 'invariants/invariants.json', 'tasks/active.json', 'config/memory-storage.json',
];

test('first start creates every data file with valid empty JSON', async (t) => {
  const { dataDir } = await buildApp(t);
  for (const file of DATA_FILES) {
    JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));
  }
  assert.deepEqual(await readdir(path.join(dataDir, 'tasks')), ['active.json']);
});

test('existing data files are never overwritten on start', async (t) => {
  const first = await buildApp(t);
  await first.profiles.updateProfile({ style: 'kept' });
  await first.invariants.create({ name: 'Keep me', value: 'Node.js', category: 'stackLimitations' });
  const second = await buildApp(t, { dataDir: first.dataDir });
  assert.equal((await second.profiles.getProfile()).style, 'kept');
  assert.equal((await second.invariants.list()).length, 1);
});

test('POST /api/ask returns task state, response and token counts', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  const res = await request('POST', '/api/ask', { message: 'Hello agent', mode: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(res.json.task.state, 'planning');
  assert.equal(res.json.task.nextState, 'execution');
  assert.ok(res.json.task.plannedAction);
  assert.equal(typeof res.json.response, 'string');
  for (const key of ['shortTerm', 'work', 'longTerm', 'currentContext', 'apiInput', 'apiOutput', 'total']) {
    assert.ok(key in res.json.tokens, `tokens.${key}`);
  }
  assert.ok(res.headers.get('x-request-id'));

  const history = await request('GET', '/api/history');
  assert.deepEqual(history.json.messages.map((m) => m.tag), ['you asked', 'agent answered']);
  assert.ok(history.json.messages.every((m) => m.id && m.role && m.content && m.date && m.time && m.timestamp));
  assert.equal(history.json.messages[1].task.state, 'planning', 'the answer carries the actual task state');
  assert.equal(history.json.task.id, res.json.task.id);
});

test('input is validated on the server', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  assert.equal((await request('POST', '/api/ask', {})).status, 400);
  assert.equal((await request('POST', '/api/ask', { message: '   ' })).status, 400);
  assert.equal((await request('POST', '/api/ask', { message: 'x'.repeat(8001) })).status, 400);
  assert.equal((await request('POST', '/api/ask', { message: 'hi', mode: 'turbo' })).status, 400);
  assert.equal((await request('POST', '/api/ask', { message: 'hi', extra: 1 })).status, 400);
  assert.equal((await request('POST', '/api/ask', '{bad json')).status, 400);
  assert.equal((await request('POST', '/api/ask', 'message=hi', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await request('GET', '/api/tasks/not-a-task')).status, 400);
  assert.equal((await request('GET', '/api/tasks/task-11111111-1111-4111-8111-111111111111')).status, 404);
  assert.equal((await request('PUT', '/api/invariants/..%2F..%2Fetc', { value: 'x' })).status, 400);
  assert.equal((await request('POST', '/api/invariants', { name: 'x' })).status, 400);
  assert.equal((await request('PUT', '/api/memory/storage', { longTerm: { provider: 'mysql' } })).status, 400);
  assert.equal((await request('POST', '/api/ask', { message: 'hi' }, { Origin: 'https://evil.example' })).status, 403);
});

test('profile endpoints: create, view, edit, clear, delete', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  assert.equal((await request('GET', '/api/profile')).json.profile, null);
  assert.equal((await request('POST', '/api/profile', { style: 'short' })).status, 201);
  assert.equal((await request('POST', '/api/profile', { style: 'again' })).status, 409);
  const put = await request('PUT', '/api/profile', { format: 'markdown' });
  assert.deepEqual([put.json.profile.style, put.json.profile.format], ['short', 'markdown']);
  assert.match(put.json.contextSection, /\[USER PROFILE\]\nStyle: short/);
  const cleared = await request('POST', '/api/profile/clear');
  assert.equal(cleared.json.profile.style, '');
  const deleted = await request('DELETE', '/api/profile');
  assert.equal(deleted.json.deleted, true);
  assert.equal(deleted.json.profile, null);
});

test('invariant endpoints: create, list, edit, enable/disable, delete, dry-run', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  const created = await request('POST', '/api/invariants', { id: 'stack', name: 'Stack', value: 'Node.js + Express', category: 'stackLimitations' });
  assert.equal(created.status, 201);
  const listed = await request('GET', '/api/invariants');
  assert.equal(listed.json.active, 1);
  assert.equal(listed.json.grouped.stackLimitations[0].id, 'stack');
  assert.equal((await request('PUT', '/api/invariants/stack', { value: 'Node.js 22 + Express 5' })).json.invariant.value, 'Node.js 22 + Express 5');
  const check = await request('POST', '/api/invariants/check', { text: 'Rewrite backend in Python' });
  assert.equal(check.json.ok, false);
  const off = await request('PUT', '/api/invariants/stack', { enabled: false });
  assert.equal(off.json.active, 0);
  assert.equal((await request('PUT', '/api/invariants/stack', { id: 'other' })).status, 400);
  assert.equal((await request('DELETE', '/api/invariants/stack')).status, 200);
  assert.equal((await request('DELETE', '/api/invariants/stack')).status, 404);
});

test('task endpoints: continue, pause, resume, auto, manual, resolve; invalid transitions are refused', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  const { json } = await request('POST', '/api/ask', { message: 'Hello', mode: 'manual' });
  const id = json.task.id;
  assert.deepEqual(json.task.allowedTransitions, ['planning', 'execution', 'paused', 'failed', 'cancelled']);
  assert.equal((await request('POST', `/api/tasks/${id}/continue`)).json.task.state, 'execution');
  assert.equal((await request('POST', `/api/tasks/${id}/pause`)).json.task.state, 'paused');
  const refused = await request('POST', `/api/tasks/${id}/continue`);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'invalid_transition');
  assert.equal((await request('GET', `/api/tasks/${id}`)).json.task.state, 'paused', 'the state is preserved');
  assert.equal((await request('POST', `/api/tasks/${id}/resume`)).json.task.state, 'execution');
  assert.equal((await request('POST', `/api/tasks/${id}/manual`)).json.task.mode, 'manual');
  const auto = await request('POST', `/api/tasks/${id}/auto`);
  assert.equal(auto.json.task.mode, 'auto');
  assert.equal(auto.json.task.state, 'done', 'auto carries on through validation to done');
  assert.equal((await request('POST', `/api/tasks/${id}/auto`, { mode: 'x' })).status, 400);
  assert.equal((await request('POST', `/api/tasks/${id}/resolve`, { decision: 'keep' })).status, 409);
  assert.equal((await request('POST', `/api/tasks/${id}/manual`)).status, 409, 'a finished task cannot change mode');
  const detail = await request('GET', `/api/tasks/${id}`);
  assert.ok(detail.json.workMemory.objective);
  assert.deepEqual(detail.json.task.history.map((h) => h.to), ['planning', 'execution', 'paused', 'execution', 'validation', 'done']);
  const list = await request('GET', '/api/tasks');
  assert.equal(list.json.tasks[0].id, id);
});

test('memory endpoints show each layer separately, with token counts', async (t) => {
  const { app } = await buildApp(t);
  const request = await listen(t, app);
  const { json } = await request('POST', '/api/ask', { message: 'Hello', mode: 'manual' });
  const all = await request('GET', '/api/memory');
  assert.ok(all.json.shortTerm.messages.length === 2 && all.json.shortTerm.tokens > 0);
  assert.equal(all.json.work.taskId, json.task.id);
  assert.ok(all.json.work.tokens > 0);
  assert.ok('solutions' in all.json.longTerm && 'profile' in all.json.longTerm);
  assert.equal((await request('GET', '/api/memory/short-term')).json.messages.length, 2);
  assert.ok((await request('GET', '/api/memory/work')).json.tasks[json.task.id]);
  const added = await request('POST', '/api/memory/long-term', { category: 'knowledge', content: 'Debian 12', tags: ['os'] });
  assert.equal(added.status, 201);
  const retrieval = await request('GET', '/api/memory/long-term?q=which%20debian%20version');
  assert.equal(retrieval.json.retrieval.selected[0].id, added.json.entry.id);
  const promoted = await request('POST', '/api/memory/promote', { taskId: json.task.id, field: 'objective', category: 'knowledge' });
  assert.equal(promoted.status, 201);
  const tokens = await request('GET', '/api/token-counts?message=a%20draft');
  for (const key of ['shortTerm', 'work', 'longTerm', 'currentContext']) assert.equal(typeof tokens.json.tokens[key], 'number', key);
  assert.ok(tokens.json.tokens.currentContext > tokens.json.tokens.breakdown.request);
  const withText = await request('POST', '/api/token-counts', { message: 'draft', includeText: true });
  assert.match(withText.json.messages[0].content, /\[AGENT INVARIANTS\]/);
  assert.equal(withText.json.messages.at(-1).content.includes('draft'), true);
});

test('a missing API key is reported clearly and the key is never exposed', async (t) => {
  const secret = 'sk-test-secret-value-1234567890';
  const llm = new DeepSeekClient({ apiKey: '' });
  const { app, logger } = await buildApp(t, { llm, env: { DEEPSEEK_API_KEY: secret } });
  const request = await listen(t, app);
  const res = await request('POST', '/api/ask', { message: 'Hello' });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'missing_api_key');
  assert.equal(res.json.result.task.state, 'failed');
  const config = await request('GET', '/api/config');
  assert.equal(config.json.llm.apiKeyConfigured, false);
  for (const text of [res.text, config.text, JSON.stringify(logger.entries)]) assert.ok(!text.includes(secret));
});

test('unexpected errors never leak stack traces; static files never expose data', async (t) => {
  const { app, agent } = await buildApp(t);
  agent.tokenSummary = async () => { throw new Error('boom at /secret/path.js:1'); };
  const request = await listen(t, app);
  const res = await request('GET', '/api/token-counts');
  assert.equal(res.status, 500);
  assert.ok(!res.text.includes('/secret/path') && !res.text.includes('at '));
  for (const url of ['/data/profile/profile.json', '/profile/profile.json', '/../.env', '/src/server.js', '/.env']) {
    assert.equal((await request('GET', url)).status, 404, url);
  }
  const page = await request('GET', '/');
  assert.match(page.text, /placeholder="ask your question, master"/);
  assert.match(page.text, /<button type="submit"[^>]*>ask<\/button>\s*<button[^>]*id="btn-profile"/, 'profile sits right next to ask');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.ok(!page.text.includes('DEEPSEEK_API_KEY'));
});
