import path from 'node:path';

import { CorruptJsonFileError, quarantineFile, readJsonFile, writeJsonFile } from './jsonFile.js';
import { SerialQueue } from './serialQueue.js';
import { resolveInside } from '../memory/storage/JSONFileStorage.js';

/**
 * A single JSON document on disk with serialised read-modify-write.
 *
 * Used for the files that are always plain JSON whatever the memory storage
 * configuration says: profile, invariants, tasks, conversation log, storage
 * configuration. `update(fn)` reads the latest version, applies `fn` and
 * writes the result atomically under a lock, so concurrent requests never
 * overwrite each other's change.
 */
export class JsonDocument {
  #queue = new SerialQueue();

  /**
   * @param {{dataDir: string, file: string, empty: () => object, normalize?: (value: unknown) => object,
   *          backup?: boolean, logger?: object}} options
   *        `empty()` is the document for a missing file; `normalize` repairs what was read.
   */
  constructor({ dataDir, file, empty, normalize = (v) => v, backup = true, logger }) {
    this.file = resolveInside(path.resolve(dataDir), file);
    this.empty = empty;
    this.normalize = normalize;
    this.backup = backup;
    this.logger = logger;
  }

  get location() {
    return `data/${path.basename(this.file)}`;
  }

  /** Create the file with the empty document if it is missing. Never overwrites. */
  init() {
    return this.#queue.run(async () => {
      const exists = (await this.#readRaw()) !== undefined;
      if (!exists) await writeJsonFile(this.file, this.empty(), { backup: false });
      return exists;
    });
  }

  read() {
    return this.#queue.run(() => this.#read());
  }

  write(doc) {
    return this.#queue.run(() => writeJsonFile(this.file, doc, { backup: this.backup }));
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
      await writeJsonFile(this.file, next, { backup: this.backup });
      return out && Object.hasOwn(out, 'result') ? out.result : next;
    });
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
