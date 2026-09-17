import { MemoryLayer, cleanText, cleanTextList, isPlainObject, isoTimestamp } from './memoryLayer.js';

/**
 * The fields of work memory. `single` fields hold one value that a new update
 * replaces; `list` fields accumulate entries.
 */
export const WORK_FIELDS = {
  task: { kind: 'single', label: 'Task', max: 2000 },
  currentState: { kind: 'single', label: 'Current state', max: 2000 },
  requirements: { kind: 'list', label: 'Requirements', max: 500 },
  constraints: { kind: 'list', label: 'Constraints', max: 500 },
  decisions: { kind: 'list', label: 'Decisions', max: 500 },
  facts: { kind: 'list', label: 'Facts found', max: 500 },
  variables: { kind: 'list', label: 'Variables', max: 500 },
  results: { kind: 'list', label: 'Intermediate results', max: 500 },
  todos: { kind: 'list', label: 'TODO', max: 500 },
};

/**
 * Work memory: what the agent needs to know about the task at hand —
 * requirements, decisions, constraints, facts discovered, progress. It is
 * cleared when the task is done, without touching the conversation or
 * long-term memory.
 *
 * It deliberately does *not* hold the conversation: only facts the user stated
 * as task information ("task: …", "decision: …") land here, so the layer stays
 * a summary of the task rather than a second copy of the chat.
 *
 * Stored as one document, `current-task`.
 */
export class WorkMemory extends MemoryLayer {
  static id = 'work';
  static directory = 'work';

  get documents() {
    return { 'current-task': emptyTask };
  }

  normalize(documentName, value) {
    const source = isPlainObject(value) ? value : {};
    const task = emptyTask();
    for (const [field, { kind, max }] of Object.entries(WORK_FIELDS)) {
      task[field] = kind === 'single' ? cleanText(source[field], max) : cleanTextList(source[field], max);
    }
    task.updatedAt = isoTimestamp(source.updatedAt);
    return task;
  }

  /** @returns {Promise<ReturnType<typeof emptyTask>>} */
  async getTask() {
    return (await this.read())['current-task'];
  }

  /**
   * Apply updates such as `{ field: 'decisions', value: 'Use Express' }`.
   *
   * @param {Array<{field: string, value: string}>} updates
   * @returns {Promise<Array<{field: string, value: string}>>} The updates that
   *          changed something; duplicates and unknown fields are skipped.
   */
  async applyUpdates(updates) {
    const applied = [];
    if (!updates?.length) return applied;

    await this.update((draft) => {
      const task = draft['current-task'];
      for (const { field, value } of updates) {
        const definition = WORK_FIELDS[field];
        const text = cleanText(value, definition?.max);
        if (!definition || !text) continue;

        if (definition.kind === 'single') {
          if (task[field] === text) continue;
          task[field] = text;
        } else {
          if (task[field].some((entry) => entry.toLowerCase() === text.toLowerCase())) continue;
          task[field].push(text);
        }
        applied.push({ field, value: text });
      }
      if (applied.length) task.updatedAt = new Date().toISOString();
    });
    return applied;
  }

  /**
   * Replace the whole task with what the user typed in the memory editor.
   * Everything is normalised on the way in, so hand-editing cannot put the
   * layer into a shape the context builder does not understand.
   *
   * @param {Record<string, unknown>} values
   */
  async replace(values) {
    const next = this.normalize('current-task', values);
    const data = await this.update((draft) => {
      const before = draft['current-task'];
      next.updatedAt = JSON.stringify(stripTimestamp(before)) === JSON.stringify(stripTimestamp(next))
        ? before.updatedAt
        : new Date().toISOString();
      draft['current-task'] = next;
    });
    return data['current-task'];
  }
}

export function emptyTask() {
  const task = { updatedAt: null };
  for (const [field, { kind }] of Object.entries(WORK_FIELDS)) {
    task[field] = kind === 'single' ? '' : [];
  }
  return task;
}

function stripTimestamp({ updatedAt, ...rest }) { // eslint-disable-line no-unused-vars
  return rest;
}
