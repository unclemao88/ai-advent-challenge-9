import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';

import { ROOT_DIR, loadConfig, validateConfig } from './config/index.js';
import { createLlmClient } from './api/deepseek.js';
import { TokenCounter } from './token/tokenCounter.js';
import { createLogger } from './utils/logger.js';

// Local development reads .env from the project root with Node's own env-file
// parser (no dependency); variables that are already set take precedence. In
// production (the systemd unit sets NODE_ENV=production) the configuration
// comes only from the unit and /etc/deepseek-app.env, so a stray .env in the
// code tree is ignored.
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile(path.join(ROOT_DIR, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`Could not read .env: ${err.message}\n`);
      process.exit(1);
    }
  }
}

// Express is the only runtime dependency. Without node_modules the import
// below fails with a stack trace that says nothing useful in a service log,
// so it is loaded here and the real cause is reported instead.
let createApp;
try {
  ({ createApp } = await import('./http/app.js'));
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  process.stderr.write(`Dependencies are not installed in ${ROOT_DIR} (${err.message}).\n`
    + `Install them as the owner of that directory and restart the service:\n`
    + `  cd ${ROOT_DIR} && npm ci --omit=dev\n`);
  process.exit(1);
}

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, logDir: config.logDir, bindings: { service: 'deepseek-app-day15' } });

// Validate before anything touches the disk or the network. Secrets are never logged.
const checked = validateConfig(config);
for (const warning of checked.warnings) logger.warn('config.warning', { message: warning });
if (checked.errors.length) {
  logger.error('config.invalid', { errors: checked.errors, hint: 'Fix these variables in the environment (.env locally, /etc/deepseek-app.env or the unit in production).' });
  await logger.close();
  process.exit(1);
}
logger.info('config.validated', checked.summary);

if (process.getuid?.() === 0 && config.nodeEnv === 'production') {
  logger.error('app.refusing_root', { hint: 'Run the service as the dedicated user deepseek-app, never as root.' });
  process.exit(1);
}

process.on('unhandledRejection', (reason) => logger.error('process.unhandled_rejection', { error: reason }));
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { error: err });
  logger.close().finally(() => process.exit(1));
});

const llm = createLlmClient({ ...config.llm, logger });
const tokenCounter = await TokenCounter.create({ directory: config.tokenizerDir, model: llm.model, logger });

logger.info('app.starting', {
  node: process.version,
  env: config.nodeEnv,
  pid: process.pid,
  user: process.env.USER ?? process.getuid?.(),
  dataDir: config.dataDir,
  logFile: logger.logFile,
  provider: llm.provider,
  model: llm.model,
  endpointHost: new URL(llm.endpoint).host,
  apiKeyConfigured: llm.configured,
  tokenizer: tokenCounter.info.method,
  authRequired: Boolean(config.security.authToken),
});

// The data directory must exist and be writable before anything else. Under
// systemd the code tree is read-only, so the service cannot create it itself:
// say exactly what to do instead of failing later with an opaque error.
try {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await access(config.dataDir, fsConstants.W_OK);
} catch (err) {
  logger.error('app.data_dir_unusable', {
    error: err,
    dataDir: config.dataDir,
    hint: `Create it and give it to the service user, then start again: `
      + `install -d -o deepseek-app -g deepseek-app -m 700 ${config.dataDir}`,
  });
  await logger.close();
  process.exit(1);
}

let built;
try {
  built = await createApp({ config, llm, tokenCounter, logger });
} catch (err) {
  logger.error('app.init_failed', {
    error: err,
    hint: `Check that ${config.dataDir} exists and is writable by user ${process.env.USER ?? process.getuid?.()}.`,
  });
  await logger.close();
  process.exit(1);
}

const { app, tasks } = built;
const server = app.listen(config.port, config.host, () => {
  logger.info('app.listening', { host: config.host, port: config.port, url: `http://${config.host}:${config.port}` });
});
server.requestTimeout = 15 * 60_000; // Auto mode may run several DeepSeek calls in one request.
server.headersTimeout = 60_000;

server.on('error', async (err) => {
  logger.error('app.server_error', { error: err, hint: err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use.` : undefined });
  await logger.close();
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('app.shutdown_started', { signal, runningTasks: tasks.busyCount });

  const force = setTimeout(async () => {
    logger.error('app.shutdown_timeout', { runningTasks: tasks.busyCount });
    await logger.close();
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();

  // Stop accepting connections; requests in flight (with their memory and
  // task writes) finish first.
  server.close();
  server.closeIdleConnections();
  while (tasks.busyCount > 0) await new Promise((resolve) => setTimeout(resolve, 200));
  await new Promise((resolve) => {
    if (!server.listening) return resolve();
    return server.once('close', resolve);
  });

  logger.info('app.shutdown_complete', { signal });
  await logger.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
