import { StorageBackend, assertKey } from './StorageBackend.js';

/**
 * Keeps documents in process memory only. Useful for a private session: nothing
 * of that layer touches the disk, and everything is gone after a restart.
 * Documents are cloned on the way in and out, exactly like a real store.
 */
export class MemoryBackend extends StorageBackend {
  #docs = new Map();

  constructor() {
    super('memory');
  }

  async init() {}

  async get(key) {
    const value = this.#docs.get(assertKey(key));
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key, value) {
    this.#docs.set(assertKey(key), structuredClone(value));
  }

  async delete(key) {
    return this.#docs.delete(assertKey(key));
  }

  async list(prefix = '') {
    return [...this.#docs.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
