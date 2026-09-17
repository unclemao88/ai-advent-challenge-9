import { SerialQueue } from '../utils/serialQueue.js';

/**
 * Behaviour shared by the three memory layers: named documents with defaults,
 * serialised updates, clearing, and hot-swapping the storage provider.
 *
 * A subclass declares its documents and how to repair a loaded value; it never
 * touches a provider directly, which is what keeps storage behaviour out of the
 * memory logic.
 */
export class MemoryLayer {
  #storage;
  // Every read-modify-write, clear and storage switch for this layer goes
  // through this queue, so concurrent requests cannot lose each other's updates.
  #queue = new SerialQueue();

  /**
   * @param {{storage: import('./storage/StorageProvider.js').StorageProvider}} options
   */
  constructor({ storage }) {
    this.#storage = storage;
  }

  /**
   * Document name → factory for its empty value. Overridden by subclasses.
   * @returns {Record<string, () => unknown>}
   */
  get documents() {
    return {};
  }

  /**
   * Repair a loaded document so the rest of the app can trust its shape.
   * Overridden by subclasses; the default only fills in a missing value.
   */
  normalize(documentName, value) {
    return value === undefined ? this.documents[documentName]() : value;
  }

  get storageMode() {
    return this.#storage.mode;
  }

  get enabled() {
    return this.#storage.enabled;
  }

  get persistent() {
    return this.#storage.persistent;
  }

  /** Create any missing documents, so a first start leaves the files in place. */
  init() {
    return this.#queue.run(() => this.#createMissingDocuments());
  }

  /** @returns {Promise<Record<string, unknown>>} Every document, normalised. */
  read() {
    return this.#queue.run(() => this.#readAll());
  }

  /**
   * Read-modify-write under the layer's lock.
   *
   * @param {(data: Record<string, unknown>) => void} mutator Edits `data` in place.
   * @returns {Promise<Record<string, unknown>>} The data after the update.
   */
  update(mutator) {
    return this.#queue.run(async () => {
      const before = await this.#readAll();
      const after = structuredClone(before);
      mutator(after);
      await this.#writeChanged(before, after);
      return after;
    });
  }

  /** Reset every document of this layer to its empty value. */
  clear() {
    return this.#queue.run(() => this.#writeAll(this.#emptyData()));
  }

  /**
   * Move the layer to another storage provider.
   *
   * Between two enabled providers the current contents are carried over, so
   * changing *where* memory is kept never changes *what* the agent remembers.
   * Switching to disabled stores nothing; switching back from disabled starts
   * from whatever the new provider already holds (for JSON, the files on disk).
   */
  switchStorage(nextStorage) {
    return this.#queue.run(async () => {
      const carried = this.#storage.enabled && nextStorage.enabled ? await this.#readAll() : null;
      this.#storage = nextStorage;
      if (carried) await this.#writeAll(carried);
      else await this.#createMissingDocuments();
    });
  }

  #emptyData() {
    return Object.fromEntries(Object.entries(this.documents).map(([name, empty]) => [name, empty()]));
  }

  async #readAll() {
    const data = {};
    for (const name of Object.keys(this.documents)) {
      data[name] = this.normalize(name, await this.#storage.read(name));
    }
    return data;
  }

  async #writeAll(data) {
    for (const name of Object.keys(this.documents)) {
      await this.#storage.write(name, data[name]);
    }
  }

  async #writeChanged(before, after) {
    for (const name of Object.keys(this.documents)) {
      if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) {
        await this.#storage.write(name, this.normalize(name, after[name]));
      }
    }
  }

  async #createMissingDocuments() {
    if (!this.#storage.persistent) return;
    for (const [name, empty] of Object.entries(this.documents)) {
      if ((await this.#storage.read(name)) === undefined) await this.#storage.write(name, empty());
    }
  }
}

// --- Small helpers the layers share -----------------------------------------

/** A trimmed, length-capped string, or '' for anything that is not a string. */
export function cleanText(value, maxLength = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** Strings only, trimmed, empty entries and case-insensitive duplicates removed. */
export function cleanTextList(value, maxLength) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const text = cleanText(item, maxLength);
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/** A plain object (not an array, not null). */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An ISO 8601 timestamp, or the fallback when the value is not a valid date. */
export function isoTimestamp(value, fallback = null) {
  const date = value instanceof Date ? value : new Date(value);
  return value != null && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback;
}
