import { randomBytes } from 'node:crypto';

import { SerialQueue } from '../utils/serialQueue.js';
import { clip, isPlainObject } from '../utils/validate.js';

/**
 * Long-term memory: what is worth knowing after the current task is over.
 *
 * Logically three parts:
 *   profile    — how the user wants answers. Owned by the ProfileManager
 *                (data/profile.json) and joined in here for reading.
 *   solutions  — approaches, configurations and fixes that were adopted
 *   knowledge  — persistent facts the agent should remember
 *
 * `solutions` and `knowledge` are two values in this layer's provider —
 * `data/long-term-memory.json` with the JSON provider.
 *
 * Nothing is written here implicitly. Entries come from an explicit user
 * command ("remember: …"), the memory panel, a promotion from work memory, or a
 * model suggestion the user approved with a click.
 */
export const STORED_CATEGORIES = ['solutions', 'knowledge'];
export const CATEGORIES = ['profile', ...STORED_CATEGORIES];

export const CATEGORY_LABELS = { profile: 'Profile', solutions: 'Solutions', knowledge: 'Knowledge' };

export const LIMITS = Object.freeze({ content: 2000, tags: 10, tag: 40, itemsPerCategory: 500 });

export class LongTermMemory {
  #provider;
  #queue = new SerialQueue();

  /**
   * @param {{provider: object, tokenCounter: object, logger: object,
   *          retriever: import('./retrieval.js').KeywordRetriever}} options
   */
  constructor({ provider, tokenCounter, logger, retriever }) {
    this.#provider = provider;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
    this.retriever = retriever;
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

  /** @returns {Promise<{solutions: object[], knowledge: object[]}>} */
  getEntries() {
    return this.#queue.run(() => this.#readAll());
  }

  /** Replace the stored categories (validated). */
  saveEntries(value) {
    if (!isPlainObject(value)) throw new Error('Long-term memory must be an object.');
    return this.#queue.run(async () => {
      for (const category of STORED_CATEGORIES) {
        if (value[category] === undefined) continue;
        if (!Array.isArray(value[category])) throw new Error(`${category} must be an array.`);
        await this.#write(category, value[category].map((item) => sanitizeEntry(item, category)).filter(Boolean));
      }
      return this.#readAll();
    });
  }

  /**
   * Save an entry. Saving the same content again in the same category returns
   * the existing entry instead of creating a duplicate.
   *
   * @param {{category: string, content: string, tags?: string[], pinned?: boolean, source?: string, origin?: object}} entry
   * @returns {Promise<{entry: object, created: boolean}>}
   */
  addEntry({ category, content, tags = [], pinned = false, source = 'user', origin }) {
    assertCategory(category);
    const text = clip(content, LIMITS.content);
    if (!text) throw new Error('A long-term memory entry needs content.');
    return this.#queue.run(async () => {
      const items = await this.#read(category);
      const existing = items.find((item) => sameText(item.content, text));
      if (existing) return { entry: existing, created: false };

      const now = new Date().toISOString();
      const entry = {
        id: newId(), category, content: text, tags: cleanTags(tags), pinned: Boolean(pinned),
        source: clip(source, 40), createdAt: now, updatedAt: now,
      };
      if (isPlainObject(origin)) entry.origin = origin;
      items.push(entry);
      await this.#write(category, items.slice(-LIMITS.itemsPerCategory));
      this.logger.info('memory.long_term.add', { category, id: entry.id, source: entry.source });
      return { entry, created: true };
    });
  }

  /** @returns {Promise<object|null>} The updated entry, or null when the id is unknown. */
  updateEntry(id, { content, tags, pinned, category }) {
    if (category !== undefined) assertCategory(category);
    return this.#queue.run(async () => {
      const found = await this.#find(id);
      if (!found) return null;
      const { items, index, category: from } = found;
      const entry = { ...items[index] };
      if (content !== undefined) {
        const text = clip(content, LIMITS.content);
        if (!text) throw new Error('A long-term memory entry needs content.');
        entry.content = text;
      }
      if (tags !== undefined) entry.tags = cleanTags(tags);
      if (pinned !== undefined) entry.pinned = Boolean(pinned);
      entry.updatedAt = new Date().toISOString();

      const to = category ?? from;
      entry.category = to;
      if (to === from) {
        items[index] = entry;
        await this.#write(from, items);
      } else {
        items.splice(index, 1);
        const target = await this.#read(to);
        target.push(entry);
        await this.#write(to, target);
        await this.#write(from, items);
      }
      this.logger.info('memory.long_term.update', { id, category: to });
      return entry;
    });
  }

  /** @returns {Promise<boolean>} */
  deleteEntry(id) {
    return this.#queue.run(async () => {
      const found = await this.#find(id);
      if (!found) return false;
      found.items.splice(found.index, 1);
      await this.#write(found.category, found.items);
      this.logger.info('memory.long_term.delete', { id, category: found.category });
      return true;
    });
  }

  clear(category) {
    if (category !== undefined) assertCategory(category);
    return this.#queue.run(async () => {
      for (const c of category ? [category] : STORED_CATEGORIES) await this.#write(c, []);
      this.logger.info('memory.long_term.clear', { category: category ?? 'all' });
    });
  }

  /**
   * The entries relevant to `query`, within a token budget.
   * @returns {Promise<{memory: {solutions: object[], knowledge: object[]}, selected: object[], considered: number}>}
   */
  async retrieve(query, budgetTokens) {
    const all = await this.getEntries();
    const items = STORED_CATEGORIES.flatMap((c) => all[c]);
    const { items: selected, considered } = this.retriever.select(items, query, {
      budgetTokens,
      cost: (item) => this.tokenCounter.countText(formatEntry(item)) + 1,
    });
    const ids = new Set(selected.map((item) => item.id));
    // Grouped by category, in stored order, so the context reads naturally.
    const memory = Object.fromEntries(STORED_CATEGORIES.map((c) => [c, all[c].filter((item) => ids.has(item.id))]));
    return {
      memory,
      selected: selected.map(({ id, category, score, reasons }) => ({ id, category, score, reasons })),
      considered,
    };
  }

  async #readAll() {
    const result = {};
    for (const category of STORED_CATEGORIES) result[category] = await this.#read(category);
    return result;
  }

  async #read(category) {
    const items = await this.#provider.get(category);
    return Array.isArray(items) ? items.map((item) => sanitizeEntry(item, category)).filter(Boolean) : [];
  }

  async #find(id) {
    for (const category of STORED_CATEGORIES) {
      const items = await this.#read(category);
      const index = items.findIndex((item) => item.id === id);
      if (index !== -1) return { category, items, index };
    }
    return null;
  }

  #write(category, items) {
    return this.#provider.set(category, items);
  }
}

