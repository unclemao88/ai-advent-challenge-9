import express from 'express';

import { PUBLIC_DIR } from '../config.js';
import { Agent } from '../agent/Agent.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { ProfileManager } from '../profile/ProfileManager.js';
import { TaskManager } from '../tasks/TaskManager.js';
import { AppError } from '../utils/errors.js';
import {
  authenticate, errorHandler, rateLimit, requestLogger, sameOriginOnly, securityHeaders,
} from './middleware.js';
import { createChatRouter } from './routes/chat.js';
import { createProfileRouter } from './routes/profile.js';
import { createMemoryRouter } from './routes/memory.js';
import { createTasksRouter } from './routes/tasks.js';
import { createConfigRouter, createHealthRouter } from './routes/system.js';

/**
 * Assemble the application: storage → memory, profile, tasks → agent → HTTP.
 *
 * Separate from index.js so tests can build the whole app around a temporary
 * data directory and a fake LLM client, without a port or an API key.
 *
 * @param {{config: ReturnType<import('../config.js').loadConfig>, llm: object,
 *          tokenCounter: import('../tokens/TokenCounter.js').TokenCounter, logger: object}} deps
 */
export async function createApp({ config, llm, tokenCounter, logger }) {
  const memory = new MemoryManager({
    dataDir: config.dataDir, tokenCounter, logger, shortTermMaxMessages: config.shortTermMaxMessages,
  });
  await memory.init();

  const profiles = new ProfileManager({ dataDir: config.dataDir, logger });
  await profiles.init();

  const tasks = new TaskManager({ dataDir: config.dataDir, logger, defaultMode: config.agent.defaultMode });
  await tasks.init();

  const agent = new Agent({ llm, memory, profiles, tasks, tokenCounter, logger, options: config.agent });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.security.trustProxy);
  app.use(securityHeaders);

  const api = express.Router();
  api.use(requestLogger(logger));
  api.use(createHealthRouter({ startedAt: Date.now() }));
  api.use(authenticate(config.security.authToken));
  api.use(sameOriginOnly);
  api.use(express.json({ limit: '256kb', strict: true }));

  const llmLimiter = rateLimit({ perMinute: config.security.rateLimitPerMinute });
  const deps = { agent, memory, profiles, tasks, llm, tokenCounter, config, llmLimiter };
  api.use(createChatRouter(deps));
  api.use(createProfileRouter(deps));
  api.use(createMemoryRouter(deps));
  api.use(createTasksRouter(deps));
  api.use(createConfigRouter(deps));
  api.use((req, res, next) => next(new AppError(404, 'Unknown API endpoint.', 'not_found')));

  app.use('/api', api);
  // Only public/ is served; data/, logs/, src/ and .env are never reachable.
  // `no-cache` still uses ETags (a cheap 304), but an update is picked up on the next load.
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html', dotfiles: 'deny', setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));
  app.use((req, res, next) => next(new AppError(404, 'Not found.', 'not_found')));
  app.use(errorHandler(logger));

  return { app, agent, memory, profiles, tasks };
}
