import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

// One queue per absolute path, so writes to the same file never interleave
// while writes to different files still run in parallel.
const writeQueues = new Map();

function queueFor(file) {
  const key = path.resolve(file);
  if (!writeQueues.has(key)) writeQueues.set(key, new SerialQueue());
  return writeQueues.get(key);
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file
 * @returns {Promise<unknown>} The parsed value, or `undefined` when the file is
 *          missing or empty (an interrupted first run), which is not an error.
 * @throws {CorruptJsonFileError} When the file holds something that is not JSON.
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
 * The value is written to a uniquely named temporary file in the same directory
 * and then renamed over the target. A rename within one filesystem is atomic,
 * so a reader sees either the old file or the new one, never half of either,
 * and a crash mid-write leaves the previous contents intact.
 *
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonFile(file, value) {
  return queueFor(file).run(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {}); // Best effort; never mask the real error.
      throw err;
    }
  });
}

/**
 * Move an unreadable file aside instead of overwriting it, so a hand-edit gone
 * wrong costs nothing: the bad file stays on disk for inspection.
 *
 * @param {string} file
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
