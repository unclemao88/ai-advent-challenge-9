import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config/index.js';
import { createApp } from '../src/http/app.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { ProfileManager } from '../src/profile/profileManager.js';
import { TokenCounter } from '../src/token/tokenCounter.js';
import { createMemoryLogger } from '../src/utils/logger.js';
import { mockReply } from '../scripts/mock-deepseek.js';

/** A fresh data directory, removed after the test. */
export async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deepseek-day14-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export const logger = () => createMemoryLogger();

/** The heuristic counter: fast and deterministic. */
export const estimateCounter = () => new TokenCounter();

/**
 * A stand-in for the DeepSeek client. No network, no API key. Records every call.
 * `handler(messages, callNumber)` returns a reply object (sent as JSON), a string, or throws.
 */
export function fakeLlm(handler = (messages) => mockReply(messages)) {
  const calls = [];
  return {
    provider: 'fake',
    model: 'fake-model',
    configured: true,
    endpoint: 'http://fake.invalid/chat/completions',
    timeoutMs: 1000,
    calls,
    async complete(messages, options) {
      calls.push({ messages: structuredClone(messages), options });
      const reply = await handler(messages, calls.length);
      return {
        content: typeof reply === 'string' ? reply : JSON.stringify(reply),
        model: 'fake-model',
        finishReason: 'stop',
        usage: { promptTokens: 111, completionTokens: 22, totalTokens: 133 },
      };
    },
  };
}

/** The state named in a request's [TASK STATE] block. */
export const requestedState = (messages) => messages.at(-1).content.match(/Current state: (\w+)/)?.[1];

export function testConfig(dataDir, env = {}) {
  return loadConfig({ DATA_DIR: dataDir, LOG_DIR: 'off', PORT: '0', ...env });
}

/** The whole application around a temporary directory. */
export async function buildApp(t, { dataDir, llm = fakeLlm(), env = {}, tokenCounter = estimateCounter() } = {}) {
  const dir = dataDir ?? (await tempDir(t));
  const log = logger();
  const config = testConfig(dir, env);
  const built = await createApp({ config, llm, tokenCounter, logger: log });
  return { ...built, dataDir: dir, llm, logger: log, config };
}

export async function memoryManager(t, { dataDir, providers, shortTermMaxMessages } = {}) {
  const dir = dataDir ?? (await tempDir(t));
  const log = logger();
  const profiles = new ProfileManager({ dataDir: dir, logger: log });
  await profiles.init();
  const manager = new MemoryManager({ dataDir: dir, tokenCounter: estimateCounter(), logger: log, profiles, providers, shortTermMaxMessages });
  await manager.init();
  return manager;
}

/** Start an Express app on a random port; returns a small request helper. */
export async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;

  return async function request(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] ??= 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const response = await fetch(base + url, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
