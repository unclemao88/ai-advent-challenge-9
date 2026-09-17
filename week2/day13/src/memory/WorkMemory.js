import { SerialQueue } from '../utils/serialQueue.js';
import { clip, isPlainObject } from '../utils/validate.js';

/**
 * Work memory: what the agent needs to know about one task.
 *
 * One document per task (`work-memory/task-<id>.json`). It lives as long as
 * the task does and is deleted with it. Nothing here is copied to long-term
 * memory automatically.
 */

/** List fields that collect plain text items. */
export const TEXT_LISTS = ['requirements', 'decisions', 'facts'];
/** List fields whose items are `{ state, text, timestamp }` (validation adds `passed`). */
export const RESULT_LISTS = ['intermediateResults', 'validationResults'];

export const LIMITS = Object.freeze({
  objective: 1000, item: 1000, planStep: 500, listItems: 30, planSteps: 20, variables: 30, variableName: 60, variableValue: 500,
});

export function emptyWorkMemory(taskId) {
  return {
    taskId,
    objective: '',
    plan: [],
    requirements: [],
    decisions: [],
    facts: [],
    intermediateResults: [],
    validationResults: [],
    variables: {},
    updatedAt: new Date().toISOString(),
  };
}

export const workMemoryKey = (taskId) => `task-${taskId}`;

export class WorkMemory {
  #backend;
  #queue = new SerialQueue();

  constructor({ backend, tokenCounter, logger }) {
    this.#backend = backend;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
  }

  get backend() {
    return this.#backend;
  }

  /**
   * Swap the backend under the layer's lock. `migrate(oldBackend)` runs first,
   * inside the same lock, so no write can land in the old backend after the copy.
   */
  setBackend(backend, migrate) {
    return this.#queue.run(async () => {
      const result = migrate ? await migrate(this.#backend) : undefined;
      this.#backend = backend;
      return result;
    });
  }

  createWorkMemory(taskId, { objective = '' } = {}) {
    return this.#queue.run(async () => {
      const doc = { ...emptyWorkMemory(taskId), objective: clip(objective, LIMITS.objective) };
      await this.#backend.put(workMemoryKey(taskId), doc);
      this.logger.info('memory.work.create', { taskId });
      return doc;
    });
  }

  /** @returns {Promise<object>} The task's work memory; an empty one if none is stored. */
  getWorkMemory(taskId) {
    return this.#queue.run(() => this.#read(taskId));
  }

  /**
   * Merge updates: `objective` and `plan` replace, lists append without
   * duplicates, `variables` are merged key by key. Values are clipped, lists
   * capped (oldest items drop first), so model output can never grow it unbounded.
   *
   * @param {string} taskId
   * @param {object} updates
   * @param {{state?: string}} [context] The task state the results belong to.
   */
  updateWorkMemory(taskId, updates, { state = null } = {}) {
    return this.#queue.run(async () => {
      const doc = await this.#read(taskId);
      const now = new Date().toISOString();

      if (typeof updates.objective === 'string' && updates.objective.trim()) {
        doc.objective = clip(updates.objective, LIMITS.objective);
      }
      if (Array.isArray(updates.plan)) {
        const plan = updates.plan.map((step) => clip(step, LIMITS.planStep)).filter(Boolean);
        if (plan.length) doc.plan = plan.slice(0, LIMITS.planSteps);
      }
      for (const field of TEXT_LISTS) {
        if (Array.isArray(updates[field])) doc[field] = appendUnique(doc[field], updates[field]);
      }
      for (const field of RESULT_LISTS) {
        const items = Array.isArray(updates[field]) ? updates[field] : [];
        for (const item of items) {
          const text = clip(typeof item === 'string' ? item : item?.text, LIMITS.item);
          if (!text) continue;
          const entry = { state: item?.state ?? state, text, timestamp: now };
          if (typeof item?.passed === 'boolean') entry.passed = item.passed;
          doc[field] = [...doc[field], entry].slice(-LIMITS.listItems);
        }
      }
      if (isPlainObject(updates.variables)) {
        for (const [name, value] of Object.entries(updates.variables)) {
          const key = clip(name, LIMITS.variableName);
          if (!key) continue;
          if (value === null) delete doc.variables[key];
          else doc.variables[key] = clip(String(value), LIMITS.variableValue);
        }
        const names = Object.keys(doc.variables);
        for (const extra of names.slice(0, Math.max(0, names.length - LIMITS.variables))) delete doc.variables[extra];
      }

      doc.updatedAt = now;
      await this.#backend.put(workMemoryKey(taskId), doc);
      this.logger.debug('memory.work.update', { taskId, fields: Object.keys(updates) });
      return doc;
    });
  }

  /**
   * Replace the editable fields with exactly the given values (an edit made in
   * the memory panel, where removing an item must remove it). Result lists are
   * kept: they are a record of what happened, not an editable field.
   */
  replaceWorkMemory(taskId, { objective = '', plan = [], requirements = [], decisions = [], facts = [], variables = {} }) {
    return this.#queue.run(async () => {
      const current = await this.#read(taskId);
      const doc = {
        ...current,
        objective: clip(objective, LIMITS.objective),
        plan: plan.map((s) => clip(s, LIMITS.planStep)).filter(Boolean).slice(0, LIMITS.planSteps),
        requirements: appendUnique([], requirements),
        decisions: appendUnique([], decisions),
        facts: appendUnique([], facts),
        variables: Object.fromEntries(Object.entries(variables)
          .map(([k, v]) => [clip(k, LIMITS.variableName), clip(String(v), LIMITS.variableValue)])
          .filter(([k]) => k)
          .slice(0, LIMITS.variables)),
        updatedAt: new Date().toISOString(),
      };
      await this.#backend.put(workMemoryKey(taskId), doc);
      this.logger.info('memory.work.replace', { taskId });
      return doc;
    });
  }

  /** Empty every field but keep the document (and the task's reference to it). */
  clearWorkMemory(taskId) {
    return this.#queue.run(async () => {
      const doc = emptyWorkMemory(taskId);
      await this.#backend.put(workMemoryKey(taskId), doc);
      this.logger.info('memory.work.clear', { taskId });
      return doc;
    });
  }

  deleteWorkMemory(taskId) {
    return this.#queue.run(async () => {
      const existed = await this.#backend.delete(workMemoryKey(taskId));
      this.logger.info('memory.work.delete', { taskId, existed });
      return existed;
    });
  }

  /** @returns {Promise<string[]>} Task ids that have work memory. */
  async listTaskIds() {
    const keys = await this.#backend.list('task-');
    return keys.map((key) => key.slice('task-'.length));
  }

  calculateTokenCount(doc) {
    return this.tokenCounter.countText(formatWorkMemory(doc));
  }

  async #read(taskId) {
    const stored = await this.#backend.get(workMemoryKey(taskId));
    return normalize(taskId, stored);
  }
}

