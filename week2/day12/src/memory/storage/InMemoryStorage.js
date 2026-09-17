import { StorageProvider, assertDocumentName } from './StorageProvider.js';

/** Keeps documents in process memory. Everything is gone after a restart. */
export class InMemoryStorage extends StorageProvider {
  #documents = new Map();

  constructor() {
    super('memory');
  }

  async read(documentName) {
    assertDocumentName(documentName);
    // Copies in and out, so a caller mutating a value cannot change the store.
    return this.#documents.has(documentName)
      ? structuredClone(this.#documents.get(documentName))
      : undefined;
  }

  async write(documentName, value) {
    assertDocumentName(documentName);
    this.#documents.set(documentName, structuredClone(value));
  }
}
