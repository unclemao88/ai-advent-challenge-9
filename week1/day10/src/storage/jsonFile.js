'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

// fs.promises still prints an ExperimentalWarning on Node 10, so promisify.
const readFile = util.promisify(fs.readFile);
const open = util.promisify(fs.open);
const write = util.promisify(fs.write);
const fsync = util.promisify(fs.fsync);
const close = util.promisify(fs.close);
const rename = util.promisify(fs.rename);
const unlink = util.promisify(fs.unlink);
const mkdir = util.promisify(fs.mkdir);

/**
 * Read and parse a JSON file without throwing on the ordinary failure modes.
 *
 * @returns {Promise<{status: 'missing'|'empty'|'ok'|'corrupt', data?: any, error?: Error}>}
 */
async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    throw err; // Permissions, EISDIR… a real problem, not a data problem.
  }
  if (!raw.trim()) return { status: 'empty' };
  try {
    return { status: 'ok', data: JSON.parse(raw) };
  } catch (err) {
    return { status: 'corrupt', error: err };
  }
}

/**
 * Atomic replace: write a uniquely named temp file in the same directory, flush
 * it to disk, then rename it over the target. A crash at any point leaves
 * either the old file or the new one — never a truncated mix.
 */
async function writeJsonAtomic(file, data) {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await ensureDir(path.dirname(file));
  try {
    const fd = await open(tmp, 'w', 0o600);
    try {
      await write(fd, json);
      await fsync(fd);
    } finally {
      await close(fd);
    }
    await rename(tmp, file);
  } catch (err) {
    unlink(tmp).catch(function () {}); // Best effort; never mask the real error.
    throw err;
  }
}

/**
 * Move an unreadable file aside so it can be inspected, instead of either
 * refusing to run or silently overwriting it.
 * @returns {Promise<string>} The backup path.
 */
async function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = file.replace(/\.json$/, '') + '.corrupt-' + stamp + '.json';
  await rename(file, backup);
  return backup;
}

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

module.exports = { readJson, writeJsonAtomic, quarantine, ensureDir };
