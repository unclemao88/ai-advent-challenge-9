import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekError } from '../src/deepseek/DeepSeekClient.js';
import { buildApp, fakeLlm, listen } from './helpers.js';

async function server(t, options) {
  const built = await buildApp(t, options);
  return { ...built, request: await listen(t, built.app) };
}

test('the page loads with the required controls and security headers', async (t) => {
  const { request } = await server(t);
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /placeholder="ask your question, master"/);
  assert.match(page.text, />ask<\/button>/);
  assert.match(page.text, /id="btn-profile"/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);

  for (const asset of ['/app.js', '/markdown.js', '/styles.css', '/favicon.svg']) {
    assert.equal((await request('GET', asset)).status, 200, asset);
  }
});

test('files outside public/ are never served', async (t) => {
  const { request } = await server(t);
  for (const url of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/src/config.js', '/data/config/storage.json', '/.env', '/src/server/app.js']) {
    const res = await request('GET', url);
    assert.ok([400, 403, 404].includes(res.status), `${url} → ${res.status}`);
    assert.doesNotMatch(res.text, /"dependencies"|loadConfig|"layers"/);
  }
});

test('POST /api/chat returns the answer, the task state and token counts', async (t) => {
  const { request } = await server(t);
  const res = await request('POST', '/api/chat', { message: 'How do I list files?' });
  assert.equal(res.status, 200);
  const { response, task, tokens, messages } = res.json;
  assert.equal(typeof response, 'string');
  assert.deepEqual(
    Object.fromEntries(['currentState', 'nextState', 'mode', 'status'].map((k) => [k, task[k]])),
    { currentState: 'planning', nextState: 'execution', mode: 'manual', status: 'waiting' },
  );
  assert.ok(task.id && task.plannedAction);
  for (const key of ['shortTerm', 'workMemory', 'longTerm', 'currentRequestContext']) assert.equal(typeof tokens[key], 'number');
  assert.equal(messages.length, 2);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const history = await request('GET', '/api/chat/history');
  assert.equal(history.json.messages.length, 2);
  assert.equal(history.json.task.id, task.id);
});

test('chat input is validated', async (t) => {
  const { request, llm } = await server(t);
  const cases = [
    [{}, 400, /required/],
    [{ message: '' }, 400, /must not be empty/],
    [{ message: '   ' }, 400, /must not be empty/],
    [{ message: 42 }, 400, /must be text/],
    [{ message: 'x'.repeat(8001) }, 400, /too long/],
    [{ message: 'hi', mode: 'turbo' }, 400, /mode must be one of/],
    [{ message: 'hi', extra: true }, 400, /unknown field/],
    [['hi'], 400, /JSON object/],
  ];
  for (const [body, status, message] of cases) {
    const res = await request('POST', '/api/chat', body);
    assert.equal(res.status, status, JSON.stringify(body).slice(0, 40));
    assert.match(res.json.error, message);
  }
  const malformed = await request('POST', '/api/chat', '{"message": ');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, 'invalid_json');

  const wrongType = await request('POST', '/api/chat', 'message=hi', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(wrongType.status, 415);
  assert.equal(llm.calls.length, 0);
});

