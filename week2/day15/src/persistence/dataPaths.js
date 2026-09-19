import path from 'node:path';

/**
 * Where every persistent domain lives inside DATA_DIR. One directory per
 * domain, one file per concern; unrelated data never shares a file.
 *
 *   data/
 *     memory/short-term.json       short-term memory (JSON provider)
 *     memory/work-memory.json      work memory of every task (JSON provider)
 *     memory/long-term.json        long-term memory: solutions + knowledge (JSON provider)
 *     profile/profile.json         the user profile
 *     invariants/invariants.json   invariants, grouped by category
 *     tasks/task-<id>.json         one file per task (state machine + metadata)
 *     tasks/active.json            which task is active, default mode for new tasks
 *     history/chat-history.json    every question and answer (what the chat shows)
 *     config/memory-storage.json   storage provider of each memory layer
 *
 * File names are fixed here or built from validated ids, never taken from a
 * request, and every path is checked to stay inside the data directory.
 */
export const DATA_FILES = Object.freeze({
  shortTerm: 'memory/short-term.json',
  work: 'memory/work-memory.json',
  longTerm: 'memory/long-term.json',
  profile: 'profile/profile.json',
  invariants: 'invariants/invariants.json',
  tasksDir: 'tasks',
  activeTask: 'tasks/active.json',
  history: 'history/chat-history.json',
  memoryStorage: 'config/memory-storage.json',
});

// An optional sub-directory (one level) plus a bare file name.
const RELATIVE_FILE = /^(?:[a-z0-9][a-z0-9_-]{0,31}\/)?[a-z0-9][a-z0-9._-]{0,80}\.json$/;

/**
 * Resolve `name` (e.g. "memory/short-term.json") inside `dir`. Throws for
 * anything that could escape it: absolute paths, "..", nested directories,
 * unexpected characters.
 */
export function resolveInside(dir, name) {
  if (typeof name !== 'string' || !RELATIVE_FILE.test(name) || name.includes('..')) {
    throw new Error(`Invalid data file name: ${JSON.stringify(name)}`);
  }
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to access a file outside the data directory');
  }
  return file;
}

/** "data/memory/short-term.json": for logs and the UI. Never an absolute path. */
export function displayLocation(dir, file) {
  return `data/${path.relative(path.resolve(dir), file).split(path.sep).join('/')}`;
}
