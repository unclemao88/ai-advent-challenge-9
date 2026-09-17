import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root: the directory that holds package.json. */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/** Longest question accepted, in characters. The UI enforces the same limit. */
export const MAX_MESSAGE_CHARS = 8000;

/**
 * All runtime configuration, read from the environment in one place.
 * Every variable is documented in .env.example and README.md.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    nodeEnv,
    port: int(env.PORT, { min: 1, max: 65535 }) ?? 3013,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    logDir: env.LOG_DIR === 'off' ? null : path.resolve(ROOT_DIR, env.LOG_DIR || 'logs'),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL) ? env.LOG_LEVEL : 'info',
    tokenizerDir: path.resolve(ROOT_DIR, env.TOKENIZER_DIR || 'vendor/deepseek-tokenizer'),
    llm: {
      provider: env.LLM_PROVIDER || 'deepseek',
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_API_URL || undefined,
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
      timeoutMs: int(env.DEEPSEEK_TIMEOUT_MS, { min: 1000, max: 600_000 }),
      maxTokens: int(env.DEEPSEEK_MAX_TOKENS, { min: 1, max: 64_000 }),
      temperature: float(env.DEEPSEEK_TEMPERATURE, { min: 0, max: 2 }),
    },
    agent: {
      defaultMode: env.DEFAULT_MODE === 'auto' ? 'auto' : 'manual',
      maxAutoSteps: int(env.MAX_AUTO_STEPS, { min: 1, max: 50 }) ?? 8,
      maxValidationRetries: int(env.MAX_VALIDATION_RETRIES, { min: 0, max: 10 }) ?? 2,
      longTermContextTokens: int(env.LONG_TERM_CONTEXT_TOKENS, { min: 0, max: 100_000 }) ?? 4000,
      maxContextTokens: int(env.MAX_CONTEXT_TOKENS, { min: 2000, max: 1_000_000 }) ?? 100_000,
    },
    shortTermMaxMessages: int(env.SHORT_TERM_MAX_MESSAGES, { min: 2, max: 500 }) ?? 40,
    security: {
      // Optional shared secret. When set, every /api request must send it.
      authToken: env.APP_AUTH_TOKEN || null,
      rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, { min: 1, max: 10_000 }) ?? 30,
      trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
    },
    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, { min: 1000, max: 600_000 }) ?? 90_000,
  };
}

function int(value, { min, max }) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function float(value, { min, max }) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
