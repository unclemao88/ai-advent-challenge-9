import { SerialQueue } from '../utils/serialQueue.js';
import { clip, isPlainObject } from '../utils/validate.js';

/**
 * Work memory: what the agent needs for one task, and nothing else.
 *
 * One value per task (`task-<id>`) in the layer's own provider —
 * `data/memory/work-memory.json` with the JSON provider. It lives as long as the task
 * and is deleted with it. Nothing here is copied to long-term memory unless
 * the user promotes an item (MemoryManager.promoteToLongTerm).
 *
 * Every change is recorded in `log` (when, from which state, by whom, which
 * fields), so the memory updates stay inspectable.
 */

/** List fields holding plain text items; these are the ones that can be edited and promoted. */
export const TEXT_LISTS = ['requirements', 'decisions', 'facts'];
/** List fields whose items are `{ state, text, timestamp }` (validation adds `passed`). */
export const RESULT_LISTS = ['intermediateResults', 'validationResults'];
export const PROMOTABLE_FIELDS = ['objective', 'plan', ...TEXT_LISTS, ...RESULT_LISTS];

export const LIMITS = Object.freeze({
  objective: 1000, item: 1000, planStep: 500, listItems: 30, planSteps: 20,
  variables: 30, variableName: 60, variableValue: 500, log: 50, checks: 20, proposals: 10,
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
    invariantChecks: [],
    profileChecks: [],
    proposals: [],
    log: [],
    updatedAt: new Date().toISOString(),
  };
}

export const workMemoryKey = (taskId) => taskId;

export class WorkMemory {
  #provider;
  #queue = new SerialQueue();

  constructor({ provider, tokenCounter, logger }) {
    this.#provider = provider;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
  }

  get provider() {
    return this.#provider;
  }