export function isCategory(value) {
  return STORED_CATEGORIES.includes(value);
}

function assertCategory(category) {
  if (!isCategory(category)) throw new Error(`Unknown long-term memory category: ${category}`);
}

function sanitizeEntry(item, category) {
  if (!isPlainObject(item) || typeof item.content !== 'string' || !item.content.trim()) return null;
  return {
    ...item,
    id: typeof item.id === 'string' && /^ltm_[a-z0-9]+$/.test(item.id) ? item.id : newId(),
    category,
    tags: cleanTags(item.tags),
    pinned: Boolean(item.pinned),
  };
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
    const t = clip(String(tag ?? ''), LIMITS.tag).toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (t) seen.add(t);
  }
  return [...seen].slice(0, LIMITS.tags);
}

export function formatEntry(item) {
  const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
  return `- (${item.id}) ${item.content.replace(/\n/g, '\n  ')}${tags}`;
}

/** Solutions and knowledge as the text that goes into the context. '' when empty. */
export function formatLongTermMemory(memory) {
  if (!memory) return '';
  const blocks = [];
  for (const category of STORED_CATEGORIES) {
    const items = memory[category] ?? [];
    if (items.length) blocks.push([`${CATEGORY_LABELS[category]}:`, ...items.map(formatEntry)].join('\n'));
  }
  return blocks.join('\n');
}
