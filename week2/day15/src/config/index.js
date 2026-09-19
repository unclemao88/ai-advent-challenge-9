import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root: the directory that holds package.json. */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/** Longest question accepted, in characters. The UI enforces the same limit. */
export const MAX_MESSAGE_CHARS = 8000;
export const DEFAULT_PORT = 3015;

// The value shipped in .env.example. It counts as "not configured".
const PLACEHOLDER_KEYS = new Set(['', 'your_api_key_here', 'sk-your-key-here', 'changeme']);

/**
 * All runtime configuration, read from the environment in one place.
 * Every variable is documented in .env.example and README.md.
 *
 * A value that is present but invalid (PORT=abc, DEEPSEEK_TIMEOUT_MS=-5) is
 * never silently replaced: it is reported in `problems`, and
 * `validateConfig()` decides whether the server may start.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const read = { int: intReader(env, problems), float: floatReader(env, problems), oneOf: oneOfReader(env, problems) };
  const nodeEnv = env.NODE_ENV || 'development';

  const config = {
    nodeEnv,
    port: read.int('PORT', { min: 0, max: 65535 }) ?? DEFAULT_PORT,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    logDir: env.LOG_DIR && env.LOG_DIR !== 'off' ? path.resolve(ROOT_DIR, env.LOG_DIR) : null,
    logLevel: read.oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error']) ?? 'info',
    tokenizerDir: path.resolve(ROOT_DIR, env.TOKENIZER_DIR || 'vendor/deepseek-tokenizer'),
    llm: {
      provider: read.oneOf('LLM_PROVIDER', ['deepseek']) ?? 'deepseek',
      apiKey: env.DEEPSEEK_API_KEY,
      // DEEPSEEK_API_URL is the name earlier days used; both are accepted.
      baseUrl: env.DEEPSEEK_BASE_URL || env.DEEPSEEK_API_URL || undefined,
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      timeoutMs: read.int('DEEPSEEK_TIMEOUT_MS', { min: 1000, max: 600_000 }),
      maxTokens: read.int('DEEPSEEK_MAX_TOKENS', { min: 1, max: 64_000 }),
      temperature: read.float('DEEPSEEK_TEMPERATURE', { min: 0, max: 2 }),
    },
    agent: {
      defaultMode: read.oneOf('DEFAULT_MODE', ['manual', 'auto']) ?? 'manual',
      maxAutoSteps: read.int('MAX_AUTO_STEPS', { min: 1, max: 50 }) ?? 8,
      maxValidationRetries: read.int('MAX_VALIDATION_RETRIES', { min: 0, max: 10 }) ?? 2,
      maxInvariantRevisions: read.int('MAX_INVARIANT_REVISIONS', { min: 0, max: 5 }) ?? 1,
      maxProfileRevisions: read.int('MAX_PROFILE_REVISIONS', { min: 0, max: 5 }) ?? 1,
      longTermContextTokens: read.int('LONG_TERM_CONTEXT_TOKENS', { min: 0, max: 100_000 }) ?? 2000,
      maxContextTokens: read.int('MAX_CONTEXT_TOKENS', { min: 2000, max: 1_000_000 }) ?? 100_000,
    },
    memory: {
      shortTermMaxMessages: read.int('SHORT_TERM_MAX_MESSAGES', { min: 2, max: 500 }) ?? 30,
      // Initial storage provider per layer; the UI can change it later (data/config/memory-storage.json).
      providers: {
        shortTerm: read.oneOf('STORAGE_SHORT_TERM', ['json', 'memory']) ?? 'json',
        work: read.oneOf('STORAGE_WORK', ['json', 'memory']) ?? 'json',
        longTerm: read.oneOf('STORAGE_LONG_TERM', ['json', 'memory']) ?? 'json',
      },
    },
    security: {
      // Optional shared secret. When set, every /api request must send it.
      authToken: env.APP_AUTH_TOKEN || null,
      rateLimitPerMinute: read.int('RATE_LIMIT_PER_MINUTE', { min: 1, max: 10_000 }) ?? 30,
      trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
    },
    shutdownTimeoutMs: read.int('SHUTDOWN_TIMEOUT_MS', { min: 1000, max: 600_000 }) ?? 90_000,
  };
  if (env.DEEPSEEK_BASE_URL || env.DEEPSEEK_API_URL) {
    try {
      const url = new URL(config.llm.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    } catch {
      problems.push({ name: env.DEEPSEEK_BASE_URL ? 'DEEPSEEK_BASE_URL' : 'DEEPSEEK_API_URL', message: 'must be an http(s) URL' });
    }
  }
  Object.defineProperty(config, 'problems', { value: problems, enumerable: false });
  return config;
}

/**
 * Decide whether the configuration is usable. Never includes secret values.
 *
 *   errors    the server must not start (an invalid PORT, an unusable base URL, an invalid number)
 *   warnings  it starts, but something needs attention (no API key: the UI loads, questions fail)
 *
 * @returns {{errors: string[], warnings: string[], summary: object}}
 */
export function validateConfig(config) {
  const errors = config.problems.map((p) => `${p.name}: ${p.message}`);
  const warnings = [];
  const keyConfigured = typeof config.llm.apiKey === 'string' && !PLACEHOLDER_KEYS.has(config.llm.apiKey.trim());
  if (!keyConfigured) warnings.push('DEEPSEEK_API_KEY is not set. The UI loads, but questions fail until it is configured.');
  if (config.nodeEnv === 'production' && config.host === '0.0.0.0' && !config.security.authToken) {
    warnings.push('Listening on all interfaces without APP_AUTH_TOKEN. Restrict access with a firewall or set APP_AUTH_TOKEN.');
  }
  return {
    errors,
    warnings,
    summary: {
      nodeEnv: config.nodeEnv,
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
      model: config.llm.model,
      baseUrlHost: safeHost(config.llm.baseUrl),
      apiKeyConfigured: keyConfigured,
      storage: config.memory.providers,
      defaultMode: config.agent.defaultMode,
      authRequired: Boolean(config.security.authToken),
    },
  };
}

function safeHost(url) {
  if (!url) return 'api.deepseek.com';
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function present(env, name) {
  return env[name] !== undefined && env[name] !== '';
}

function intReader(env, problems) {
  return (name, { min, max }) => {
    if (!present(env, name)) return undefined;
    const n = Number(env[name]);
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    problems.push({ name, message: `must be a whole number from ${min} to ${max}` });
    return undefined;
  };
}

function floatReader(env, problems) {
  return (name, { min, max }) => {
    if (!present(env, name)) return undefined;
    const n = Number(env[name]);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    problems.push({ name, message: `must be a number from ${min} to ${max}` });
    return undefined;
  };
}

function oneOfReader(env, problems) {
  return (name, allowed) => {
    if (!present(env, name)) return undefined;
    if (allowed.includes(env[name])) return env[name];
    problems.push({ name, message: `must be one of: ${allowed.join(', ')}` });
    return undefined;
  };
}
