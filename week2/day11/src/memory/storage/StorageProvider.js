/**
 * The contract every memory storage backend implements.
 *
 * A memory layer keeps a few named *documents* (plain JSON values such as
 * "conversation" or "profile") and never learns where they end up. To add a
 * backend — SQLite, Redis, an encrypted file — subclass this and register it in
 * storageManager.js; nothing else in the application changes.
 */
export class StorageProvider {
  /** @param {string} mode The registry key, e.g. "json". */
  constructor(mode) {
    this.mode = mode;
  }

  /** `false` means the layer must not be used at all — not read, not sent. */
  get enabled() {
    return true;
  }

  /** `true` when the data survives an application restart. */
  get persistent() {
    return false;
  }

  /**
   * @param {string} documentName
   * @returns {Promise<unknown>} The stored value, or `undefined` if there is none.
   */
  async read(documentName) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement read()`);
  }

  /**
   * @param {string} documentName
   * @param {unknown} value A JSON-serialisable value.
   */
  async write(documentName, value) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} does not implement write()`);
  }
}

const DOCUMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Document names are chosen by the code, never by a request, but they are still
 * validated: a name can never contain a path separator or "..", so a provider
 * that maps names to files cannot be steered outside its directory.
 */
export function assertDocumentName(name) {
  if (typeof name !== 'string' || !DOCUMENT_NAME.test(name)) {
    throw new Error(`Invalid memory document name: ${JSON.stringify(name)}`);
  }
}
