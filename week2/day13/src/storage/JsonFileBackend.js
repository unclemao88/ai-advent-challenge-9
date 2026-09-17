import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

import { StorageBackend, assertKey } from './StorageBackend.js';
import {
  CorruptJsonFileError, deleteJsonFile, quarantineFile, readJsonFile, writeJsonFile,
} from '../utils/jsonFile.js';

/**
 * One JSON file per document: `<directory>/<key>.json`.
 *
 * Writes are atomic (temporary file + fsync + rename). With `backup` enabled the
 * previous version of every document is kept next to it as `<key>.json.bak`.
 * A file that is not valid JSON is moved aside (never overwritten) and the
 * document reads as missing, so a bad hand-edit cannot take the app down.
 */
export class JsonFileBackend extends StorageBackend {
  /**
   * @param {{directory: string, dataDir: string, backup?: boolean, logger: object}} options
   *        `dataDir` is only used to report locations relative to it.
   */
  constructor({ directory, dataDir, backup = true, logger }) {
    super('json');
    this.directory = path.resolve(directory);
    this.dataDir = path.resolve(dataDir);
    this.backup = backup;
    this.logger = logger;
  }

  get persistent() {
    return true;
  }

  get location() {
    return `data/${path.relative(this.dataDir, this.directory).split(path.sep).join('/')}/`;
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async get(key) {
    const file = this.#fileFor(key);
    try {
      return await readJsonFile(file);
    } catch (err) {
      if (!(err instanceof CorruptJsonFileError)) throw err;
      const moved = await quarantineFile(file);
      this.logger.warn('storage.corrupt_file_quarantined', { location: this.location, key, movedTo: path.basename(moved) });
      return undefined;
    }
  }

  async put(key, value) {
    await writeJsonFile(this.#fileFor(key), value, { backup: this.backup });
  }

  async delete(key) {
    return deleteJsonFile(this.#fileFor(key));
  }

  async list(prefix = '') {
    let names;
    try {
      names = await readdir(this.directory);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((key) => key.startsWith(prefix) && isValidKey(key))
      .sort();
  }

  /** Copy every document into `data/backups/<label>-<timestamp>/`. */
  async snapshot(label) {
    const keys = await this.list();
    if (keys.length === 0) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.dataDir, 'backups', `${assertKey(label)}-${stamp}`);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const key of keys) {
      await copyFile(this.#fileFor(key), path.join(target, `${key}.json`));
    }
    return `data/${path.relative(this.dataDir, target).split(path.sep).join('/')}/`;
  }

  /** The file behind a key, guaranteed to sit directly in this directory. */
  #fileFor(key) {
    assertKey(key);
    const file = path.resolve(this.directory, `${key}.json`);
    if (path.dirname(file) !== this.directory) throw new Error('Refusing to access a file outside the storage directory');
    return file;
  }
}

function isValidKey(key) {
  try {
    assertKey(key);
    return true;
  } catch {
    return false;
  }
}
