import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { publicTask } from '../../agent/stateMachine.js';

/**
 * GET    /api/history     the chat history (every question and answer), the active task and token counts
 * DELETE /api/history     clear the visible history (the memory layers and tasks are not touched)
 */
export function createHistoryRouter({ agent, history, tasks }) {
  const router = Router();

  router.get('/history', asyncRoute(async (req, res) => {
    const [messages, task, tokens] = await Promise.all([history.list(), tasks.getActiveTask(), agent.tokenSummary()]);
    res.json({ messages, task: publicTask(task), busy: task ? tasks.isBusy(task.id) : false, tokens });
  }));

  router.delete('/history', asyncRoute(async (req, res) => {
    await history.clear();
    res.json({ messages: [] });
  }));

  return router;
}
