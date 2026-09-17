import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { JsonFileBackend } from '../storage/JsonFileBackend.js';
import * as SM from '../state-machine/StateMachine.js';
import { conflict, notFound } from '../utils/errors.js';
import { SerialQueue } from '../utils/serialQueue.js';
import { TASK_ID, isPlainObject } from '../utils/validate.js';

const SESSION_KEY = 'session';

/**
 * Persists tasks (`data/tasks/task-<id>.json`) and which one is active
 * (`data/tasks/session.json`).
 *
 * Every change goes through `update(id, fn)`, which reads the latest stored
 * task, applies a state-machine function and writes it back under a per-task
 * lock. A pause requested while a step runs is therefore never overwritten by
 * the running step.
 *
 * `acquire(id)` is a separate, non-blocking "one operation at a time" guard for
 * long operations (a step that calls DeepSeek): a second chat or continue on
 * the same task is refused with 409 instead of queueing behind the first.
 */
export class TaskManager {
  #queues = new Map();
  #busy = new Set();
  #sessionQueue = new SerialQueue();

  constructor({ dataDir, logger, defaultMode = 'manual' }) {
    this.backend = new JsonFileBackend({ directory: path.join(dataDir, 'tasks'), dataDir, backup: true, logger });
    this.logger = logger;
    this.defaultMode = SM.MODES.includes(defaultMode) ? defaultMode : 'manual';
  }

  /** Create the directory and repair tasks that a crash or restart left "running". */
  async init() {
    await this.backend.init();
    for (const task of await this.listTasks()) {
      if (task.status === SM.STATUSES.RUNNING) {
        const recovered = await this.update(task.taskId, (t) => SM.recoverInterrupted(t));
        this.logger.warn('task.recovered_after_restart', {
          taskId: task.taskId, state: recovered.currentState, status: recovered.status,
        });
      }
    }
  }

  /** @param {{title: string, mode?: string}} input */
  async createTask({ title, mode }) {
    const task = SM.createTask({ taskId: randomUUID(), title, mode: mode ?? (await this.getDefaultMode()) });
    await this.#write(task);
    this.logger.info('task.created', { taskId: task.taskId, mode: task.mode, state: task.currentState });
    return task;
  }

  async getTask(taskId) {
    if (!TASK_ID.test(taskId)) return null;
    return normalizeTask(await this.backend.get(key(taskId)));
  }

  async requireTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) throw notFound('Task not found.', 'task_not_found');
    return task;
  }

  /** @returns {Promise<object[]>} Newest first. */
  async listTasks() {
    const tasks = [];
    for (const k of await this.backend.list('task-')) {
      const task = normalizeTask(await this.backend.get(k));
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read the latest task, apply `fn`, validate and store the result. State
   * transitions are logged here, so every path that changes a task is covered.
   *
   * @param {string} taskId
   * @param {(task: object) => object} fn Returns the new task.
   */
  update(taskId, fn) {
    return this.#queueFor(taskId).run(async () => {
      const before = await this.requireTask(taskId);
      const after = fn(before);
      if (!isPlainObject(after) || after.taskId !== taskId) throw new Error('Task update returned an invalid task');
      after.updatedAt = new Date().toISOString();
      await this.#write(after);
      for (const entry of after.history.slice(before.history.length)) {
        this.logger.info('task.transition', { taskId, from: entry.from, to: entry.to, reason: entry.reason });
      }
      if (before.status !== after.status || before.mode !== after.mode || before.pauseRequested !== after.pauseRequested) {
        this.logger.info('task.status', {
          taskId, status: after.status, mode: after.mode, state: after.currentState, pauseRequested: after.pauseRequested,
        });
      }
      return after;
    });
  }

  /**
   * Mark a task busy for a long operation.
   * @returns {() => void} Call to release.
   * @throws {AppError} 409 when the task is already busy.
   */
  acquire(taskId) {
    if (this.#busy.has(taskId)) {
      throw conflict('The agent is still working on this task. Wait for it to finish.', 'task_busy');
    }
    this.#busy.add(taskId);
    let released = false;
    return () => {
      if (!released) this.#busy.delete(taskId);
      released = true;
    };
  }

  isBusy(taskId) {
    return this.#busy.has(taskId);
  }

  /** Whether any task is in the middle of a step (graceful shutdown waits for this). */
  get busyCount() {
    return this.#busy.size;
  }

  async deleteTask(taskId) {
    if (this.isBusy(taskId)) throw conflict('The task is running and cannot be deleted now.', 'task_busy');
    const existed = await this.#queueFor(taskId).run(() => this.backend.delete(key(taskId)));
    if ((await this.getSession()).activeTaskId === taskId) await this.setActiveTask(null);
    this.logger.info('task.deleted', { taskId, existed });
    return existed;
  }

  // --- Session: the active task and the default mode ------------------------

  async getSession() {
    const stored = await this.backend.get(SESSION_KEY);
    return {
      activeTaskId: typeof stored?.activeTaskId === 'string' && TASK_ID.test(stored.activeTaskId) ? stored.activeTaskId : null,
      defaultMode: SM.MODES.includes(stored?.defaultMode) ? stored.defaultMode : this.defaultMode,
    };
  }

  #updateSession(changes) {
    return this.#sessionQueue.run(async () => {
      const next = { ...(await this.getSession()), ...changes, updatedAt: new Date().toISOString() };
      await this.backend.put(SESSION_KEY, next);
      return next;
    });
  }

  async getActiveTask() {
    const { activeTaskId } = await this.getSession();
    return activeTaskId ? this.getTask(activeTaskId) : null;
  }

  setActiveTask(taskId) {
    return this.#updateSession({ activeTaskId: taskId });
  }

  async getDefaultMode() {
    return (await this.getSession()).defaultMode;
  }

  setDefaultMode(mode) {
    return this.#updateSession({ defaultMode: mode });
  }

  #queueFor(taskId) {
    if (!this.#queues.has(taskId)) this.#queues.set(taskId, new SerialQueue());
    return this.#queues.get(taskId);
  }

  #write(task) {
    return this.backend.put(key(task.taskId), { version: 1, ...task });
  }
}

const key = (taskId) => `task-${taskId}`;

/** Accept only well-formed tasks; anything else reads as missing. */
function normalizeTask(value) {
  if (!isPlainObject(value) || typeof value.taskId !== 'string' || !TASK_ID.test(value.taskId)) return null;
  if (!SM.ALL_STATES.includes(value.currentState) || !Object.values(SM.STATUSES).includes(value.status)) return null;
  const { version, ...task } = value; // eslint-disable-line no-unused-vars
  return {
    ...task,
    mode: SM.MODES.includes(task.mode) ? task.mode : 'manual',
    history: Array.isArray(task.history) ? task.history : [],
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : new Date(0).toISOString(),
  };
}
