import path from 'node:path';

import { StorageProvider, assertDocumentName } from './StorageProvider.js';
import { CorruptJsonFileError, quarantineFile, readJsonFile, writeJsonFile } from '../../utils/jsonFile.js';

/**
 * Persists each document as `<directory>/<document>.json`.
 *
 * Every layer gets its own directory (data/short-term, data/work,
 * data/long-term), so the layers are physically separate on disk.
 */
export class JsonFileStorage extends StorageProvider {
  /**
   * @param {{directory: string, logger?: Pick<Console, 'warn'>}} options
   */
  constructor({ directory, logger = console }) {
    super('json');
    this.directory = path.resolve(directory);
    this.logger = logger;
  }

  get persistent() {
    return true;
  }

  async read(documentName) {
    const file = this.fileFor(documentName);
    try {
      return await readJsonFile(file);
    } catch (err) {
      if (!(err instanceof CorruptJsonFileError)) throw err;
      // Refusing to start would lock the user out; silently overwriting would
      // destroy the memory. Moving the file aside keeps it for recovery.
      const backup = await quarantineFile(file);
      this.logger.warn(`${file} was not valid JSON. Moved it to ${backup}; the document starts empty.`);
      return undefined;
    }
  }

  // async, so an invalid name rejects like every other failure instead of throwing synchronously.
  async write(documentName, value) {
    await writeJsonFile(this.fileFor(documentName), value);
  }

  /** The file behind a document, guaranteed to sit directly in this directory. */
  fileFor(documentName) {
    assertDocumentName(documentName);
    const file = path.resolve(this.directory, `${documentName}.json`);
    if (path.dirname(file) !== this.directory) {
      throw new Error(`Refusing to access a file outside ${this.directory}`);
    }
    return file;
  }
}
