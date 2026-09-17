import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The project root: the directory holding package.json. */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/** Longest question the agent accepts, in characters. The UI enforces the same. */
export const MAX_MESSAGE_CHARS = 8000;

/**
 * Read the runtime configuration from the environment, once, in one place.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return {
    port: positiveInt(env.PORT) ?? 3000,
    // Loopback by default: put a reverse proxy in front to expose the app.
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    deepseek: {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_API_URL || undefined,
      model: env.DEEPSEEK_MODEL || undefined,
      timeoutMs: positiveInt(env.DEEPSEEK_TIMEOUT_MS),
    },
  };
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
