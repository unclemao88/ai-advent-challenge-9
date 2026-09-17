import { randomUUID } from 'node:crypto';

import { MemoryLayer, cleanText, isPlainObject, isoTimestamp } from './memoryLayer.js';

const MAX_SOLUTION_CHARS = 4000;
const MAX_FACT_CHARS = 1000;
const MAX_TOPIC_CHARS = 100;

/**
 * Long-term memory: what stays useful after the current task is over.
 *
 * The three parts of long-term memory in the design are Profile, Solutions and
 * Knowledge. The profile is a layer of its own (src/memory/profile.js) because
 * the user edits it directly and it is attached to every request; this layer
 * holds the other two, one document — and so one file — each:
 *
 *   solutions   [{ "id", "problem", "solution", "savedAt" }]
 *   knowledge   [{ "id", "topic", "fact", "savedAt" }]
 *
 * Nothing lands here on its own. An entry is written only when the user asks
 * for it ("remember: …", "solution: … => …", "that worked") or when they add
 * it in the memory editor, so long-term memory never fills up with answers the
 * user never wanted kept.
 */
export class LongTermMemory extends MemoryLayer {
  static id = 'longTerm';
  static directory = 'long-term';

  get documents() {
    return { solutions: () => [], knowledge: () => [] };
  }

  normalize(documentName, value) {
    const entries = Array.isArray(value) ? value.filter(isPlainObject) : [];
    switch (documentName) {
      case 'solutions':
        return entries.map(normalizeSolution).filter((entry) => entry.problem && entry.solution);
      case 'knowledge':
        return entries.map(normalizeKnowledge).filter((entry) => entry.fact);
      default:
        return super.normalize(documentName, value);
    }
  }

  /** @returns {Promise<{solutions: object[], knowledge: object[]}>} */
  async getAll() {
    const data = await this.read();
    return { solutions: data.solutions, knowledge: data.knowledge };
  }

  /**
   * Apply categorised updates:
   *   { category: 'solutions', problem: '…', solution: '…' }
   *   { category: 'knowledge', topic: 'Node.js', fact: '…' }
   *
   * @returns {Promise<object[]>} The updates that changed something.
   */
  async applyUpdates(updates) {
    const applied = [];
    if (!updates?.length) return applied;

    await this.update((draft) => {
      const now = new Date().toISOString();
      for (const update of updates) {
        const change = applyOne(draft, update, now);
        if (change) applied.push(change);
      }
    });
    return applied;
  }

  /**
   * Replace both categories with what the user left in the memory editor.
   * Entries keep their id where the editor sent one back, so editing the text
   * of an entry does not turn it into a different entry.
   *
   * @param {{solutions?: unknown, knowledge?: unknown}} values
   */
  async replace(values) {
    const source = isPlainObject(values) ? values : {};
    const data = await this.update((draft) => {
      for (const name of ['solutions', 'knowledge']) {
        if (source[name] !== undefined) draft[name] = this.normalize(name, source[name]);
      }
    });
    return { solutions: data.solutions, knowledge: data.knowledge };
  }

  /**
   * Delete one entry.
   *
   * @param {'solutions'|'knowledge'} category
   * @param {string} id
   * @returns {Promise<boolean>} Whether an entry was actually removed.
   */
  async removeEntry(category, id) {
    if (category !== 'solutions' && category !== 'knowledge') return false;
    let removed = false;
    await this.update((draft) => {
      const kept = draft[category].filter((entry) => entry.id !== id);
      removed = kept.length !== draft[category].length;
      draft[category] = kept;
    });
    return removed;
  }
}

function applyOne(draft, update, now) {
  switch (update?.category) {
    case 'solutions': {
      const problem = cleanText(update.problem, MAX_SOLUTION_CHARS);
      const solution = cleanText(update.solution, MAX_SOLUTION_CHARS);
      if (!problem || !solution) return null;
      // The same problem solved again replaces the old answer instead of
      // leaving two entries that disagree.
      const existing = draft.solutions.find((s) => s.problem.toLowerCase() === problem.toLowerCase());
      if (existing) {
        if (existing.solution === solution) return null;
        existing.solution = solution;
        existing.savedAt = now;
        return { category: 'solutions', problem, solution, updated: true };
      }
      draft.solutions.push({ id: randomUUID(), problem, solution, savedAt: now });
      return { category: 'solutions', problem, solution };
    }
    case 'knowledge': {
      const topic = cleanText(update.topic, MAX_TOPIC_CHARS) || 'general';
      const fact = cleanText(update.fact, MAX_FACT_CHARS);
      if (!fact || draft.knowledge.some((k) => k.fact.toLowerCase() === fact.toLowerCase())) return null;
      draft.knowledge.push({ id: randomUUID(), topic, fact, savedAt: now });
      return { category: 'knowledge', topic, fact };
    }
    default:
      return null;
  }
}

function normalizeSolution(entry) {
  return {
    id: entryId(entry.id),
    problem: cleanText(entry.problem, MAX_SOLUTION_CHARS),
    solution: cleanText(entry.solution, MAX_SOLUTION_CHARS),
    savedAt: isoTimestamp(entry.savedAt),
  };
}

function normalizeKnowledge(entry) {
  return {
    id: entryId(entry.id),
    topic: cleanText(entry.topic, MAX_TOPIC_CHARS) || 'general',
    fact: cleanText(entry.fact, MAX_FACT_CHARS),
    savedAt: isoTimestamp(entry.savedAt),
  };
}

/** Keep a usable id, mint one for entries that predate ids or arrive without. */
function entryId(value) {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : randomUUID();
}
