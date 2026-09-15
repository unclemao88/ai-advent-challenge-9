import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A fresh data directory, removed after the test. */
export async function tempDataDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deepseek-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Swallows warnings the code under test logs on purpose, but records them. */
export function quietLogger() {
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  return { lines, log: record, warn: record, error: record, info: record };
}

/**
 * A stand-in for DeepSeekClient. Records every message array it is sent and
 * answers with `reply(messages)`, or throws what `reply` throws.
 */
export function fakeClient(reply = () => 'Fake answer.') {
  const calls = [];
  return {
    model: 'fake-model',
    configured: true,
    calls,
    async send(messages) {
      calls.push(structuredClone(messages));
      const content = await reply(messages);
      return {
        content,
        model: 'fake-model',
        finishReason: 'stop',
        usage: { promptTokens: 123, completionTokens: 45, totalTokens: 168 },
      };
    },
  };
}

/** Start an Express app on a random port. */
export async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return async function request(method, url, body) {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
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
