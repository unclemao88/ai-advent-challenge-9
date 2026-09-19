import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../../config/index.js';
import { asyncRoute } from '../middleware.js';
import { MODES } from '../../agent/stateMachine.js';
import { rejectUnknownFields, requireEnum, requireObject, requireText } from '../../utils/validate.js';

/**
 * POST /api/ask              ask: starts a task, or gives input to the active one
 * GET  /api/token-counts     token counts of every memory layer and of the complete next request (?message=draft)
 * POST /api/token-counts     the same for a long draft; {includeText: true} adds the exact messages that would be sent
 */
export function createAskRouter({ agent, llmLimiter }) {
  const router = Router();

  router.post('/ask', llmLimiter, asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'mode']);
    const message = requireText(body.message, 'The question', { max: MAX_MESSAGE_CHARS });
    const mode = requireEnum(body.mode, 'mode', MODES, { optional: true });
    res.json(await agent.ask({ message, mode, requestId: req.id }));
  }));

  router.get('/token-counts', asyncRoute(async (req, res) => {
    const draft = requireText(req.query.message ?? '', 'The question', { min: 0, max: MAX_MESSAGE_CHARS });
    res.json({ tokens: await agent.tokenSummary(draft) });
  }));

  router.post('/token-counts', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'includeText']);
    const draft = requireText(body.message ?? '', 'The question', { min: 0, max: MAX_MESSAGE_CHARS });
    const tokens = await agent.tokenSummary(draft);
    if (body.includeText !== true) return res.json({ tokens });

    const { context } = await agent.preview(draft);
    const { turns, ...sections } = context.sections;
    return res.json({
      tokens, order: context.order, droppedTurns: context.droppedTurns, sections, turns: turns.length, messages: context.messages,
    });
  }));

  return router;
}
