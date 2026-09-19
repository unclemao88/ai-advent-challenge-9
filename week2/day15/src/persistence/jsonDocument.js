import path from 'node:path';

import { CorruptJsonFileError, deleteJsonFile, quarantineFile, readJsonFile, writeJsonFile } from './jsonFile.js';
import { displayLocation, resolveInside } from './dataPaths.js';
import { SerialQueue } from '../utils/serialQueue.js';

/**
 * A single JSON document on disk with serialised read-modify-write.
 *
 * Used for the files that are always plain JSON whatever the memory storage
 * configuration says: profile, invariants, tasks, chat history, storage
 * configuration. `update(fn)` reads the latest version, applies `fn` and
 * writes the result atomically under a lock, so concurrent requests never
 * overwrite each other's change.
 *
 * `normalize` turns what is on disk into the in-memory shape; `serialize`
 * turns it back (e.g. invariants are grouped by category on disk).
 */
export class JsonDocument {
  #queue = new SerialQueue();

  /**
   * @param {{dataDir: string, file: string, empty: () => object, normalize?: (value: unknown) => object,
   *          serialize?: (doc: object) => object, backup?: boolean, logger?: object}} options
   *        `file` is relative to `dataDir`, e.g. "profile/profile.json".
   */
  constructor({ dataDir, file, empty, normalize = (v) => v, serialize = (v) => v, backup = true, logger }) {
    this.dataDir = path.resolve(dataDir);
    this.file = resolveInside(this.dataDir, file);
    this.empty = empty;
    this.normalize = normalize;
    this.serialize = serialize;
    this.backup = backup;
    this.logger = logger;
  }

  get location() {
    return displayLocation(this.dataDir, this.file);
  }

  /** Create the file with the empty document if it is missing. Never overwrites. @returns {Promise<boolean>} existed */
  init() {
    return this.#queue.run(async () => {
      const exists = (await this.#readRaw()) !== undefined;
      if (!exists) await writeJsonFile(this.file, this.serialize(this.empty()), { backup: false });
      return exists;
    });
  }

  read() {
    return this.#queue.run(() => this.#read());
  }

  write(doc) {
    return this.#queue.run(() => this.#write(doc));
  }

  /**
   * @template T
   * @param {(doc: object) => {doc?: object, result?: T} | object} fn Mutate `doc` in place (return nothing),
   *        or return `{doc, result}`. Return `{result}` without `doc` to skip the write.
   * @returns {Promise<T|object>} `result`, or the written document.
   */
  update(fn) {
    return this.#queue.run(async () => {
      const doc = await this.#read();
      const out = await fn(doc);
      if (out && Object.hasOwn(out, 'result') && !Object.hasOwn(out, 'doc')) return out.result;
      const next = out && Object.hasOwn(out, 'doc') ? out.doc : doc;
      await this.#write(next);
      return out && Object.hasOwn(out, 'result') ? out.result : next;
    });
  }

  /** Delete the file (and its backup). @returns {Promise<boolean>} existed */
  remove() {
    return this.#queue.run(() => deleteJsonFile(this.file));
  }

  #write(doc) {
    return writeJsonFile(this.file, this.serialize(doc), { backup: this.backup });
  }

  async #read() {
    const raw = await this.#readRaw();
    return this.normalize(raw === undefined ? this.empty() : raw);
  }

  async #readRaw() {
    try {
      return await readJsonFile(this.file);
    } catch (err) {
      if (!(err instanceof CorruptJsonFileError)) throw err;
      const moved = await quarantineFile(this.file);
      this.logger?.warn('storage.corrupt_file_quarantined', { location: this.location, movedTo: path.basename(moved) });
      return undefined;
    }
  }
}