test('cross-site state changes are refused', async (t) => {
  const { request } = await server(t);
  const crossSite = await request('POST', '/api/chat', { message: 'hi' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const otherOrigin = await request('POST', '/api/chat', { message: 'hi' }, { Origin: 'https://evil.example' });
  assert.equal(otherOrigin.status, 403);
  const reading = await request('GET', '/api/config', undefined, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(reading.status, 200);
});

test('DeepSeek failures are reported without internals, and the saved message is returned', async (t) => {
  const llm = fakeLlm(() => {
    throw new DeepSeekError('missing_api_key', 'DeepSeek API key is missing. Set DEEPSEEK_API_KEY in the environment and restart the server.', { status: 503 });
  });
  const { request } = await server(t, { llm });
  const res = await request('POST', '/api/chat', { message: 'Keep me' });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'missing_api_key');
  assert.match(res.json.error, /DEEPSEEK_API_KEY/);
  assert.equal(res.json.result.messages[0].content, 'Keep me');
  assert.equal(res.json.result.task.status, 'failed');
  assert.doesNotMatch(res.text, /at .*\.js:\d+|stack/);
});

test('unexpected errors become a generic 500', async (t) => {
  const llm = fakeLlm(() => { throw new Error('secret internal detail /opt/x'); });
  const { request, logger } = await server(t, { llm });
  const res = await request('POST', '/api/chat', { message: 'boom' });
  assert.equal(res.status, 500);
  assert.equal(res.json.code, 'internal');
  assert.doesNotMatch(res.text, /secret internal detail|\/opt\/x/);
  assert.equal(res.json.result.task.lastError, 'Internal error.');
  assert.ok(logger.entries.some((e) => e.level === 'error' && JSON.stringify(e).includes('secret internal detail')), 'details are logged server-side');
});

test('storage failures are reported clearly', async (t) => {
  const { request, memory } = await server(t);
  const failing = memory.longTerm.backend;
  failing.put = async () => { throw Object.assign(new Error('EACCES: permission denied, open /secret/path'), { code: 'EACCES' }); };
  const res = await request('POST', '/api/memory/long-term', { category: 'knowledge', content: 'x' });
  assert.equal(res.status, 500);
  assert.equal(res.json.code, 'storage_error');
  assert.match(res.json.error, /not writable/);
  assert.doesNotMatch(res.text, /secret\/path/);
});

test('profile endpoints: create, view, edit, clear, delete', async (t) => {
  const { request } = await server(t);
  let res = await request('GET', '/api/profile');
  assert.equal(res.json.exists, false);
  assert.equal(res.json.profile, null);
  assert.deepEqual(Object.keys(res.json.fields), ['style', 'format', 'limitations']);

  res = await request('POST', '/api/profile', { style: 'concise', format: 'markdown', limitations: 'no jokes' });
  assert.equal(res.status, 201);
  assert.equal(res.json.applied, true);
  assert.equal(res.json.contextText, 'Style: concise\nFormat: markdown\nLimitations: no jokes');
  assert.ok(res.json.tokens.breakdown.profile > 5);
  assert.equal((await request('POST', '/api/profile', { style: 'again' })).status, 409);

  res = await request('PATCH', '/api/profile', { style: 'detailed' });
  assert.equal(res.json.profile.style, 'detailed');
  assert.equal(res.json.profile.format, 'markdown');

  res = await request('PUT', '/api/profile', { style: 'technical' });
  assert.deepEqual([res.json.profile.style, res.json.profile.format], ['technical', '']);

  assert.equal((await request('PUT', '/api/profile', { style: 5 })).status, 400);
  assert.equal((await request('PUT', '/api/profile', { color: 'red' })).json.code, 'invalid_profile');

  res = await request('POST', '/api/profile/clear');
  assert.equal(res.json.exists, true);
  assert.equal(res.json.applied, false);

  res = await request('DELETE', '/api/profile');
  assert.equal(res.json.deleted, true);
  assert.equal(res.json.exists, false);
  assert.equal((await request('DELETE', '/api/profile')).status, 404);
});

test('task endpoints drive the state machine', async (t) => {
  const { request } = await server(t);
  const { json } = await request('POST', '/api/chat', { message: 'Task via API' });
  const id = json.task.id;

  let res = await request('GET', '/api/tasks');
  assert.equal(res.json.tasks.length, 1);
  assert.equal(res.json.activeTaskId, id);
  assert.equal(res.json.tasks[0].transitions, 1);

  res = await request('POST', `/api/tasks/${id}/pause`);
  assert.equal(res.json.task.status, 'paused');
  res = await request('POST', `/api/tasks/${id}/continue`);
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'invalid_transition');
  res = await request('POST', '/api/chat', { message: 'while paused' });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'task_paused');
  res = await request('POST', `/api/tasks/${id}/resume`);
  assert.equal(res.json.task.status, 'waiting');

  res = await request('POST', `/api/tasks/${id}/continue`);
  assert.equal(res.json.task.currentState, 'execution');
  res = await request('POST', `/api/tasks/${id}/auto`);
  assert.equal(res.json.task.mode, 'auto');
  res = await request('POST', `/api/tasks/${id}/manual`);
  assert.equal(res.json.task.mode, 'manual');

  res = await request('GET', `/api/tasks/${id}`);
  assert.equal(res.json.task.currentState, 'execution');
  assert.deepEqual(res.json.task.history.map((h) => h.to), ['planning', 'paused', 'planning', 'execution']);
  assert.equal(res.json.workMemory.taskId, id);

  res = await request('DELETE', '/api/tasks/active');
  assert.equal(res.json.task, null);
  res = await request('POST', `/api/tasks/${id}/activate`);
  assert.equal(res.json.task.id, id);

  assert.equal((await request('POST', '/api/tasks/not-a-uuid/pause')).status, 400);
  assert.equal((await request('POST', '/api/tasks/..%2F..%2Fetc/pause')).status, 400);
  assert.equal((await request('GET', '/api/tasks/00000000-0000-4000-8000-000000000001')).status, 404);
  assert.equal((await request('POST', '/api/tasks/00000000-0000-4000-8000-000000000001/continue')).status, 404);

  res = await request('DELETE', `/api/tasks/${id}`);
  assert.equal(res.json.deleted, true);
  assert.equal((await request('GET', `/api/tasks/${id}`)).status, 404);
});