function normalize(taskId, value) {
  const doc = emptyWorkMemory(taskId);
  if (!isPlainObject(value)) return doc;
  if (typeof value.objective === 'string') doc.objective = value.objective;
  if (Array.isArray(value.plan)) doc.plan = value.plan.filter((s) => typeof s === 'string');
  for (const field of TEXT_LISTS) {
    if (Array.isArray(value[field])) doc[field] = value[field].filter((s) => typeof s === 'string');
  }
  for (const field of RESULT_LISTS) {
    if (Array.isArray(value[field])) doc[field] = value[field].filter((r) => isPlainObject(r) && typeof r.text === 'string');
  }
  if (isPlainObject(value.variables)) {
    doc.variables = Object.fromEntries(Object.entries(value.variables).filter(([, v]) => typeof v === 'string'));
  }
  if (typeof value.updatedAt === 'string') doc.updatedAt = value.updatedAt;
  return doc;
}

function appendUnique(existing, additions) {
  const seen = new Set(existing.map((item) => item.toLowerCase()));
  const result = [...existing];
  for (const raw of additions) {
    const text = clip(raw, LIMITS.item);
    if (text && !seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      result.push(text);
    }
  }
  return result.slice(-LIMITS.listItems);
}

const LABELS = {
  requirements: 'Requirements', decisions: 'Decisions', facts: 'Facts',
  intermediateResults: 'Intermediate results', validationResults: 'Validation results',
};

/** Work memory as the text that goes into the context. '' when there is nothing in it. */
export function formatWorkMemory(doc) {
  if (!doc) return '';
  const lines = [];
  if (doc.objective) lines.push(`Objective: ${doc.objective}`);
  if (doc.plan?.length) lines.push('Plan:', ...doc.plan.map((step, i) => `${i + 1}. ${step}`));
  for (const field of TEXT_LISTS) {
    if (doc[field]?.length) lines.push(`${LABELS[field]}:`, ...doc[field].map((item) => `- ${item}`));
  }
  for (const field of RESULT_LISTS) {
    if (doc[field]?.length) {
      lines.push(`${LABELS[field]}:`, ...doc[field].map((r) => {
        const verdict = typeof r.passed === 'boolean' ? (r.passed ? ' PASSED' : ' FAILED') : '';
        return `- [${r.state ?? 'note'}${verdict}] ${r.text}`;
      }));
    }
  }
  const vars = Object.entries(doc.variables ?? {});
  if (vars.length) lines.push('Variables:', ...vars.map(([k, v]) => `- ${k} = ${v}`));
  return lines.join('\n');
}
