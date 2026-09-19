import { StorageProvider, assertKey } from './StorageProvider.js';

/**
 * Keeps values in process memory only. Useful for a private session: nothing
 * of that layer touches the disk, and everything is gone after a restart.
 * Values are cloned on the way in and out, exactly like a real store.
 */
export class InMemoryStorage extends StorageProvider {
  #values = new Map();

  constructor() {
    super('memory');
  }

  async get(key) {
    const value = this.#values.get(assertKey(key));
    return value === undefined ? undefined : structuredClone(value);
  }

  async set(key, value) {
    this.#values.set(assertKey(key), structuredClone(value));
  }

  async delete(key) {
    return this.#values.delete(assertKey(key));
  }

  async keys() {
    return [...this.#values.keys()].sort();
  }
}
