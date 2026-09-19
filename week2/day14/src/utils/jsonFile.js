import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { SerialQueue } from './serialQueue.js';

/** Thrown when a file exists but does not contain valid JSON. */
export class CorruptJsonFileError extends Error {
  constructor(file, cause) {
    super(`${file} is not valid JSON: ${cause.message}`);
    this.name = 'CorruptJsonFileError';
    this.file = file;
  }
}

// One queue per absolute path: writes to one file never interleave, writes to
// different files still run in parallel.
const queues = new Map();

function queueFor(file) {
  const key = path.resolve(file);
  if (!queues.has(key)) queues.set(key, new SerialQueue());
  return queues.get(key);
}

/**
 * @param {string} file
 * @returns {Promise<unknown>} The parsed value, or `undefined` when the file is
 *          missing or empty (an interrupted first write), which is not an error.
 * @throws {CorruptJsonFileError}
 */
export async function readJsonFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CorruptJsonFileError(file, err);
  }
}

/**
 * Replace a JSON file atomically.
 *
 * The value goes to a uniquely named temporary file in the same directory, is
 * flushed to disk, and is then renamed over the target. A rename within one
 * filesystem is atomic, so a crash leaves either the old or the new file, never
 * half of one. With `backup`, the previous version is kept as `<file>.bak`.
 *
 * @param {string} file
 * @param {unknown} value
 * @param {{backup?: boolean, mode?: number}} [options]
 */
export function writeJsonFile(file, value, { backup = false, mode = 0o600 } = {}) {
  return queueFor(file).run(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    try {
      const handle = await open(tmp, 'wx', mode);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (backup) {
        await copyFile(file, `${file}.bak`).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  });
}

/** Delete a JSON file and its backup. Missing files are not an error. */
export function deleteJsonFile(file) {
  return queueFor(file).run(async () => {
    let existed = true;
    await unlink(file).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      existed = false;
    });
    await unlink(`${file}.bak`).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    return existed;
  });
}

/**
 * Move an unreadable file aside instead of overwriting it, so a bad hand-edit
 * costs nothing: the file stays on disk for inspection.
 *
 * @returns {Promise<string>} Where the file was moved.
 */
export function quarantineFile(file) {
  return queueFor(file).run(async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${file}.corrupt-${stamp}`;
    await rename(file, target);
    return target;
  });
}
