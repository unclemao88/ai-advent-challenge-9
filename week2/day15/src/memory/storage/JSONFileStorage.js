import path from 'node:path';

import { StorageProvider, assertKey } from './StorageProvider.js';
import { CorruptJsonFileError, quarantineFile, readJsonFile, writeJsonFile } from '../../persistence/jsonFile.js';
import { displayLocation, resolveInside } from '../../persistence/dataPaths.js';
import { SerialQueue } from '../../utils/serialQueue.js';
import { isPlainObject } from '../../utils/validate.js';

/**
 * One JSON file per layer, holding a plain object of `key → value`.
 *
 *   data/memory/long-term.json   { "solutions": [...], "knowledge": [...] }
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
   *        `file` is relative to `dataDir`, e.g. "memory/long-term.json".
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
    return displayLocation(this.dataDir, this.file);
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
