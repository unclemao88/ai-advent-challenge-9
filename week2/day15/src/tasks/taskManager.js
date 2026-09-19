import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import * as SM from '../agent/stateMachine.js';
import { JsonDocument } from '../persistence/jsonDocument.js';
import { DATA_FILES } from '../persistence/dataPaths.js';
import { conflict, notFound } from '../utils/errors.js';
import { TASK_ID, isPlainObject } from '../utils/validate.js';

const TASK_FILE = /^(task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

/**
 * Persists tasks, one file each, outside the chat history:
 *
 *   data/tasks/task-<uuid>.json   the task: state machine fields, objective, validation,
 *                                 completion, a reference to its work memory, history
 *   data/tasks/active.json        { "activeTaskId": "task-…" | null, "defaultMode": "manual" }
 *
 * Every change goes through `update(id, fn)`, which reads the latest stored
 * task, applies a state-machine function and writes it back under that task's
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
  #docs = new Map();

  constructor({ dataDir, logger, defaultMode = 'manual' }) {
    this.dataDir = path.resolve(dataDir);
    this.tasksDir = path.join(this.dataDir, DATA_FILES.tasksDir);
    this.logger = logger;
    this.defaultMode = SM.MODES.includes(defaultMode) ? defaultMode : 'manual';
    this.session = new JsonDocument({
      dataDir, file: DATA_FILES.activeTask, logger,
      empty: () => ({ activeTaskId: null, defaultMode: this.defaultMode }),
      normalize: (value) => ({
        activeTaskId: isPlainObject(value) && typeof value.activeTaskId === 'string' && TASK_ID.test(value.activeTaskId) ? value.activeTaskId : null,
        defaultMode: isPlainObject(value) && SM.MODES.includes(value.defaultMode) ? value.defaultMode : this.defaultMode,
      }),
    });
  }

  get location() {
    return `data/${DATA_FILES.tasksDir}/task-<id>.json`;
  }

  /** Create the directory and repair tasks that a crash or restart left mid-step. */
  async init() {
    await mkdir(this.tasksDir, { recursive: true, mode: 0o700 });
    const existed = await this.session.init();
    const recovered = [];
    for (const id of await this.#taskIds()) {
      const task = await this.#doc(id).read();
      if (task?.stepStatus !== 'running') continue;
      await this.update(id, (t) => SM.recoverInterrupted(t));
      recovered.push(id);
      this.logger.warn('task.recovered_after_restart', { taskId: id });
    }
    return { existed, recovered };
  }

  /** @param {{title: string, request: string, mode?: string}} input */
  async createTask({ title, request, mode }) {
    const { defaultMode } = await this.session.read();
    const task = SM.createTask({ id: `task-${randomUUID()}`, title, request, mode: mode ?? defaultMode });
    await this.#doc(task.id).write(task);
    this.logger.info('task.created', { taskId: task.id, mode: task.mode, state: task.state, file: this.#doc(task.id).location });
    return task;
  }

  async getTask(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return null;
    return this.#doc(taskId).read();
  }

  async requireTask(taskId) {
    const task = await this.getTask(taskId);
    if (!task) throw notFound('Task not found.', 'task_not_found');
    return task;
  }

  /** @returns {Promise<object[]>} Newest first. */
  async listTasks() {
    const tasks = [];
    for (const id of await this.#taskIds()) {
      const task = await this.#doc(id).read();
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Read the latest task, apply `fn`, store the result.
   * @param {string} taskId
   * @param {(task: object) => object} fn Returns the new task (normally a state-machine function).
   */
  update(taskId, fn) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return Promise.reject(notFound('Task not found.', 'task_not_found'));
    return this.#doc(taskId).update((before) => {
      if (!before) throw notFound('Task not found.', 'task_not_found');
      const after = fn(before);
      if (!isPlainObject(after) || after.id !== taskId || !SM.ALL_STATES.includes(after.state)) {
        throw new Error('Task update returned an invalid task');
      }
      after.updatedAt = new Date().toISOString();
      after.currentAction = SM.currentActionOf(after);

      for (const entry of after.history.slice(before.history.length)) {
        this.logger.info('task.transition', { taskId, from: entry.from, to: entry.to, reason: entry.reason });
      }
      for (const rejected of (after.rejectedTransitions ?? []).slice((before.rejectedTransitions ?? []).length)) {
        this.logger.warn('task.transition_rejected', { taskId, from: rejected.from, to: rejected.to, reason: rejected.reason });
      }
      if (before.status !== after.status || before.mode !== after.mode || before.pauseRequested !== after.pauseRequested
        || before.awaitingInput?.reason !== after.awaitingInput?.reason) {
        this.logger.info('task.status', {
          taskId, status: after.status, mode: after.mode, state: after.state,
          pauseRequested: after.pauseRequested, awaiting: after.awaitingInput?.reason ?? null,
        });
      }
      return { doc: after, result: after };
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
    const existed = await this.#doc(taskId).remove();
    this.#docs.delete(taskId);
    await this.session.update((doc) => {
      if (doc.activeTaskId === taskId) doc.activeTaskId = null;
    });
    this.logger.info('task.deleted', { taskId, existed });
    return existed;
  }

  // --- The active task and the default mode ----------------------------------------

  async getSession() {
    return this.session.read();
  }

  async getActiveTask() {
    const { activeTaskId } = await this.session.read();
    return activeTaskId ? this.getTask(activeTaskId) : null;
  }

  setActiveTask(taskId) {
    return this.session.update((doc) => {
      doc.activeTaskId = taskId;
    });
  }

  async getDefaultMode() {
    return (await this.session.read()).defaultMode;
  }

  setDefaultMode(mode) {
    return this.session.update((doc) => {
      if (SM.MODES.includes(mode)) doc.defaultMode = mode;
    });
  }

  // --- Files ----------------------------------------------------------------------

  #doc(taskId) {
    if (!TASK_ID.test(taskId)) throw notFound('Task not found.', 'task_not_found');
    let doc = this.#docs.get(taskId);
    if (!doc) {
      doc = new JsonDocument({
        dataDir: this.dataDir, file: `${DATA_FILES.tasksDir}/${taskId}.json`, logger: this.logger,
        empty: () => null, normalize: (value) => normalizeTask(value, taskId),
      });
      this.#docs.set(taskId, doc);
    }
    return doc;
  }

  async #taskIds() {
    let names;
    try {
      names = await readdir(this.tasksDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names.map((name) => name.match(TASK_FILE)?.[1]).filter(Boolean);
  }
}

/** Accept only a well-formed task stored under its own id; anything else reads as missing. */
function normalizeTask(value, taskId) {
  if (!isPlainObject(value) || value.id !== taskId) return null;
  if (!SM.ALL_STATES.includes(value.state) || !Object.values(SM.STATUSES).includes(value.status)) return null;
  return {
    ...value,
    mode: SM.MODES.includes(value.mode) ? value.mode : 'manual',
    stepStatus: ['pending', 'running', 'completed'].includes(value.stepStatus) ? value.stepStatus : 'completed',
    history: Array.isArray(value.history) ? value.history : [],
    rejectedTransitions: Array.isArray(value.rejectedTransitions) ? value.rejectedTransitions : [],
    validation: isPlainObject(value.validation) ? value.validation : { attempts: 0, lastVerdict: null },
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  };
}
