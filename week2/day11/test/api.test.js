import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { DeepSeekClient, DeepSeekError } from '../src/agent/deepseekClient.js';
import { countRequestTokens } from '../src/agent/tokenCounter.js';
import { tempDataDir, fakeClient, listen, quietLogger } from './helpers.js';

async function startApp(t, client = fakeClient()) {
  const dataDir = await tempDataDir(t);
  const { app } = await createApp({ dataDir, client, logger: quietLogger() });
  return { request: await listen(t, app), dataDir, client };
}

test('the page is served with the required form labels and security headers', async (t) => {
  const { request } = await startApp(t);
  const page = await request('GET', '/');

  assert.equal(page.status, 200);
  assert.match(page.text, /placeholder="ask your question, master"/);
  assert.match(page.text, />ask<\/button>/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('POST /api/chat answers, stores the exchange and reports the full context count', async (t) => {
  const { request, dataDir, client } = await startApp(t);

  const res = await request('POST', '/api/chat', { message: 'Explain Node.js' });
  assert.equal(res.status, 200);
  assert.equal(res.json.response, 'Fake answer.');
  assert.equal(res.json.request.content, 'Explain Node.js');
  assert.equal(res.json.reply.role, 'assistant');

  const counts = res.json.tokenCounts;
  for (const key of ['shortTerm', 'work', 'longTerm', 'currentContext']) assert.equal(typeof counts[key], 'number', key);
  assert.equal(counts.currentContext, countRequestTokens(client.calls[0]));
  assert.deepEqual(res.json.usage, { promptTokens: 123, completionTokens: 45, totalTokens: 168 });

  const history = await request('GET', '/api/history');
  assert.deepEqual(history.json.messages.map((m) => m.content), ['Explain Node.js', 'Fake answer.']);

  const file = JSON.parse(await readFile(path.join(dataDir, 'short-term/conversation.json'), 'utf8'));
  assert.equal(file.messages.length, 2, 'the conversation is on disk, so it survives a reload and a restart');
});

test('invalid chat requests are rejected with 400', async (t) => {
  const { request, client } = await startApp(t);

  assert.equal((await request('POST', '/api/chat', { message: '' })).status, 400);
  assert.equal((await request('POST', '/api/chat', {})).status, 400);
  assert.equal((await request('POST', '/api/chat', { message: 'x'.repeat(8001) })).status, 400);

  const badJson = await request('POST', '/api/chat', '{"message":');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.code, 'invalid_json');
  assert.equal(client.calls.length, 0);
});

test('a DeepSeek failure returns a useful error and keeps the conversation intact', async (t) => {
  let fail = false;
  const client = fakeClient(() => {
    if (fail) throw new DeepSeekError('rate_limited', 'DeepSeek API is rate limiting requests.', { status: 429, retryAfterSeconds: 7 });
    return 'First answer.';
  });
  const { request } = await startApp(t, client);

  await request('POST', '/api/chat', { message: 'First question' });
  fail = true;
  const res = await request('POST', '/api/chat', { message: 'task: should not be saved' });

  assert.equal(res.status, 429);
  assert.equal(res.json.code, 'rate_limited');
  assert.equal(res.headers.get('retry-after'), '7');

  const history = await request('GET', '/api/history');
  assert.deepEqual(history.json.messages.map((m) => m.content), ['First question', 'First answer.']);
  const memory = await request('GET', '/api/memory');
  assert.equal(memory.json.layers.find((l) => l.id === 'work').contents.task, '');
});

test('without an API key the server still runs and says the key is missing', async (t) => {
  const client = new DeepSeekClient({ apiKey: '', fetchImpl: () => assert.fail('no network call') });
  const { request } = await startApp(t, client);

  const status = await request('GET', '/api/status');
  assert.equal(status.json.deepseek.configured, false);

  const res = await request('POST', '/api/chat', { message: 'Hello?' });
  assert.equal(res.status, 503);
  assert.match(res.json.error, /DeepSeek API key is missing/);
});

test('the API key never appears in any response', async (t) => {
  const secret = 'sk-very-secret-key-123';
  const client = new DeepSeekClient({
    apiKey: secret,
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 401 }),
  });
  const { request } = await startApp(t, client);

  const responses = await Promise.all([
    request('GET', '/'),
    request('GET', '/app.js'),
    request('GET', '/api/status'),
    request('GET', '/api/settings'),
    request('GET', '/api/memory'),
    request('POST', '/api/chat', { message: 'hi' }),
  ]);
  for (const res of responses) assert.ok(!res.text.includes(secret));
});

