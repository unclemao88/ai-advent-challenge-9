import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../config.js';
import { HttpError } from '../utils/httpError.js';

/**
 * POST /api/chat             { message } → answer, stored messages, token counts
 * GET  /api/history          the conversation held in short-term memory
 * POST /api/context/preview  { message, includeMessages? } → counts for a draft
 */
export function createChatRouter({ agent, memory }) {
  const router = Router();

  router.post('/chat', async (req, res) => {
    res.json(await agent.ask(req.body?.message));
  });

  // The server's short-term memory is the source of truth for the chat; the
  // browser renders whatever this returns on every page load.
  router.get('/history', async (req, res) => {
    const layer = memory.shortTerm;
    res.json({
      messages: await layer.getMessages(),
      storage: layer.storageMode,
      enabled: layer.enabled,
      maxMessages: layer.maxMessages,
    });
  });

  // What the next request would cost if the draft were sent now. Built by the
  // same code path as /api/chat, so the preview is the real context.
  router.post('/context/preview', async (req, res) => {
    const draft = req.body?.message ?? '';
    if (typeof draft !== 'string' || draft.length > MAX_MESSAGE_CHARS) {
      throw new HttpError(400, `"message" must be a string of at most ${MAX_MESSAGE_CHARS} characters.`, 'invalid_message');
    }
    const { context, tokenCounts } = await agent.prepareRequest(draft);
    res.json({ tokenCounts, ...(req.body?.includeMessages === true ? { messages: context.messages } : {}) });
  });

  return router;
}
