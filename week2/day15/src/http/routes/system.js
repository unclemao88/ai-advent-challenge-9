import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../../config/index.js';
import { ALL_STATES, LIFECYCLE, MODES, STATE_ACTIONS, TRANSITIONS, WORK_STATES } from '../../agent/stateMachine.js';
import { DATA_FILES } from '../../persistence/dataPaths.js';

/**
 * GET /api/health   liveness (no authentication; reveals nothing)
 * GET /api/config   what the UI needs to know about this server. Never secrets:
 *                   the API key is reported only as configured or not.
 */
export function createHealthRouter({ startedAt }) {
  const router = Router();
  router.get('/health', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });
  return router;
}

export function createConfigRouter({ config, llm, tokenCounter, memory, agent, profiles, invariants, tasks, history }) {
  const router = Router();
  router.get('/config', (req, res) => {
    res.json({
      app: { name: 'DeepSeek Agent', day: 15, version: '1.0.0', port: config.port },
      llm: {
        provider: llm.provider,
        model: llm.model,
        apiKeyConfigured: llm.configured,
        endpointHost: safeHost(llm.endpoint),
        timeoutMs: llm.timeoutMs,
      },
      tokenizer: tokenCounter.info,
      storage: {
        ...memory.describeStorage(),
        fixed: {
          history: history.location,
          profile: profiles.location,
          invariants: invariants.location,
          tasks: tasks.location,
          activeTask: `data/${DATA_FILES.activeTask}`,
        },
      },
      agent: agent.options,
      stateMachine: {
        states: ALL_STATES, lifecycle: LIFECYCLE, workStates: WORK_STATES, transitions: TRANSITIONS, actions: STATE_ACTIONS, modes: MODES,
      },
      limits: { maxMessageChars: MAX_MESSAGE_CHARS, rateLimitPerMinute: config.security.rateLimitPerMinute },
      auth: { required: Boolean(config.security.authToken) },
    });
  });
  return router;
}

function safeHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}