test('GET /api/memory shows storage, contents and token counts for all three layers', async (t) => {
  const { request } = await startApp(t);
  await request('POST', '/api/chat', { message: 'task: Test the API\nmy name is Max' });

  const res = await request('GET', '/api/memory');
  assert.deepEqual(res.json.layers.map((l) => l.id), ['shortTerm', 'work', 'longTerm']);
  assert.ok(res.json.layers.every((l) => l.storage === 'json'));
  assert.equal(res.json.layers[1].contents.task, 'Test the API');
  assert.deepEqual(res.json.layers[2].contents.profile, { name: 'Max' });
  assert.ok(res.json.tokenCounts.work > 0 && res.json.tokenCounts.longTerm > 0 && res.json.tokenCounts.shortTerm > 0);
  assert.equal(res.json.tokenizer.exact, false);
});

test('POST /api/context/preview counts the draft inside the full context', async (t) => {
  const { request } = await startApp(t);
  const empty = await request('POST', '/api/context/preview', { message: '' });
  const draft = await request('POST', '/api/context/preview', { message: 'How do I create an Express server?', includeMessages: true });

  assert.ok(draft.json.tokenCounts.currentContext > empty.json.tokenCounts.currentContext);
  assert.equal(draft.json.tokenCounts.currentContext, countRequestTokens(draft.json.messages));
  assert.equal(empty.json.messages, undefined, 'messages only on request');
  assert.equal((await request('POST', '/api/context/preview', { message: 42 })).status, 400);
});

test('POST /api/memory/clear clears one layer; long-term needs confirmation', async (t) => {
  const { request } = await startApp(t);
  await request('POST', '/api/chat', { message: 'task: Keep me\nmy name is Max' });

  const cleared = await request('POST', '/api/memory/clear', { layer: 'shortTerm' });
  assert.equal(cleared.status, 200);
  assert.equal((await request('GET', '/api/history')).json.messages.length, 0);
  assert.equal(cleared.json.layers[1].contents.task, 'Keep me');

  const unconfirmed = await request('POST', '/api/memory/clear', { layer: 'longTerm' });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.code, 'confirmation_required');

  const confirmed = await request('POST', '/api/memory/clear', { layer: 'longTerm', confirm: true });
  assert.deepEqual(confirmed.json.layers[2].contents.profile, {});
  assert.equal(confirmed.json.layers[1].contents.task, 'Keep me');

  assert.equal((await request('POST', '/api/memory/clear', { layer: '../../etc' })).status, 400);
});

test('POST /api/settings switches storage modes and persists them in settings.json', async (t) => {
  const { request, dataDir } = await startApp(t);

  const bad = await request('POST', '/api/settings', { memory: { work: { storage: 'ftp' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_settings');

  const res = await request('POST', '/api/settings', {
    memory: { shortTerm: { storage: 'memory', maxMessages: 10 }, longTerm: { storage: 'disabled' } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.layers.map((l) => l.storage), ['memory', 'json', 'disabled']);

  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.memory, {
    shortTerm: { storage: 'memory', maxMessages: 10 },
    work: { storage: 'json' },
    longTerm: { storage: 'disabled' },
  });

  const settings = await request('GET', '/api/settings');
  assert.equal(settings.json.settings.memory.shortTerm.maxMessages, 10);
  assert.deepEqual(settings.json.storageModes.map((m) => m.mode), ['json', 'memory', 'disabled']);
});

test('unknown API routes return JSON 404', async (t) => {
  const { request } = await startApp(t);
  const res = await request('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'not_found');
});
