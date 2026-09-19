/**
 * The contract every storage provider implements: a small key → JSON value store.
 *
 * Each memory layer owns exactly one provider instance, so the layers can never
 * share a file or a table. The memory classes only call these methods, which is
 * what lets a layer move to SQLite, PostgreSQL or Redis without the memory
 * manager changing:
 *
 *   SQLite / PostgreSQL   one table per layer: (key TEXT PRIMARY KEY, value JSON)
 *   Redis                 one hash per layer: HGET/HSET/HDEL/HKEYS <layer> <key>
 *
 * To add one, subclass this and register it in registry.js.
 */
export class StorageProvider {
  /** @param {string} type Registry key, e.g. "json". */
  constructor(type) {
    this.type = type;
  }

  /** `true` when values survive an application restart. */
  get persistent() {
    return false;
  }

  /** Human-readable location, relative to the data directory. Never an absolute path. */
  get location() {
    return '(process memory)';
  }

  /** Prepare the store (create the file, open a connection). Must not destroy data. */
  async init() {}

  /** @returns {Promise<unknown>} The value, or `undefined` when the key does not exist. */
  async get(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement get()`);
  }

  /** Store a JSON-serialisable value. */
  async set(key, value) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement set()`);
  }

  /** @returns {Promise<boolean>} Whether the key existed. */
  async delete(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement delete()`);
  }

  /** @returns {Promise<string[]>} Every key, sorted. */
  async keys() {
    throw new Error(`${this.constructor.name} does not implement keys()`);
  }

  /** @returns {Promise<Record<string, unknown>>} Every key with its value. */
  async getAll() {
    const out = {};
    for (const key of await this.keys()) out[key] = await this.get(key);
    return out;
  }

  /** Replace the whole content (used when a layer moves to another provider). */
  async replaceAll(entries) {
    for (const key of await this.keys()) await this.delete(key);
    for (const [key, value] of Object.entries(entries)) await this.set(key, value);
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Keys are chosen by the code, but may contain ids from requests: validate them anyway. */
export function assertKey(key) {
  if (typeof key !== 'string' || !KEY.test(key) || key === '__proto__') {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  return key;
}