test('memory endpoints expose each layer separately', async (t) => {
  const { request } = await server(t);
  const { json } = await request('POST', '/api/chat', { message: 'decision: use JSON\nHello' });
  const id = json.task.id;

  let res = await request('GET', '/api/memory');
  assert.deepEqual(Object.keys(res.json.storage.layers), ['shortTerm', 'work', 'longTerm']);
  assert.equal(res.json.shortTerm.messages, 2);
  assert.equal(res.json.work.taskId, id);

  res = await request('GET', '/api/memory/short-term');
  assert.equal(res.json.messages.length, 2);
  assert.ok(res.json.tokens > 0);
  const [first] = res.json.messages;
  assert.equal((await request('DELETE', `/api/memory/short-term/${first.id}`)).json.deleted, true);
  assert.equal((await request('DELETE', `/api/memory/short-term/${first.id}`)).status, 404);
  assert.equal((await request('DELETE', '/api/memory/short-term/bad-id')).status, 400);

  res = await request('GET', '/api/memory/work');
  assert.equal(res.json.workMemory.decisions[0], 'use JSON', 'the explicit command is stored first');
  res = await request('PUT', `/api/memory/work/${id}`, { objective: 'Edited', requirements: ['r1', 'r2'], variables: { env: 'prod' } });
  assert.equal(res.json.workMemory.objective, 'Edited');
  assert.deepEqual(res.json.workMemory.decisions, []);
  assert.equal((await request('PUT', `/api/memory/work/${id}`, { requirements: 'nope' })).status, 400);
  res = await request('DELETE', `/api/memory/work/${id}`);
  assert.equal(res.json.workMemory.objective, '');

  res = await request('POST', '/api/memory/long-term', { category: 'solutions', content: 'Use rsync -a', tags: ['backup'] });
  assert.equal(res.status, 201);
  const factId = res.json.fact.id;
  assert.equal((await request('POST', '/api/memory/long-term', { category: 'solutions', content: 'use rsync -a' })).status, 200);
  assert.equal((await request('POST', '/api/memory/long-term', { category: 'passwords', content: 'x' })).status, 400);
  res = await request('GET', '/api/memory/long-term?q=rsync');
  assert.equal(res.json.results[0].id, factId);
  res = await request('PUT', `/api/memory/long-term/${factId}`, { content: 'Use rsync -aH', category: 'knowledge' });
  assert.equal(res.json.fact.category, 'knowledge');
  assert.equal((await request('PUT', '/api/memory/long-term/ltm_nope', { content: 'x' })).status, 404);
  assert.equal((await request('PUT', '/api/memory/long-term/..%2Fx', { content: 'x' })).status, 400);
  res = await request('DELETE', '/api/memory/long-term?category=knowledge');
  assert.equal(res.json.memory.knowledge.length, 0);

  res = await request('DELETE', '/api/memory/short-term');
  assert.equal(res.json.cleared, true);
  assert.equal((await request('GET', '/api/chat/history')).json.messages.length, 0);
});

