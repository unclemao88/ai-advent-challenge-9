/**
 * The contract every storage backend implements: a flat key → JSON document store.
 *
 * Memory layers, the profile manager and the task manager only ever call these
 * methods, so a backend can be swapped (SQLite, PostgreSQL, a vector database)
 * without touching them. To add one, subclass this and register it in
 * registry.js. A backend may also implement `search(query, options)`; the
 * long-term memory uses it instead of its built-in keyword search when present.
 */
export class StorageBackend {
  /** @param {string} type Registry key, e.g. "json". */
  constructor(type) {
    this.type = type;
  }

  /** `true` when documents survive an application restart. */
  get persistent() {
    return false;
  }

  /** Human-readable location, relative to the data directory. Never an absolute path. */
  get location() {
    return '(process memory)';
  }

  /** @returns {Promise<unknown>} The document, or `undefined` if it does not exist. */
  async get(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement get()`);
  }

  /** Store a JSON-serialisable document. */
  async put(key, value) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement put()`);
  }

  /** @returns {Promise<boolean>} Whether the document existed. */
  async delete(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement delete()`);
  }

  /** @returns {Promise<string[]>} Keys, optionally only those starting with `prefix`. */
  async list(prefix = '') { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement list()`);
  }

  /**
   * Copy every document somewhere safe before a storage change writes into this
   * backend. Backends without anything worth saving return null.
   *
   * @returns {Promise<string|null>} Where the copy went, relative to the data directory.
   */
  async snapshot() {
    return null;
  }
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Keys are chosen by the code, but they can contain ids from requests, so they
 * are validated here as well: no separators, no dots, nothing that could make a
 * file-based backend leave its directory.
 */
export function assertKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  return key;
}
