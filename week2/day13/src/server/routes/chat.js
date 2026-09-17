import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../../config.js';
import { asyncRoute } from '../middleware.js';
import { MODES, publicTask } from '../../state-machine/StateMachine.js';
import { rejectUnknownFields, requireEnum, requireObject, requireText } from '../../utils/validate.js';

/**
 * POST   /api/chat              ask (starts a task or gives input to the active one)
 * GET    /api/chat/history      the conversation, the active task and token counts
 * DELETE /api/chat/history      clear the conversation (short-term memory)
 * POST   /api/context/preview   token counts (and optionally the text) of the next request
 */
export function createChatRouter({ agent, memory, tasks, llmLimiter }) {
  const router = Router();

  router.post('/chat', llmLimiter, asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'mode']);
    const message = requireText(body.message, 'The question', { max: MAX_MESSAGE_CHARS });
    const mode = requireEnum(body.mode, 'mode', MODES, { optional: true });
    res.json(await agent.chat({ message, mode }));
  }));

  router.get('/chat/history', asyncRoute(async (req, res) => {
    const [messages, task, tokens] = await Promise.all([
      memory.getShortTermMemory(), tasks.getActiveTask(), agent.tokenSummary(),
    ]);
    res.json({ messages, task: publicTask(task), tokens });
  }));

  router.delete('/chat/history', asyncRoute(async (req, res) => {
    await memory.clearShortTermMemory();
    res.json({ messages: [], tokens: await agent.tokenSummary() });
  }));

  router.post('/context/preview', asyncRoute(async (req, res) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['message', 'includeText']);
    const draft = requireText(body.message ?? '', 'The question', { min: 0, max: MAX_MESSAGE_CHARS });
    const tokens = await agent.tokenSummary(draft);
    if (body.includeText !== true) return res.json({ tokens });

    const { context } = await agent.preview(draft);
    return res.json({
      tokens,
      droppedTurns: context.droppedTurns,
      messages: context.messages,
      sections: {
        system: context.sections.system,
        profile: context.sections.profile,
        longTerm: context.sections.longTerm,
        work: context.sections.work,
        shortTerm: context.sections.shortTerm,
        request: context.sections.request,
      },
    });
  }));

  return router;
}