test('storage configuration can be viewed and changed through the API', async (t) => {
  const { request } = await server(t);
  await request('POST', '/api/memory/long-term', { category: 'knowledge', content: 'survives switching' });
  let res = await request('GET', '/api/memory/storage');
  assert.equal(res.json.storage.layers.longTerm.backend, 'json');
  assert.ok(res.json.storage.backends.some((b) => b.type === 'memory'));

  res = await request('PUT', '/api/memory/storage', { layers: { longTerm: { backend: 'memory' } }, shortTerm: { maxMessages: 10 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.storage.layers.longTerm.backend, 'memory');
  assert.equal(res.json.storage.shortTerm.maxMessages, 10);
  assert.equal(res.json.changes[0].copied, 1);
  res = await request('GET', '/api/memory/long-term');
  assert.equal(res.json.memory.knowledge[0].content, 'survives switching');

  assert.equal((await request('PUT', '/api/memory/storage', { layers: { longTerm: { backend: 'mongo' } } })).status, 400);
  assert.equal((await request('PUT', '/api/memory/storage', { path: '/etc' })).status, 400);
});

test('context preview counts the full request and can show its text', async (t) => {
  const { request } = await server(t);
  const small = await request('POST', '/api/context/preview', { message: '' });
  const large = await request('POST', '/api/context/preview', { message: 'word '.repeat(200) });
  assert.ok(large.json.tokens.currentRequestContext > small.json.tokens.currentRequestContext + 100);
  const text = await request('POST', '/api/context/preview', { message: 'hi', includeText: true });
  assert.equal(text.json.messages[0].role, 'system');
  assert.match(text.json.sections.request, /\[CURRENT REQUEST\]/);
  assert.equal(text.json.tokens.breakdown.total, text.json.tokens.currentRequestContext);
});

test('config never exposes the API key', async (t) => {
  const { request } = await server(t, { env: { DEEPSEEK_API_KEY: 'sk-supersecretvalue123' } });
  const res = await request('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.json.llm.apiKeyConfigured, true);
  assert.equal(res.json.llm.model, 'fake-model');
  assert.deepEqual(res.json.stateMachine.activeStates, ['planning', 'execution', 'validation']);
  assert.doesNotMatch(res.text, /supersecret/);
  assert.equal((await request('GET', '/api/health')).json.status, 'ok');
  assert.equal((await request('GET', '/api/nope')).status, 404);
});

test('an access token protects the API when configured', async (t) => {
  const { request } = await server(t, { env: { APP_AUTH_TOKEN: 'let-me-in' } });
  assert.equal((await request('GET', '/api/health')).status, 200, 'health stays open');
  assert.equal((await request('GET', '/api/config')).status, 401);
  assert.equal((await request('GET', '/api/config', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  const ok = await request('GET', '/api/config', undefined, { Authorization: 'Bearer let-me-in' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.auth.required, true);
  assert.equal((await request('GET', '/')).status, 200, 'the page itself loads and asks for the token');
});

test('model-calling endpoints are rate limited', async (t) => {
  const { request } = await server(t, { env: { RATE_LIMIT_PER_MINUTE: '2' } });
  assert.equal((await request('POST', '/api/chat', { message: 'one' })).status, 200);
  const { json } = await request('POST', '/api/chat', { message: 'two' });
  const limited = await request('POST', `/api/tasks/${json.task.id}/continue`);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await request('GET', '/api/tasks')).status, 200, 'reads are not limited');
});

test('concurrent requests on the same task are refused, not interleaved', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const llm = fakeLlm(async (messages) => {
    await gate;
    return { response: 'ok', nextState: 'execution', plannedAction: 'x', needsUserInput: false, validation: null, workMemory: {}, memoryProposals: [] };
  });
  const { request } = await server(t, { llm });
  const first = request('POST', '/api/chat', { message: 'slow' });
  await new Promise((r) => setTimeout(r, 50));
  const second = await request('POST', '/api/chat', { message: 'impatient' });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'task_busy');
  const active = await request('GET', '/api/tasks/active');
  assert.equal(active.json.busy, true);
  assert.equal(active.json.task.status, 'running');
  assert.equal(active.json.tokens.target.blocked, 'running');
  release();
  assert.equal((await first).status, 200);
});
