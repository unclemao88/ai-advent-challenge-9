import { randomUUID } from 'node:crypto';

import * as SM from '../agent/stateMachine.js';
import { JsonDocument } from '../utils/jsonDocument.js';
import { conflict, notFound } from '../utils/errors.js';
import { TASK_ID, isPlainObject } from '../utils/validate.js';

const MAX_TASKS = 200;

/**
 * Persists tasks in `data/tasks.json`:
 *
 *   { "activeTaskId": "task-…", "defaultMode": "manual", "tasks": [ {…}, … ] }
 *
 * Every change goes through `update(id, fn)`, which reads the latest stored
 * task, applies a state-machine function and writes it back under the file's
 * lock. A pause requested while a step runs is therefore never overwritten by
 * the running step. State transitions are logged here, so every path that
 * changes a task is covered.
 *
 * `acquire(id)` is a separate, non-blocking "one operation at a time" guard
 * for long operations (a step that calls DeepSeek): a second ask or continue
 * on the same task is refused with 409 instead of queueing behind the first.
 */
export class TaskManager {
  #busy = new Set();

  constructor({ dataDir, logger, defaultMode = 'manual' }) {
    this.logger = logger;
    this.defaultMode = SM.MODES.includes(defaultMode) ? defaultMode : 'manual';
    this.doc = new JsonDocument({
      dataDir, file: 'tasks.json', logger,
      empty: () => ({ activeTaskId: null, defaultMode: this.defaultMode, tasks: [] }),
      normalize: (value) => this.#normalizeDoc(value),
    });
  }

  get location() {
    return this.doc.location;
  }

  /** Create the file and repair tasks that a crash or restart left mid-step. */
  async init() {
    await this.doc.init();
    const recovered = await this.doc.update((doc) => {
      const ids = [];
      doc.tasks = doc.tasks.map((task) => {
        if (task.stepStatus !== 'running') return task;
        ids.push(task.id);
        return SM.recoverInterrupted(task);
      });
      return ids.length ? { doc, result: ids } : { result: ids };
    });
    for (const taskId of recovered) this.logger.warn('task.recovered_after_restart', { taskId });
    return recovered;
  }

  /** @param {{title: string, request: string, mode?: string}} input */
  async createTask({ title, request, mode }) {
    return this.doc.update((doc) => {
      const task = SM.createTask({ id: `task-${randomUUID()}`, title, request, mode: mode ?? doc.defaultMode });
      doc.tasks.push(task);
      if (doc.tasks.length > MAX_TASKS) {
        // Drop the oldest finished tasks first; unfinished work is never discarded.
        const finished = doc.tasks.filter((t) => t.status === 'done' || (t.status === 'failed' && !t.resumeState));
        const drop = new Set(finished.slice(0, doc.tasks.length - MAX_TASKS).map((t) => t.id));
        doc.tasks = doc.tasks.filter((t) => !drop.has(t.id));
      }
      this.logger.info('task.created', { taskId: task.id, mode: task.mode, state: task.state });
      return { doc, result: task };
    });
  }

  async getTask(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return null;
    return (await this.doc.read()).tasks.find((t) => t.id === taskId) ?? null;
  }

  async requireTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) throw notFound('Task not found.', 'task_not_found');
    return task;
  }

  /** @returns {Promise<object[]>} Newest first. */
  async listTasks() {
    const { tasks } = await this.doc.read();
    return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read the latest task, apply `fn`, store the result.
   * @param {string} taskId
   * @param {(task: object) => object} fn Returns the new task.
   */
  update(taskId, fn) {
    return this.doc.update((doc) => {
      const index = doc.tasks.findIndex((t) => t.id === taskId);
      if (index === -1) throw notFound('Task not found.', 'task_not_found');
      const before = doc.tasks[index];
      const after = fn(before);
      if (!isPlainObject(after) || after.id !== taskId) throw new Error('Task update returned an invalid task');
      after.updatedAt = new Date().toISOString();
      doc.tasks[index] = after;

      for (const entry of after.history.slice(before.history.length)) {
        this.logger.info('task.transition', { taskId, from: entry.from, to: entry.to, reason: entry.reason });
      }
      if (before.status !== after.status || before.mode !== after.mode || before.pauseRequested !== after.pauseRequested) {
        this.logger.info('task.status', {
          taskId, status: after.status, mode: after.mode, state: after.state, pauseRequested: after.pauseRequested,
        });
      }
      return { doc, result: after };
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

  /** How many tasks are in the middle of a step (graceful shutdown waits for this). */
  get busyCount() {
    return this.#busy.size;
  }

  async deleteTask(taskId) {
    if (this.isBusy(taskId)) throw conflict('The task is running and cannot be deleted now.', 'task_busy');
    return this.doc.update((doc) => {
      const before = doc.tasks.length;
      doc.tasks = doc.tasks.filter((t) => t.id !== taskId);
      if (doc.activeTaskId === taskId) doc.activeTaskId = null;
      this.logger.info('task.deleted', { taskId });
      return { doc, result: before !== doc.tasks.length };
    });
  }

  // --- The active task and the default mode ----------------------------------------

  async getSession() {
    const { activeTaskId, defaultMode } = await this.doc.read();
    return { activeTaskId, defaultMode };
  }

  async getActiveTask() {
    const doc = await this.doc.read();
    return doc.activeTaskId ? doc.tasks.find((t) => t.id === doc.activeTaskId) ?? null : null;
  }

  setActiveTask(taskId) {
    return this.doc.update((doc) => {
      doc.activeTaskId = taskId;
    });
  }

  async getDefaultMode() {
    return (await this.doc.read()).defaultMode;
  }

  setDefaultMode(mode) {
    return this.doc.update((doc) => {
      doc.defaultMode = SM.MODES.includes(mode) ? mode : doc.defaultMode;
    });
  }

  #normalizeDoc(value) {
    const doc = { activeTaskId: null, defaultMode: this.defaultMode, tasks: [] };
    if (!isPlainObject(value)) return doc;
    if (SM.MODES.includes(value.defaultMode)) doc.defaultMode = value.defaultMode;
    doc.tasks = (Array.isArray(value.tasks) ? value.tasks : []).map(normalizeTask).filter(Boolean);
    if (typeof value.activeTaskId === 'string' && doc.tasks.some((t) => t.id === value.activeTaskId)) {
      doc.activeTaskId = value.activeTaskId;
    }
    return doc;
  }
}

/** Accept only well-formed tasks; anything else is dropped. */
function normalizeTask(value) {
  if (!isPlainObject(value) || typeof value.id !== 'string' || !TASK_ID.test(value.id)) return null;
  if (!SM.ALL_STATES.includes(value.state) || !Object.values(SM.STATUSES).includes(value.status)) return null;
  return {
    ...value,
    mode: SM.MODES.includes(value.mode) ? value.mode : 'manual',
    stepStatus: ['pending', 'running', 'completed'].includes(value.stepStatus) ? value.stepStatus : 'completed',
    history: Array.isArray(value.history) ? value.history : [],
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  };
}
