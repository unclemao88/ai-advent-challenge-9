import { randomBytes } from 'node:crypto';

import { SerialQueue } from '../utils/serialQueue.js';
import { clip, isPlainObject } from '../utils/validate.js';

/**
 * Long-term memory: what is worth knowing after the current task is over.
 *
 * Three categories, one document each (`long-term/<category>.json`):
 *   profile    — standing preferences and facts about the user
 *   solutions  — procedures, configurations and fixes that worked
 *   knowledge  — anything else the user asked to keep
 *
 * Nothing is written here implicitly. Entries come from explicit user
 * commands ("remember: …"), from the memory panel, or from a model suggestion
 * the user approved with a click.
 *
 * Search is a keyword ranking done here, unless the backend provides its own
 * `search(query, options)` — the hook a vector database would use.
 */
export const CATEGORIES = ['profile', 'solutions', 'knowledge'];

export const CATEGORY_LABELS = {
  profile: 'Profile notes',
  solutions: 'Solutions',
  knowledge: 'Knowledge',
};

export const LIMITS = Object.freeze({ content: 2000, tags: 10, tag: 40, itemsPerCategory: 500 });

export class LongTermMemory {
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

  /** @returns {Promise<{profile: object[], solutions: object[], knowledge: object[]}>} */
  getLongTermMemory() {
    return this.#queue.run(() => this.#readAll());
  }

  /**
   * Save an entry. Saving the same content again in the same category returns
   * the existing entry instead of creating a duplicate.
   *
   * @param {{category: string, content: string, tags?: string[], source?: string}} fact
   * @returns {Promise<{fact: object, created: boolean}>}
   */
  saveFact({ category, content, tags = [], source = 'user' }) {
    assertCategory(category);
    const text = clip(content, LIMITS.content);
    if (!text) throw new Error('A long-term memory entry needs content.');
    return this.#queue.run(async () => {
      const items = await this.#read(category);
      const existing = items.find((item) => sameText(item.content, text));
      if (existing) return { fact: existing, created: false };

      const now = new Date().toISOString();
      const fact = { id: newId(), category, content: text, tags: cleanTags(tags), source: clip(source, 40), createdAt: now, updatedAt: now };
      items.push(fact);
      await this.#write(category, items.slice(-LIMITS.itemsPerCategory));
      this.logger.info('memory.long_term.save', { category, id: fact.id, source: fact.source });
      return { fact, created: true };
    });
  }

  /**
   * Update an entry's content, tags or category (moving it between documents).
   * @returns {Promise<object|null>} The updated entry, or null when the id is unknown.
   */
  updateFact(id, { content, tags, category }) {
    if (category !== undefined) assertCategory(category);
    return this.#queue.run(async () => {
      const found = await this.#find(id);
      if (!found) return null;
      const { items, index, category: from } = found;
      const fact = { ...items[index] };
      if (content !== undefined) {
        const text = clip(content, LIMITS.content);
        if (!text) throw new Error('A long-term memory entry needs content.');
        fact.content = text;
      }
      if (tags !== undefined) fact.tags = cleanTags(tags);
      fact.updatedAt = new Date().toISOString();

      const to = category ?? from;
      fact.category = to;
      if (to === from) {
        items[index] = fact;
        await this.#write(from, items);
      } else {
        items.splice(index, 1);
        const target = await this.#read(to);
        target.push(fact);
        await this.#write(to, target);
        await this.#write(from, items);
      }
      this.logger.info('memory.long_term.update', { id, category: to });
      return fact;
    });
  }

  /** @returns {Promise<boolean>} */
  deleteFact(id) {
    return this.#queue.run(async () => {
      const found = await this.#find(id);
      if (!found) return false;
      found.items.splice(found.index, 1);
      await this.#write(found.category, found.items);
      this.logger.info('memory.long_term.delete', { id, category: found.category });
      return true;
    });
  }

  /** Clear one category, or all of them when none is given. */
  clearMemory(category) {
    if (category !== undefined) assertCategory(category);
    return this.#queue.run(async () => {
      for (const c of category ? [category] : CATEGORIES) await this.#write(c, []);
      this.logger.info('memory.long_term.clear', { category: category ?? 'all' });
    });
  }

  /**
   * Rank entries by how well they match a query.
   *
   * @param {string} query
   * @param {{limit?: number, category?: string}} [options]
   * @returns {Promise<Array<object & {score: number}>>} Best match first; only entries that match.
   */
  async searchMemory(query, { limit = 20, category } = {}) {
    if (typeof this.#backend.search === 'function') {
      return this.#backend.search(query, { limit, category });
    }
    const all = await this.getLongTermMemory();
    const items = category ? all[category] : CATEGORIES.flatMap((c) => all[c]);
    return rank(items, query).slice(0, limit);
  }

  /**
   * The entries that go into a request, within a token budget.
   *
   * Everything is included while it fits. Beyond the budget, profile notes come
   * first (they apply to every answer), then the entries most relevant to the
   * query, then the newest. The result is grouped by category, in stored order.
   */
  async selectForContext(query, budgetTokens) {
    const all = await this.getLongTermMemory();
    const items = CATEGORIES.flatMap((c) => all[c]);
    if (this.tokenCounter.countText(formatLongTermMemory(all)) <= budgetTokens) {
      return { memory: all, included: items.length, total: items.length };
    }

    const scores = new Map(rank(items, query).map((item) => [item.id, item.score]));
    const ordered = [...items].sort((a, b) => (
      (b.category === 'profile') - (a.category === 'profile')
      || (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
      || String(b.updatedAt).localeCompare(String(a.updatedAt))
    ));

    const chosen = new Set();
    let used = 0;
    for (const item of ordered) {
      const cost = this.tokenCounter.countText(formatEntry(item)) + 1;
      if (used + cost > budgetTokens) continue;
      chosen.add(item.id);
      used += cost;
    }
    const memory = Object.fromEntries(CATEGORIES.map((c) => [c, all[c].filter((item) => chosen.has(item.id))]));
    return { memory, included: chosen.size, total: items.length };
  }

  calculateTokenCount(memory) {
    return this.tokenCounter.countText(formatLongTermMemory(memory));
  }

  async #readAll() {
    const result = {};
    for (const category of CATEGORIES) result[category] = await this.#read(category);
    return result;
  }

  async #read(category) {
    const doc = await this.#backend.get(category);
    const items = Array.isArray(doc?.items) ? doc.items : [];
    return items
      .filter((item) => isPlainObject(item) && typeof item.id === 'string' && typeof item.content === 'string')
      .map((item) => ({ ...item, category, tags: Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [] }));
  }

  async #find(id) {
    for (const category of CATEGORIES) {
      const items = await this.#read(category);
      const index = items.findIndex((item) => item.id === id);
      if (index !== -1) return { category, items, index };
    }
    return null;
  }

  #write(category, items) {
    return this.#backend.put(category, { version: 1, category, items, updatedAt: new Date().toISOString() });
  }
}