  setProvider(provider, migrate) {
    return this.#queue.run(async () => {
      const result = migrate ? await migrate(this.#provider) : undefined;
      this.#provider = provider;
      return result;
    });
  }

  createWorkMemory(taskId, { objective = '' } = {}) {
    return this.#queue.run(async () => {
      const doc = { ...emptyWorkMemory(taskId), objective: clip(objective, LIMITS.objective) };
      addLog(doc, { source: 'task', state: 'planning', fields: ['objective'] });
      await this.#provider.set(workMemoryKey(taskId), doc);
      this.logger.info('memory.work.create', { taskId });
      return doc;
    });
  }

  /** @returns {Promise<object>} The task's work memory; an empty one if none is stored. */
  getWorkMemory(taskId) {
    return this.#queue.run(() => this.#read(taskId));
  }

  /** @returns {Promise<Record<string, object>>} Work memory of every task. */
  async getAll() {
    const all = await this.#queue.run(() => this.#provider.getAll());
    return Object.fromEntries(Object.entries(all).map(([key, value]) => [key, normalize(key, value)]));
  }

  /**
   * Merge updates: `objective` and `plan` replace, lists append without
   * duplicates, `variables` merge key by key, `invariantChecks` append. Values
   * are clipped and lists capped (oldest first out), so model output can never
   * grow the layer without bound.
   *
   * @param {string} taskId
   * @param {object} updates
   * @param {{state?: string|null, source?: string}} [context] Recorded in the log.
   */
  updateWorkMemory(taskId, updates, { state = null, source = 'agent' } = {}) {
    return this.#queue.run(async () => {
      const doc = await this.#read(taskId);
      const now = new Date().toISOString();
      const changed = [];

      if (typeof updates.objective === 'string' && updates.objective.trim()) {
        doc.objective = clip(updates.objective, LIMITS.objective);
        changed.push('objective');
      }
      if (Array.isArray(updates.plan)) {
        const plan = updates.plan.map((step) => clip(step, LIMITS.planStep)).filter(Boolean);
        if (plan.length) {
          doc.plan = plan.slice(0, LIMITS.planSteps);
          changed.push('plan');
        }
      }
      for (const field of TEXT_LISTS) {
        if (Array.isArray(updates[field]) && updates[field].length) {
          doc[field] = appendUnique(doc[field], updates[field]);
          changed.push(field);
        }
      }
      for (const field of RESULT_LISTS) {
        const items = Array.isArray(updates[field]) ? updates[field] : [];
        for (const item of items) {
          const text = clip(typeof item === 'string' ? item : item?.text, LIMITS.item);
          if (!text) continue;
          const entry = { state: item?.state ?? state, text, timestamp: now };
          if (typeof item?.passed === 'boolean') entry.passed = item.passed;
          doc[field] = [...doc[field], entry].slice(-LIMITS.listItems);
          if (!changed.includes(field)) changed.push(field);
        }
      }
      if (isPlainObject(updates.variables)) {
        for (const [name, value] of Object.entries(updates.variables)) {
          const key = clip(name, LIMITS.variableName);
          if (!key || key === '__proto__') continue;
          if (value === null) delete doc.variables[key];
          else doc.variables[key] = clip(String(value), LIMITS.variableValue);
        }
        const names = Object.keys(doc.variables);
        for (const extra of names.slice(0, Math.max(0, names.length - LIMITS.variables))) delete doc.variables[extra];
        changed.push('variables');
      }
      if (Array.isArray(updates.invariantChecks)) {
        for (const check of updates.invariantChecks) {
          doc.invariantChecks = [...doc.invariantChecks, { ...check, timestamp: now }].slice(-LIMITS.checks);
        }
        if (updates.invariantChecks.length) changed.push('invariantChecks');
      }
      if (Array.isArray(updates.profileChecks)) {
        for (const check of updates.profileChecks) {
          doc.profileChecks = [...doc.profileChecks, { ...check, timestamp: now }].slice(-LIMITS.checks);
        }
        if (updates.profileChecks.length) changed.push('profileChecks');
      }
      if (Array.isArray(updates.proposals)) {
        const seen = new Set(doc.proposals.map((p) => p.content.toLowerCase()));
        for (const p of updates.proposals) {
          const content = clip(p?.content, LIMITS.item);
          if (!content || seen.has(content.toLowerCase()) || !['solutions', 'knowledge'].includes(p.category)) continue;
          seen.add(content.toLowerCase());
          doc.proposals = [...doc.proposals, { category: p.category, content, state }].slice(-LIMITS.proposals);
          if (!changed.includes('proposals')) changed.push('proposals');
        }
      }

      if (!changed.length) return doc;
      addLog(doc, { source, state, fields: changed, timestamp: now });
      doc.updatedAt = now;
      await this.#provider.set(workMemoryKey(taskId), doc);
      this.logger.debug('memory.work.update', { taskId, state, source, fields: changed });
      return doc;
    });
  }

  /**
   * Replace a text item (edit from the memory panel) or remove it (`content === null`).
   * @returns {Promise<object|null>} The document, or null when the item does not exist.
   */
  editItem(taskId, field, index, content) {
    if (![...TEXT_LISTS, 'plan'].includes(field)) throw new Error(`Field ${field} cannot be edited.`);
    return this.#queue.run(async () => {
      const doc = await this.#read(taskId);
      if (!Number.isInteger(index) || index < 0 || index >= doc[field].length) return null;
      if (content === null) doc[field].splice(index, 1);
      else doc[field][index] = clip(content, field === 'plan' ? LIMITS.planStep : LIMITS.item);
      addLog(doc, { source: 'user', state: null, fields: [field] });
      doc.updatedAt = new Date().toISOString();
      await this.#provider.set(workMemoryKey(taskId), doc);
      return doc;
    });
  }

  /** Record an event in the task's log without changing its data (e.g. a promotion). */
  note(taskId, { source, state = null, fields }) {
    return this.#queue.run(async () => {
      const doc = await this.#read(taskId);
      addLog(doc, { source, state, fields });
      await this.#provider.set(workMemoryKey(taskId), doc);
      return doc;
    });
  }

  /** Replace the whole document for a task (validated and normalised). */
  saveWorkMemory(taskId, value) {
    return this.#queue.run(async () => {
      const doc = normalize(taskId, value);
      addLog(doc, { source: 'user', state: null, fields: ['*'] });
      await this.#provider.set(workMemoryKey(taskId), doc);
      return doc;
    });
  }

  /** Empty every field but keep the document (and the task's reference to it). */
  clearWorkMemory(taskId) {
    return this.#queue.run(async () => {
      const doc = emptyWorkMemory(taskId);
      addLog(doc, { source: 'user', state: null, fields: ['cleared'] });
      await this.#provider.set(workMemoryKey(taskId), doc);
      this.logger.info('memory.work.clear', { taskId });
      return doc;
    });
  }

  deleteWorkMemory(taskId) {
    return this.#queue.run(async () => {
      const existed = await this.#provider.delete(workMemoryKey(taskId));
      this.logger.info('memory.work.delete', { taskId, existed });
      return existed;
    });
  }

  calculateTokenCount(doc) {
    return this.tokenCounter.countText(formatWorkMemory(doc));
  }

  async #read(taskId) {
    return normalize(taskId, await this.#provider.get(workMemoryKey(taskId)));
  }
}

function addLog(doc, { source, state, fields, timestamp = new Date().toISOString() }) {
  doc.log = [...(doc.log ?? []), { timestamp, source, state, fields }].slice(-LIMITS.log);
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
  if (Array.isArray(value.invariantChecks)) doc.invariantChecks = value.invariantChecks.filter(isPlainObject);
  if (Array.isArray(value.profileChecks)) doc.profileChecks = value.profileChecks.filter(isPlainObject);
  if (Array.isArray(value.proposals)) doc.proposals = value.proposals.filter((p) => isPlainObject(p) && typeof p.content === 'string');
  if (Array.isArray(value.log)) doc.log = value.log.filter(isPlainObject);
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

/**
 * Work memory as the text that goes into the context. '' when there is nothing
 * in it. The log, the profile checks, the suggestions and the invariant checks
 * are bookkeeping and stay out; only
 * the latest conflict is mentioned, so the model knows why it is re-planning.
 */
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
  const lastConflict = [...(doc.invariantChecks ?? [])].reverse().find((c) => c.ok === false);
  if (lastConflict) {
    const names = (lastConflict.conflicts ?? []).map((c) => `"${c.name}"`).join(', ');
    lines.push(`Last invariant conflict (${lastConflict.stage}): ${names}${lastConflict.resolution ? ` — ${lastConflict.resolution}` : ''}`);
  }
  return lines.join('\n');
}
