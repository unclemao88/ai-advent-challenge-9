import path from 'node:path';
import express from 'express';

import { PUBLIC_DIR } from './config.js';
import { Agent } from './agent/agent.js';
import { MemoryManager } from './agent/memoryManager.js';
import { DeepSeekError } from './api/deepseekClient.js';
import { SettingsStore } from './settings/settingsStore.js';
import { HttpError } from './utils/httpError.js';
import { createChatRouter } from './routes/chat.js';
import { createProfileRouter } from './routes/profile.js';
import { createMemoryRouter } from './routes/memory.js';
import { createSettingsRouter } from './routes/settings.js';
import { createStatusRouter } from './routes/status.js';

/**
 * Assemble the application: settings → memory → agent → HTTP routes.
 *
 * Kept apart from server.js so tests can build a full app around a temporary
 * data directory and a fake DeepSeek client, without opening a real port or
 * needing an API key.
 *
 * @param {{dataDir: string, client: object, logger?: Console, systemPrompt?: string}} options
 */
export async function createApp({ dataDir, client, logger = console, systemPrompt }) {
  // Creates data/settings.json and the layer directories on first start.
  const settingsStore = new SettingsStore({ file: path.join(dataDir, 'settings.json'), logger });
  const settings = await settingsStore.load();

  const memory = new MemoryManager({ dataDir, settings: settings.memory, logger });
  await memory.init();

  const agent = new Agent({ client, memory, systemPrompt });

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  // Requests are small by definition: a question, a profile or a memory edit.
  app.use('/api', express.json({ limit: '128kb' }));
  app.use('/api',
    createChatRouter({ agent, memory }),
    createProfileRouter({ agent, memory }),
    createMemoryRouter({ agent, memory }),
    createSettingsRouter({ agent, memory, settingsStore }),
    createStatusRouter({ client }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.', code: 'not_found' }));

  // Only the public directory is served; data/ and src/ are never reachable.
  app.use(express.static(PUBLIC_DIR));
  app.use(createErrorHandler(logger));

  return { app, agent, memory, settingsStore };
}

function securityHeaders(req, res, next) {
  res.set({
    // No inline scripts, no third-party anything: chat content can never run.
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
}

/**
 * Expected failures carry a message meant for the user. Anything else is a bug:
 * logged in full here, reported to the browser as one plain sentence, so no
 * stack trace, file path or configuration ever leaks out.
 */
function createErrorHandler(logger) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof DeepSeekError) {
      logger.warn(`DeepSeek ${err.code}: ${err.message}`);
      if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'invalid_json' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'The request body is too large.', code: 'body_too_large' });
    }

    logger.error(`Unexpected failure on ${req.method} ${req.path}:`, err);
    return res.status(500).json({ error: 'Something went wrong on the server. Please try again.', code: 'internal' });
  };
}