export function isCategory(value) {
  return CATEGORIES.includes(value);
}

function assertCategory(category) {
  if (!isCategory(category)) throw new Error(`Unknown long-term memory category: ${category}`);
}

function newId() {
  return `ltm_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

function sameText(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  for (const tag of tags) {
    const t = clip(String(tag ?? ''), LIMITS.tag).toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].slice(0, LIMITS.tags);
}

function words(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'how', 'what', 'do', 'i', 'my', 'me', 'with', 'can', 'you']);

function rank(items, query) {
  const terms = [...new Set(words(query).filter((w) => w.length > 1 && !STOP_WORDS.has(w)))];
  if (terms.length === 0) return [];
  return items
    .map((item) => {
      const content = words(item.content);
      const tags = item.tags.map((t) => t.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (tags.includes(term)) score += 3;
        if (content.includes(term)) score += 2;
        else if (content.some((w) => w.startsWith(term) || (w.length > 3 && term.startsWith(w)))) score += 1;
      }
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

function formatEntry(item) {
  const tags = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
  return `- ${item.content.replace(/\n/g, '\n  ')}${tags}`;
}

/** Long-term memory as the text that goes into the context. '' when empty. */
export function formatLongTermMemory(memory) {
  if (!memory) return '';
  const blocks = [];
  for (const category of CATEGORIES) {
    const items = memory[category] ?? [];
    if (items.length) blocks.push([`${CATEGORY_LABELS[category]}:`, ...items.map(formatEntry)].join('\n'));
  }
  return blocks.join('\n');
}
