import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../config.js';
import { TOKENIZER } from '../agent/tokenCounter.js';

/**
 * GET /api/status — lets the UI warn about a missing API key before the first
 * question. Reports only *whether* a key is set, never the key.
 */
export function createStatusRouter({ client }) {
  const router = Router();

  router.get('/status', (req, res) => {
    res.json({
      deepseek: { configured: client.configured, model: client.model },
      tokenizer: TOKENIZER,
      limits: { maxMessageChars: MAX_MESSAGE_CHARS },
    });
  });

  return router;
}
