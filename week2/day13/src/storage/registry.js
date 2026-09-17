import { JsonFileBackend } from './JsonFileBackend.js';
import { MemoryBackend } from './MemoryBackend.js';

/**
 * The storage backends a memory layer can be configured to use.
 *
 * This is the only place that maps a backend name from the storage
 * configuration to a class. The configuration validator, the memory manager
 * and the UI all read from it, so adding SQLite, PostgreSQL or a vector
 * database is one `registerBackend()` call plus the class itself.
 */
const backends = new Map();

/**
 * @param {string} type
 * @param {{
 *   label: string,
 *   description: string,
 *   persistent: boolean,
 *   options?: Record<string, {type: 'boolean', label: string, default: boolean}>,
 *   create: (context: {directory: string, dataDir: string, options: object, logger: object}) => import('./StorageBackend.js').StorageBackend
 * }} definition
 */
export function registerBackend(type, definition) {
  backends.set(type, { type, options: {}, ...definition });
}

registerBackend('json', {
  label: 'JSON file',
  description: 'One JSON file per document, written atomically. Survives restarts.',
  persistent: true,
  options: {
    backup: { type: 'boolean', label: 'Keep previous version (.bak)', default: true },
  },
  create: ({ directory, dataDir, options, logger }) => new JsonFileBackend({
    directory, dataDir, backup: options.backup, logger,
  }),
});

registerBackend('memory', {
  label: 'In-memory (volatile)',
  description: 'Kept in server memory only. Lost on restart; nothing is written to disk.',
  persistent: false,
  create: () => new MemoryBackend(),
});

export function isBackendType(type) {
  return typeof type === 'string' && backends.has(type);
}

/** Fill in defaults and drop unknown options. Throws on a wrong option type. */
export function normalizeBackendOptions(type, options = {}) {
  const schema = backends.get(type)?.options ?? {};
  const result = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = options?.[name];
    if (value === undefined) result[name] = spec.default;
    else if (typeof value !== spec.type) throw new TypeError(`Option "${name}" must be a ${spec.type}.`);
    else result[name] = value;
  }
  return result;
}

export async function createBackend(type, { directory, dataDir, options, logger }) {
  const definition = backends.get(type);
  if (!definition) throw new Error(`Unknown storage backend: ${JSON.stringify(type)}`);
  const backend = definition.create({ directory, dataDir, options: normalizeBackendOptions(type, options), logger });
  await backend.init?.();
  return backend;
}

/** For the UI: every backend with its label and option schema. */
export function listBackends() {
  return [...backends.values()].map(({ type, label, description, persistent, options }) => ({
    type, label, description, persistent, options,
  }));
}
