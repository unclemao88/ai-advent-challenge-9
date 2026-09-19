import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT_DIR, loadConfig, validateConfig } from '../src/config/index.js';

test('defaults: port 3015, data/ in the application directory, manual mode, JSON storage', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3015);
  assert.equal(config.dataDir, path.join(ROOT_DIR, 'data'));
  assert.equal(config.llm.model, 'deepseek-chat');
  assert.equal(config.agent.defaultMode, 'manual');
  assert.deepEqual(config.memory.providers, { shortTerm: 'json', work: 'json', longTerm: 'json' });
});

test('each memory layer takes its own storage provider from the environment', () => {
  const config = loadConfig({ STORAGE_SHORT_TERM: 'memory', STORAGE_WORK: 'json', STORAGE_LONG_TERM: 'memory' });
  assert.deepEqual(config.memory.providers, { shortTerm: 'memory', work: 'json', longTerm: 'memory' });
});

test('invalid values are reported, never silently replaced', () => {
  const config = loadConfig({ PORT: 'abc', DEEPSEEK_TIMEOUT_MS: '-5', STORAGE_WORK: 'redis', DEEPSEEK_BASE_URL: 'ftp://x', DEEPSEEK_API_KEY: 'sk-x' });
  const { errors } = validateConfig(config);
  assert.equal(errors.length, 4);
  assert.match(errors.join('\n'), /PORT: must be a whole number/);
  assert.match(errors.join('\n'), /STORAGE_WORK: must be one of: json, memory/);
  assert.match(errors.join('\n'), /DEEPSEEK_BASE_URL: must be an http\(s\) URL/);
});

test('a missing API key is a warning; the summary never contains the key', () => {
  const missing = validateConfig(loadConfig({ DEEPSEEK_API_KEY: 'your_api_key_here' }));
  assert.equal(missing.errors.length, 0);
  assert.match(missing.warnings[0], /DEEPSEEK_API_KEY is not set/);
  assert.equal(missing.summary.apiKeyConfigured, false);

  const secret = 'sk-live-0123456789abcdef';
  const ok = validateConfig(loadConfig({ DEEPSEEK_API_KEY: secret, DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }));
  assert.equal(ok.summary.apiKeyConfigured, true);
  assert.equal(ok.summary.baseUrlHost, 'api.deepseek.com');
  assert.ok(!JSON.stringify(ok).includes(secret));
});

test('the server refuses to start with invalid configuration and says why, without secrets', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT_DIR, 'src/server.js')], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: 'not-a-port', DEEPSEEK_API_KEY: 'sk-secret-should-not-appear', LOG_DIR: 'off' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(out.status, 1);
  const logs = `${out.stdout}${out.stderr}`;
  assert.match(logs, /"event":"config.invalid"/);
  assert.match(logs, /PORT: must be a whole number/);
  assert.ok(!logs.includes('sk-secret-should-not-appear'));
});
