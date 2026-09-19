import { Router } from 'express';

import { asyncRoute } from '../middleware.js';
import { CONFLICT_DECISIONS } from '../../agent/agent.js';
import { MODES, publicTask } from '../../agent/stateMachine.js';
import { rejectUnknownFields, requireEnum, requireObject, requireTaskId } from '../../utils/validate.js';

/**
 * GET    /api/tasks                  all tasks, newest first
 * GET    /api/tasks/active           the active task (null if none)
 * DELETE /api/tasks/active           detach it: the next question starts a new task
 * GET    /api/tasks/:id              one task with its work memory
 * POST   /api/tasks/:id/continue     run the next state, or retry a failed one
 * POST   /api/tasks/:id/pause        pause (after the running step, if one runs)
 * POST   /api/tasks/:id/resume       leave pause; in auto mode the task runs on
 * POST   /api/tasks/:id/mode         {mode: "manual" | "auto"}
 * POST   /api/tasks/:id/resolve      after an invariant conflict: {decision: keep | disable | updated | cancel}
 * POST   /api/tasks/:id/cancel       stop the task
 * POST   /api/tasks/:id/activate     make it the active task
 * DELETE /api/tasks/:id              delete the task and its work memory
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
        return { ...summary, transitions: history.length, busy: tasks.isBusy(t.id) };
      }),
    });
  }));

  router.get('/tasks/active', asyncRoute(async (req, res) => {
    const task = await tasks.getActiveTask();
    res.json({ task: publicTask(task), busy: task ? tasks.isBusy(task.id) : false, tokens: await agent.tokenSummary() });
  }));

  router.delete('/tasks/active', asyncRoute(async (req, res) => res.json(await agent.startNewTask())));

  router.get('/tasks/:id', asyncRoute(async (req, res) => {
    const id = requireTaskId(req.params.id);
    const task = await tasks.requireTask(id);
    res.json({ task: publicTask(task), busy: tasks.isBusy(id), workMemory: await memory.getWorkMemory(id) });
  }));

  const action = (name, fn, { limited = false } = {}) => {
    router.post(`/tasks/:id/${name}`, ...(limited ? [llmLimiter] : []), asyncRoute(async (req, res) => {
      res.json(await fn(requireTaskId(req.params.id), req));
    }));
  };

  action('continue', (id, req) => agent.continueTask(id, { requestId: req.id }), { limited: true });
  action('resume', (id, req) => agent.resumeTask(id, { requestId: req.id }), { limited: true });
  action('pause', (id) => agent.pauseTask(id));
  action('cancel', (id) => agent.cancelTask(id));
  action('activate', (id) => agent.activateTask(id));
  action('mode', (id, req) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['mode']);
    return agent.setMode(id, requireEnum(body.mode, 'mode', MODES));
  });
  action('resolve', (id, req) => {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['decision']);
    return agent.resolveConflict(id, requireEnum(body.decision, 'decision', CONFLICT_DECISIONS), { requestId: req.id });
  }, { limited: true });

  router.delete('/tasks/:id', asyncRoute(async (req, res) => res.json(await agent.deleteTask(requireTaskId(req.params.id)))));

  return router;
}
