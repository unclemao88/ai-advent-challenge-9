'use strict';

const path = require('path');
const loadEnvFile = require('./utils/loadEnv');

const ROOT = path.join(__dirname, '..');

/**
 * The one place the environment is read. `.env` in the project root is loaded
 * for local development; variables already in the real environment (systemd's
 * EnvironmentFile, an exported shell variable) win over it.
 *
 * @param {object} [env] Defaults to process.env (after loading .env).
 */
function loadConfig(env) {
  if (!env) loadEnvFile(path.join(ROOT, '.env'));
  const e = env || process.env;

  const model = trimmed(e.DEEPSEEK_MODEL) || 'deepseek-chat';
  return {
    root: ROOT,
    publicDir: path.join(__dirname, 'public'),
    port: positiveInt(e.PORT, 3000),
    host: trimmed(e.HOST) || '127.0.0.1',
    // ./data next to the project from a checkout; a packaged install points it
    // at a writable state directory, because the code is deployed read-only.
    dataDir: trimmed(e.DATA_DIR) ? path.resolve(e.DATA_DIR) : path.join(ROOT, 'data'),
    maxQuestionChars: positiveInt(e.MAX_QUESTION_CHARS, 8000),
    deepseek: {
      apiKey: trimmed(e.DEEPSEEK_API_KEY),
      apiUrl: trimmed(e.DEEPSEEK_API_URL) || 'https://api.deepseek.com',
      model: model,
      summaryModel: trimmed(e.DEEPSEEK_SUMMARY_MODEL) || model,
      timeoutMs: positiveInt(e.DEEPSEEK_TIMEOUT_MS, 60000)
    }
  };
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = loadConfig;
