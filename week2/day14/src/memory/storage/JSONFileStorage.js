import path from 'node:path';

import { StorageProvider, assertKey } from './StorageProvider.js';
import { CorruptJsonFileError, quarantineFile, readJsonFile, writeJsonFile } from '../../utils/jsonFile.js';
import { SerialQueue } from '../../utils/serialQueue.js';
import { isPlainObject } from '../../utils/validate.js';

/**
 * One JSON file per layer, holding a plain object of `key → value`.
 *
 *   data/long-term-memory.json   { "solutions": [...], "knowledge": [...] }
 *
 * Writes are atomic (temporary file + fsync + rename) and serialised, so two
 * updates never interleave. With `backup` the previous version is kept as
 * `<file>.bak`. A file that is not valid JSON is moved aside (never
 * overwritten) and the layer reads as empty, so a bad hand-edit cannot take
 * the app down.
 *
 * The file must live inside the data directory; anything else is refused.
 */
export class JSONFileStorage extends StorageProvider {
  #queue = new SerialQueue();

  /**
   * @param {{file: string, dataDir: string, backup?: boolean, logger: object}} options
   *        `file` is a bare file name inside `dataDir`.
   */
  constructor({ file, dataDir, backup = true, logger }) {
    super('json');
    this.dataDir = path.resolve(dataDir);
    this.file = resolveInside(this.dataDir, file);
    this.backup = backup;
    this.logger = logger;
  }

  get persistent() {
    return true;
  }

  get location() {
    return `data/${path.basename(this.file)}`;
  }

  /** Create the file with an empty object when it is missing. Never overwrites. */
  init() {
    return this.#queue.run(async () => {
      const current = await this.#read();
      if (current === null) await writeJsonFile(this.file, {}, { backup: false });
    });
  }

  get(key) {
    assertKey(key);
    return this.#queue.run(async () => {
      const all = (await this.#read()) ?? {};
      return Object.hasOwn(all, key) ? all[key] : undefined;
    });
  }

  set(key, value) {
    assertKey(key);
    return this.#queue.run(async () => {
      const all = (await this.#read()) ?? {};
      all[key] = value;
      await this.#write(all);
    });
  }

  delete(key) {
    assertKey(key);
    return this.#queue.run(async () => {
      const all = (await this.#read()) ?? {};
      if (!Object.hasOwn(all, key)) return false;
      delete all[key];
      await this.#write(all);
      return true;
    });
  }

  keys() {
    return this.#queue.run(async () => Object.keys((await this.#read()) ?? {}).sort());
  }

  getAll() {
    return this.#queue.run(async () => (await this.#read()) ?? {});
  }

  replaceAll(entries) {
    for (const key of Object.keys(entries)) assertKey(key);
    return this.#queue.run(() => this.#write({ ...entries }));
  }

  /** @returns {Promise<object|null>} null when the file is missing, empty or was quarantined. */
  async #read() {
    let value;
    try {
      value = await readJsonFile(this.file);
    } catch (err) {
      if (!(err instanceof CorruptJsonFileError)) throw err;
      const moved = await quarantineFile(this.file);
      this.logger?.warn('storage.corrupt_file_quarantined', { location: this.location, movedTo: path.basename(moved) });
      return null;
    }
    if (value === undefined) return null;
    if (!isPlainObject(value)) {
      const moved = await quarantineFile(this.file);
      this.logger?.warn('storage.unexpected_shape_quarantined', { location: this.location, movedTo: path.basename(moved) });
      return null;
    }
    return value;
  }

  #write(all) {
    return writeJsonFile(this.file, all, { backup: this.backup });
  }
}

const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.json$/;

/** A bare, safe file name inside `dir`. Throws for anything that could escape it. */
export function resolveInside(dir, name) {
  if (typeof name !== 'string' || !FILE_NAME.test(name) || name.includes('..')) {
    throw new Error(`Invalid data file name: ${JSON.stringify(name)}`);
  }
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== dir) throw new Error('Refusing to access a file outside the data directory');
  return file;
}
