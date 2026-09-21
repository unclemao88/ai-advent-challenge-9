import path from 'node:path';

import { ROOT_DIR, loadConfig } from '../config.js';
import { createLlmClient } from '../deepseek/index.js';
import { TokenCounter } from '../tokens/TokenCounter.js';
import { createLogger } from '../utils/logger.js';

// Local development reads .env from the project root. Variables that are
// already set (systemd's Environment= and EnvironmentFile=) take precedence.
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    process.stderr.write(`Could not read .env: ${err.message}\n`);
    process.exit(1);
  }
}

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, logDir: config.logDir, bindings: { service: 'deepseek-app-day13' } });

process.on('unhandledRejection', (reason) => logger.error('process.unhandled_rejection', { error: reason }));
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { error: err });
  logger.close().finally(() => process.exit(1));
});

// app.js is imported here, not at the top, so that a missing dependency is
// reported as one actionable line instead of a module-resolution stack trace.
// This is the first thing that needs node_modules; everything above is
// dependency-free, so the message is always reached.
let createApp;
try {
  ({ createApp } = await import('./app.js'));
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  const missing = err.message.match(/package '([^']+)'|module '([^']+)'/)?.slice(1).find(Boolean) ?? 'a dependency';
  logger.error('app.dependencies_missing', {
    missing,
    hint: `Install the dependencies: cd ${ROOT_DIR} && npm ci --omit=dev`,
    error: err,
  });
  await logger.close();
  process.exit(1);
}

const llm = createLlmClient(config.llm);
const tokenCounter = await TokenCounter.create({ directory: config.tokenizerDir, model: llm.model, logger });

logger.info('app.starting', {
  node: process.version,
  env: config.nodeEnv,
  pid: process.pid,
  dataDir: config.dataDir,
  logFile: logger.logFile,
  provider: llm.provider,
  model: llm.model,
  apiKeyConfigured: llm.configured,
  tokenizer: tokenCounter.info.method,
  authRequired: Boolean(config.security.authToken),
});
if (!llm.configured) {
  logger.warn('app.api_key_missing', { hint: 'Set DEEPSEEK_API_KEY. The UI loads, but questions fail until it is set.' });
}

let built;
try {
  built = await createApp({ config, llm, tokenCounter, logger });
} catch (err) {
  const denied = ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
  logger.error('app.init_failed', {
    error: err,
    hint: denied
      // The usual cause: the directories were created by root, so the service user cannot write.
      ? `${config.dataDir} is not writable by this process (running as uid ${process.getuid?.() ?? '?'}). Fix with: `
        + `chown -R deepseek-app:deepseek-app ${config.dataDir}${config.logDir ? ` ${config.logDir}` : ''}`
        + ' (a data directory outside the application also needs ReadWritePaths= in the systemd unit).'
      : `Check that ${config.dataDir} exists and is writable by the service user.`,
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

  // Stop accepting connections; idle keep-alive sockets are closed now, and
  // requests in flight (with their memory and task writes) finish first.
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
