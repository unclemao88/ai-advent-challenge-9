import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { DeepSeekError } from '../src/api/deepseekClient.js';
import { tempDataDir, quietLogger, fakeClient, listen } from './helpers.js';

async function startApp(t, client = fakeClient()) {
  const dataDir = await tempDataDir(t);
  const logger = quietLogger();
  const { app, memory } = await createApp({ dataDir, client, logger });
  const request = await listen(t, app);
  return { request, client, memory, dataDir, logger };
}

test('GET /api/status reports the model but never a key', async (t) => {
  const { request } = await startApp(t);
  const { status, json, text } = await request('GET', '/api/status');

  assert.equal(status, 200);
  assert.equal(json.deepseek.configured, true);
  assert.equal(json.limits.maxMessageChars, 8000);
  assert.ok(!/apiKey|api_key|sk-/.test(text));
});

test('the profile can be created, edited, cleared and deleted', async (t) => {
  const { request } = await startApp(t);

  assert.equal((await request('GET', '/api/profile')).json.empty, true);

  const created = await request('PUT', '/api/profile', {
    style: 'direct', format: 'short paragraphs', limitations: 'no emojis',
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.profile.style, 'direct');
  assert.equal(created.json.empty, false);
  assert.ok(created.json.tokens.profile > 0, 'the profile now costs tokens');

  const edited = await request('PUT', '/api/profile', { style: 'warm' });
  assert.equal(edited.json.profile.style, 'warm');
  assert.equal(edited.json.profile.format, 'short paragraphs', 'other fields are kept');

  const cleared = await request('POST', '/api/profile/clear');
  assert.equal(cleared.json.profile.style, '');
  assert.equal(cleared.json.empty, true);
  assert.ok(cleared.json.profile.createdAt);

  const deleted = await request('DELETE', '/api/profile');
  assert.equal(deleted.json.profile.createdAt, null);
  assert.equal(deleted.json.tokens.profile, 0);
});

test('an invalid profile is refused with a readable message', async (t) => {
  const { request } = await startApp(t);

  const wrongType = await request('PUT', '/api/profile', { style: 42 });
  assert.equal(wrongType.status, 400);
  assert.match(wrongType.json.error, /"style" must be text/);

  const tooLong = await request('PUT', '/api/profile', { style: 'x'.repeat(1001) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /too long/);
});

test('POST /api/chat answers with the reply, the stored entries and token counts', async (t) => {
  const { request, client } = await startApp(t);
  await request('PUT', '/api/profile', { style: 'direct' });

  const { status, json } = await request('POST', '/api/chat', { message: 'Hello there' });

  assert.equal(status, 200);
  assert.equal(json.response, 'Fake answer.');
  assert.equal(json.request.tag, 'you asked');
  assert.equal(json.reply.tag, 'agent answered');
  assert.ok(json.request.date && json.request.time && json.request.timestamp);
  assert.ok(json.tokens.currentContext > json.tokens.profile);
  assert.equal(json.usage.promptTokens, 123);
  assert.match(client.calls[0][0].content, /Style: direct/);
});

test('the conversation survives a "reload": GET /api/history rebuilds it', async (t) => {
  const { request } = await startApp(t);
  await request('POST', '/api/chat', { message: 'One' });
  await request('POST', '/api/chat', { message: 'Two' });

  const { json } = await request('GET', '/api/history');
  assert.deepEqual(json.entries.map((e) => e.tag),
    ['you asked', 'agent answered', 'you asked', 'agent answered']);
  assert.deepEqual(json.entries.map((e) => e.content), ['One', 'Fake answer.', 'Two', 'Fake answer.']);
  assert.ok(json.entries.every((e) => e.id && e.timestamp && e.date && e.time));
});

test('history is restored from disk by a fresh server on the same data directory', async (t) => {
  const dataDir = await tempDataDir(t);
  const logger = quietLogger();

  const first = await createApp({ dataDir, client: fakeClient(), logger });
  const askOnce = await listen(t, first.app);
  await askOnce('POST', '/api/chat', { message: 'Remember me' });
  await askOnce('PUT', '/api/profile', { style: 'direct' });

  const second = await createApp({ dataDir, client: fakeClient(), logger });
  const afterRestart = await listen(t, second.app);
  const { json } = await afterRestart('GET', '/api/history');

  assert.equal(json.entries[0].content, 'Remember me');
  assert.equal((await afterRestart('GET', '/api/profile')).json.profile.style, 'direct');
});

test('the context preview counts the full context of a draft', async (t) => {
  const { request } = await startApp(t);
  await request('PUT', '/api/profile', { style: 'direct', format: 'bullets' });

  const empty = await request('POST', '/api/context/preview', { message: '' });
  const typed = await request('POST', '/api/context/preview', { message: 'A question' });

  assert.ok(empty.json.tokens.currentContext > 0, 'memory alone already costs tokens');
  assert.ok(typed.json.tokens.currentContext > empty.json.tokens.currentContext);
  assert.ok(typed.json.tokens.currentContext > 50, 'this is the whole payload, not the typed words');
});

test('GET /api/memory describes every layer separately', async (t) => {
  const { request } = await startApp(t);
  const { json } = await request('GET', '/api/memory');

  assert.deepEqual(json.layers.map((l) => l.id),
    ['shortTerm', 'work', 'longTerm', 'profile', 'conversation']);
  const locations = json.layers.map((l) => l.location);
  assert.equal(new Set(locations).size, locations.length, 'no two layers share a location');
  assert.ok(json.tokenizer.name);
});

test('work and long-term memory can be edited and entries removed', async (t) => {
  const { request } = await startApp(t);

  const work = await request('PUT', '/api/memory/work', {
    task: 'Ship day 12', requirements: ['three layers', 'a profile'],
  });
  assert.equal(work.status, 200);
  const stored = work.json.layers.find((l) => l.id === 'work').contents;
  assert.equal(stored.task, 'Ship day 12');
  assert.deepEqual(stored.requirements, ['three layers', 'a profile']);

  const longTerm = await request('PUT', '/api/memory/long-term', {
    knowledge: [{ topic: 'node', fact: 'fetch is built in' }],
    solutions: [{ problem: 'slow start', solution: 'cache the index' }],
  });
  const entries = longTerm.json.layers.find((l) => l.id === 'longTerm').contents;
  assert.equal(entries.knowledge.length, 1);

  const removed = await request('POST', '/api/memory/long-term/remove', {
    category: 'knowledge', id: entries.knowledge[0].id,
  });
  assert.deepEqual(removed.json.layers.find((l) => l.id === 'longTerm').contents.knowledge, []);

  const missing = await request('POST', '/api/memory/long-term/remove', { category: 'knowledge', id: 'nope' });
  assert.equal(missing.status, 404);
});

test('clearing a layer leaves the others alone, and long-term needs confirmation', async (t) => {
  const { request } = await startApp(t);
  await request('PUT', '/api/memory/work', { task: 'Ship day 12' });
  await request('PUT', '/api/memory/long-term', { knowledge: [{ topic: 'x', fact: 'y' }] });
  await request('PUT', '/api/profile', { style: 'direct' });

  const unconfirmed = await request('POST', '/api/memory/clear', { layer: 'longTerm' });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.error, /must be confirmed/);

  const cleared = await request('POST', '/api/memory/clear', { layer: 'work' });
  assert.equal(cleared.json.layers.find((l) => l.id === 'work').contents.task, '');
  assert.equal(cleared.json.layers.find((l) => l.id === 'longTerm').contents.knowledge.length, 1);
  assert.equal(cleared.json.layers.find((l) => l.id === 'profile').contents.style, 'direct');

  const unknown = await request('POST', '/api/memory/clear', { layer: 'nonsense' });
  assert.equal(unknown.status, 400);
});

test('settings change how a layer is stored and how much it keeps', async (t) => {
  const { request } = await startApp(t);
  await request('POST', '/api/chat', { message: 'One' });

  const saved = await request('POST', '/api/settings', {
    memory: { shortTerm: { maxMessages: 2, storage: 'memory' }, work: { storage: 'disabled' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.memory.shortTerm.maxMessages, 2);
  assert.equal(saved.json.layers.find((l) => l.id === 'shortTerm').storage, 'memory');
  assert.equal(saved.json.layers.find((l) => l.id === 'work').enabled, false);

  const reread = await request('GET', '/api/settings');
  assert.equal(reread.json.settings.memory.work.storage, 'disabled');

  const invalid = await request('POST', '/api/settings', { memory: { shortTerm: { maxMessages: 0 } } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /whole number/);

  const forbidden = await request('POST', '/api/settings', { memory: { profile: { storage: 'disabled' } } });
  assert.equal(forbidden.status, 400, 'the profile cannot be switched off: it goes into every request');
});

test('a DeepSeek failure returns its message without leaking internals', async (t) => {
  const failing = fakeClient(() => {
    throw new DeepSeekError('rate_limited', 'DeepSeek API is rate limiting requests.', {
      status: 429, retryAfterSeconds: 7,
    });
  });
  const { request } = await startApp(t, failing);

  const { status, json, headers, text } = await request('POST', '/api/chat', { message: 'Hello' });
  assert.equal(status, 429);
  assert.equal(json.error, 'DeepSeek API is rate limiting requests.');
  assert.equal(json.code, 'rate_limited');
  assert.equal(headers.get('retry-after'), '7');
  assert.ok(!text.includes('at Object'), 'no stack trace');

  const history = await request('GET', '/api/history');
  assert.deepEqual(history.json.entries.map((e) => e.type), ['user', 'error']);
});

test('bad input is refused with a readable message', async (t) => {
  const { request } = await startApp(t);

  assert.equal((await request('POST', '/api/chat', { message: '' })).status, 400);
  assert.equal((await request('POST', '/api/chat', { message: 'x'.repeat(8001) })).status, 400);
  assert.equal((await request('POST', '/api/chat', '{oops')).status, 400);
  assert.equal((await request('GET', '/api/nothing-here')).status, 404);

  const huge = await request('POST', '/api/chat', { message: 'x'.repeat(200_000) });
  assert.equal(huge.status, 413);
});

test('an unexpected failure is reported as one plain sentence', async (t) => {
  const exploding = fakeClient(() => {
    throw new TypeError('internal detail /Users/someone/secret.js');
  });
  const { request, logger } = await startApp(t, exploding);

  const { status, json, text } = await request('POST', '/api/chat', { message: 'Hello' });
  assert.equal(status, 500);
  assert.equal(json.error, 'Something went wrong on the server. Please try again.');
  assert.ok(!text.includes('secret.js'), 'internals stay in the log');
  assert.ok(logger.lines.some((line) => line.includes('Unexpected failure')));
});

test('the browser is served the UI, with security headers and no data directory', async (t) => {
  const { request } = await startApp(t);

  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /ask your question, master/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  // The front end only ever talks to this app's own /api: no DeepSeek endpoint,
  // no Authorization header, and so nowhere for a key to appear.
  const script = await request('GET', '/app.js');
  assert.ok(!/deepseek\.com/.test(script.text), 'the browser never calls DeepSeek directly');
  assert.ok(!/Authorization|Bearer/.test(script.text), 'the browser sends no API credentials');

  assert.equal((await request('GET', '/../data/profile/profile.json')).status, 404);
});
