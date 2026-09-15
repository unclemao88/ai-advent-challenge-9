import { MemoryLayer, cleanText, cleanTextList, isPlainObject, isoTimestamp } from './memoryLayer.js';

/**
 * The fields of work memory. `single` fields hold one value that a new update
 * replaces; `list` fields accumulate entries.
 */
export const WORK_FIELDS = {
  task: { kind: 'single', label: 'Task' },
  currentState: { kind: 'single', label: 'Current state' },
  requirements: { kind: 'list', label: 'Requirements' },
  constraints: { kind: 'list', label: 'Constraints' },
  decisions: { kind: 'list', label: 'Decisions' },
  results: { kind: 'list', label: 'Intermediate results' },
  todos: { kind: 'list', label: 'TODO' },
  entities: { kind: 'list', label: 'Files and entities' },
};

/**
 * Work memory: what the agent needs to know about the task at hand —
 * requirements, decisions, constraints, progress. Cleared when the task is
 * done, without touching the conversation or long-term memory.
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
    for (const [field, { kind }] of Object.entries(WORK_FIELDS)) {
      task[field] = kind === 'single' ? cleanText(source[field]) : cleanTextList(source[field]);
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
        const text = cleanText(value);
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
}

export function emptyTask() {
  return {
    task: '',
    currentState: '',
    requirements: [],
    constraints: [],
    decisions: [],
    results: [],
    todos: [],
    entities: [],
    updatedAt: null,
  };
}
