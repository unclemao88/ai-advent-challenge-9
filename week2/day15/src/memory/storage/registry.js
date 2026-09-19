import { InMemoryStorage } from './InMemoryStorage.js';
import { JSONFileStorage } from './JSONFileStorage.js';

/**
 * The storage providers a memory layer can be configured to use.
 *
 * This is the only place that maps a provider name from the storage
 * configuration to a class. The configuration validator, the memory manager
 * and the UI all read from it, so adding SQLite, PostgreSQL or Redis is one
 * `registerProvider()` call plus the class itself.
 */
const providers = new Map();

/**
 * @param {string} type
 * @param {{
 *   label: string,
 *   description: string,
 *   persistent: boolean,
 *   options?: Record<string, {type: 'boolean', label: string, default: boolean}>,
 *   create: (context: {file: string, dataDir: string, options: object, logger: object}) => import('./StorageProvider.js').StorageProvider
 * }} definition
 */
export function registerProvider(type, definition) {
  providers.set(type, { type, options: {}, ...definition });
}

registerProvider('json', {
  label: 'JSON file',
  description: 'One JSON file per layer in the data directory, written atomically. Survives restarts.',
  persistent: true,
  options: {
    backup: { type: 'boolean', label: 'Keep previous version (.bak)', default: true },
  },
  create: ({ file, dataDir, options, logger }) => new JSONFileStorage({ file, dataDir, backup: options.backup, logger }),
});

registerProvider('memory', {
  label: 'In-memory (volatile)',
  description: 'Kept in server memory only. Lost on restart; nothing of this layer is written to disk.',
  persistent: false,
  create: () => new InMemoryStorage(),
});

export function isProviderType(type) {
  return typeof type === 'string' && providers.has(type);
}

/** Fill in defaults and drop unknown options. Throws on a wrong option type. */
export function normalizeProviderOptions(type, options = {}) {
  const schema = providers.get(type)?.options ?? {};
  const result = {};
  for (const [name, spec] of Object.entries(schema)) {
    const value = options?.[name];
    if (value === undefined) result[name] = spec.default;
    else if (typeof value !== spec.type) throw new TypeError(`Option "${name}" must be a ${spec.type}.`);
    else result[name] = value;
  }
  return result;
}

export async function createProvider(type, { file, dataDir, options, logger }) {
  const definition = providers.get(type);
  if (!definition) throw new Error(`Unknown storage provider: ${JSON.stringify(type)}`);
  const provider = definition.create({ file, dataDir, options: normalizeProviderOptions(type, options), logger });
  await provider.init();
  return provider;
}

/** For the UI: every provider with its label and option schema. */
export function listProviders() {
  return [...providers.values()].map(({ type, label, description, persistent, options }) => ({
    type, label, description, persistent, options,
  }));
}
