import { Router } from 'express';

import { MAX_MESSAGE_CHARS } from '../config.js';
import { HttpError } from '../utils/httpError.js';

/**
 * POST /api/chat             { message } → answer, stored entries, token counts
 * GET  /api/history          the full conversation log, for restoring the chat
 * POST /api/context/preview  { message } → counts for a draft, without sending
 */
export function createChatRouter({ agent, memory }) {
  const router = Router();

  router.post('/chat', async (req, res) => {
    res.json(await agent.ask(req.body?.message));
  });

  // The server is the source of truth for the chat: the browser renders
  // whatever this returns on every page load, so history survives a reload
  // (and shows up in a second tab) without any browser-side storage.
  router.get('/history', async (req, res) => {
    const [entries, { tokenCounts }] = await Promise.all([
      memory.conversation.getEntries(),
      agent.prepareRequest(),
    ]);
    res.json({
      entries,
      storage: memory.conversation.storageMode,
      persistent: memory.conversation.persistent,
      tokens: tokenCounts,
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
    res.json({ tokens: tokenCounts, ...(req.body?.includeMessages === true ? { messages: context.messages } : {}) });
  });

  return router;
}
