import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { publicTask } from '../../state-machine/StateMachine.js';
import { requireTaskId } from '../../utils/validate.js';

/**
 * GET    /api/tasks                 all tasks, newest first
 * GET    /api/tasks/active          the active task (null if none)
 * DELETE /api/tasks/active          detach it: the next question starts a new task
 * GET    /api/tasks/:id             one task with its work memory
 * POST   /api/tasks/:id/continue    run the next state / retry a failed one
 * POST   /api/tasks/:id/pause       pause (after the running step, if one runs)
 * POST   /api/tasks/:id/resume      leave pause
 * POST   /api/tasks/:id/auto        switch to auto mode
 * POST   /api/tasks/:id/manual      switch to manual mode
 * POST   /api/tasks/:id/activate    make it the active task
 * DELETE /api/tasks/:id             delete the task and its work memory
 */
export function createTasksRouter({ agent, tasks, memory, llmLimiter }) {
  const router = Router();

  router.get('/tasks', asyncRoute(async (req, res) => {
    const [list, session] = await Promise.all([tasks.listTasks(), tasks.getSession()]);
    res.json({
      activeTaskId: session.activeTaskId,
      defaultMode: session.defaultMode,
      tasks: list.map((t) => {
        const { history, ...summary } = publicTask(t);
        return { ...summary, transitions: history.length, busy: tasks.isBusy(t.taskId) };
      }),
    });
  }));

  router.get('/tasks/active', asyncRoute(async (req, res) => {
    const task = await tasks.getActiveTask();
    res.json({ task: publicTask(task), busy: task ? tasks.isBusy(task.taskId) : false, tokens: await agent.tokenSummary() });
  }));

  router.delete('/tasks/active', asyncRoute(async (req, res) => res.json(await agent.startNewSession())));

  router.get('/tasks/:id', asyncRoute(async (req, res) => {
    const id = requireTaskId(req.params.id);
    const task = await tasks.requireTask(id);
    res.json({ task: publicTask(task), busy: tasks.isBusy(id), workMemory: await memory.getWorkMemory(id) });
  }));

  const action = (name, fn, limiter) => {
    const handlers = [asyncRoute(async (req, res) => res.json(await fn(requireTaskId(req.params.id))))];
    router.post(`/tasks/:id/${name}`, ...(limiter ? [limiter] : []), ...handlers);
  };

  action('continue', (id) => agent.continueTask(id), llmLimiter);
  action('resume', (id) => agent.resumeTask(id), llmLimiter);
  action('pause', (id) => agent.pauseTask(id));
  action('auto', (id) => agent.setMode(id, 'auto'));
  action('manual', (id) => agent.setMode(id, 'manual'));
  action('activate', (id) => agent.activateTask(id));

  router.delete('/tasks/:id', asyncRoute(async (req, res) => res.json(await agent.deleteTask(requireTaskId(req.params.id)))));

  return router;
}
