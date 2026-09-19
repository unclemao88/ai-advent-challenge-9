import express from 'express';

import { PUBLIC_DIR } from '../config/index.js';
import { Agent } from '../agent/agent.js';
import { ChatHistory } from '../history/chatHistory.js';
import { InvariantManager } from '../invariants/invariantManager.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { ProfileManager } from '../profile/profileManager.js';
import { TaskManager } from '../tasks/taskManager.js';
import { AppError } from '../utils/errors.js';
import {
  authenticate, errorHandler, rateLimit, requestId, requestLogger, sameOriginOnly, securityHeaders,
} from './middleware.js';
import { createAskRouter } from './routes/ask.js';
import { createHistoryRouter } from './routes/history.js';
import { createInvariantsRouter } from './routes/invariants.js';
import { createMemoryRouter } from './routes/memory.js';
import { createProfileRouter } from './routes/profile.js';
import { createTasksRouter } from './routes/tasks.js';
import { createConfigRouter, createHealthRouter } from './routes/system.js';

/**
 * Assemble the application: storage → profile, invariants, memory, tasks,
 * chat history → agent → HTTP.
 *
 * Every data file is created on first start if it is missing (never
 * overwritten): chat history, short-term / work / long-term memory, profile,
 * invariants, the tasks directory, and the memory storage configuration.
 *
 * Separate from server.js so tests can build the whole app around a temporary
 * data directory and a fake LLM client, without a port or an API key.
 *
 * @param {{config: ReturnType<import('../config/index.js').loadConfig>, llm: object,
 *          tokenCounter: import('../token/tokenCounter.js').TokenCounter, logger: object}} deps
 */
export async function createApp({ config, llm, tokenCounter, logger }) {
  const { dataDir } = config;

  const profiles = new ProfileManager({ dataDir, logger });
  const invariants = new InvariantManager({ dataDir, logger });
  const history = new ChatHistory({ dataDir, logger });
  const tasks = new TaskManager({ dataDir, logger, defaultMode: config.agent.defaultMode });
  const memory = new MemoryManager({
    dataDir, tokenCounter, logger, profiles,
    providers: config.memory.providers,
    shortTermMaxMessages: config.memory.shortTermMaxMessages,
  });

  for (const store of [profiles, invariants, history]) {
    if (!(await store.init())) logger.info('data.file_created', { location: store.location });
  }
  const { recovered } = await tasks.init();
  await memory.init();
  logger.info('data.ready', { dataDir, recoveredTasks: recovered.length });

  const agent = new Agent({
    llm, memory, profiles, invariants, tasks, history, tokenCounter, logger, options: config.agent,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.security.trustProxy);
  app.use(securityHeaders);

  const api = express.Router();
  api.use(requestId);
  api.use(requestLogger(logger));
  api.use(createHealthRouter({ startedAt: Date.now() }));
  api.use(authenticate(config.security.authToken));
  api.use(sameOriginOnly);
  api.use(express.json({ limit: '256kb', strict: true }));

  const llmLimiter = rateLimit({ perMinute: config.security.rateLimitPerMinute });
  const deps = {
    agent, memory, profiles, invariants, tasks, history, llm, tokenCounter, config, llmLimiter,
  };
  api.use(createAskRouter(deps));
  api.use(createHistoryRouter(deps));
  api.use(createProfileRouter(deps));
  api.use(createInvariantsRouter(deps));
  api.use(createMemoryRouter(deps));
  api.use(createTasksRouter(deps));
  api.use(createConfigRouter(deps));
  api.use((req, res, next) => next(new AppError(404, 'Unknown API endpoint.', 'not_found')));

  app.use('/api', api);
  // Only public/ is served; data/, src/ and .env are never reachable.
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html', dotfiles: 'deny', setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));
  app.use((req, res, next) => next(new AppError(404, 'Not found.', 'not_found')));
  app.use(errorHandler(logger));

  return { app, agent, memory, profiles, invariants, tasks, history };
}
