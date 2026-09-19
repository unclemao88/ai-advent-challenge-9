import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../../config/index.js';
import { asyncRoute } from '../middleware.js';
import { MODES, publicTask } from '../../agent/stateMachine.js';
import { rejectUnknownFields, requireEnum, requireObject, requireText } from '../../utils/validate.js';

/**
 * POST   /api/ask              ask: starts a task, or gives input to the active one
 * GET    /api/conversation     the whole conversation log, the active task and token counts
 * DELETE /api/conversation     clear the visible log (memory layers are not touched)
 * GET    /api/token-count      token counts of every layer and of the next request (?message=draft)
 * POST   /api/token-count      the same for a long draft; {includeText: true} adds the exact context
 */
export function createAskRouter({ agent, conversation, tasks, llmLimiter }) {
  const router = Router();

  router.post('/ask', llmLimiter, asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'mode']);
    const message = requireText(body.message, 'The question', { max: MAX_MESSAGE_CHARS });
    const mode = requireEnum(body.mode, 'mode', MODES, { optional: true });
    res.json(await agent.ask({ message, mode, requestId: req.id }));
  }));

  router.get('/conversation', asyncRoute(async (req, res) => {
    const [messages, task, tokens] = await Promise.all([conversation.list(), tasks.getActiveTask(), agent.tokenSummary()]);
    res.json({ messages, task: publicTask(task), busy: task ? tasks.isBusy(task.id) : false, tokens });
  }));

  router.delete('/conversation', asyncRoute(async (req, res) => {
    await conversation.clear();
    res.json({ messages: [] });
  }));

  router.get('/token-count', asyncRoute(async (req, res) => {
    const draft = requireText(req.query.message ?? '', 'The question', { min: 0, max: MAX_MESSAGE_CHARS });
    res.json({ tokens: await agent.tokenSummary(draft) });
  }));

  router.post('/token-count', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'includeText']);
    const draft = requireText(body.message ?? '', 'The question', { min: 0, max: MAX_MESSAGE_CHARS });
    const tokens = await agent.tokenSummary(draft);
    if (body.includeText !== true) return res.json({ tokens });

    const { context } = await agent.preview(draft);
    const { turns, ...sections } = context.sections;
    return res.json({ tokens, droppedTurns: context.droppedTurns, sections, turns: turns.length, messages: context.messages });
  }));

  return router;
}
