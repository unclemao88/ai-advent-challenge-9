import { MemoryLayer, cleanText, cleanTextList, isPlainObject, isoTimestamp } from './memoryLayer.js';

const PROFILE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_SOLUTION_CHARS = 4000;

/**
 * Long-term memory: what stays useful across conversations and tasks.
 *
 * One document — and so one JSON file — per category:
 *   profile      { "name": "Max", "location": "Riga" }
 *   preferences  ["Prefers short answers"]
 *   solutions    [{ "problem", "solution", "savedAt" }]
 *   knowledge    [{ "topic", "fact", "savedAt" }]
 */
export class LongTermMemory extends MemoryLayer {
  static id = 'longTerm';
  static directory = 'long-term';

  get documents() {
    return {
      profile: () => ({}),
      preferences: () => [],
      solutions: () => [],
      knowledge: () => [],
    };
  }

  normalize(documentName, value) {
    switch (documentName) {
      case 'profile':
        return normalizeProfile(value);
      case 'preferences':
        return cleanTextList(value, 500);
      case 'solutions':
        return (Array.isArray(value) ? value : [])
          .filter(isPlainObject)
          .map((entry) => ({
            problem: cleanText(entry.problem, MAX_SOLUTION_CHARS),
            solution: cleanText(entry.solution, MAX_SOLUTION_CHARS),
            savedAt: isoTimestamp(entry.savedAt),
          }))
          .filter((entry) => entry.problem && entry.solution);
      case 'knowledge':
        return (Array.isArray(value) ? value : [])
          .filter(isPlainObject)
          .map((entry) => ({
            topic: cleanText(entry.topic, 100) || 'general',
            fact: cleanText(entry.fact, 1000),
            savedAt: isoTimestamp(entry.savedAt),
          }))
          .filter((entry) => entry.fact);
      default:
        return super.normalize(documentName, value);
    }
  }

  /**
   * Apply categorised updates:
   *   { category: 'profile', key: 'name', value: 'Max' }
   *   { category: 'preferences', value: 'Short answers' }
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
}

function applyOne(draft, update, now) {
  switch (update?.category) {
    case 'profile': {
      const key = cleanText(update.key, 40);
      const value = cleanText(update.value, 200);
      if (!PROFILE_KEY.test(key) || !value || draft.profile[key] === value) return null;
      draft.profile[key] = value;
      return { category: 'profile', key, value };
    }
    case 'preferences': {
      const value = cleanText(update.value, 500);
      if (!value || draft.preferences.some((p) => p.toLowerCase() === value.toLowerCase())) return null;
      draft.preferences.push(value);
      return { category: 'preferences', value };
    }
    case 'solutions': {
      const problem = cleanText(update.problem, MAX_SOLUTION_CHARS);
      const solution = cleanText(update.solution, MAX_SOLUTION_CHARS);
      if (!problem || !solution || draft.solutions.some((s) => s.problem === problem)) return null;
      draft.solutions.push({ problem, solution, savedAt: now });
      return { category: 'solutions', problem, solution };
    }
    case 'knowledge': {
      const topic = cleanText(update.topic, 100) || 'general';
      const fact = cleanText(update.fact, 1000);
      if (!fact || draft.knowledge.some((k) => k.fact.toLowerCase() === fact.toLowerCase())) return null;
      draft.knowledge.push({ topic, fact, savedAt: now });
      return { category: 'knowledge', topic, fact };
    }
    default:
      return null;
  }
}

function normalizeProfile(value) {
  if (!isPlainObject(value)) return {};
  const profile = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = cleanText(entry, 200);
    if (PROFILE_KEY.test(key) && text) profile[key] = text;
  }
  return profile;
}
