import { JsonFileStorage } from './storage/JsonFileStorage.js';
import { InMemoryStorage } from './storage/InMemoryStorage.js';
import { DisabledStorage } from './storage/DisabledStorage.js';

/**
 * The registry of storage modes. This is the only place that maps a mode name
 * from settings.json to a provider class; memory layers, settings validation
 * and the UI's dropdown all read from it.
 *
 * Adding a backend is one `registerStorageProvider()` call.
 */
const providers = new Map();

/**
 * @param {string} mode Key stored in settings.json.
 * @param {{label: string, description: string,
 *          create: (context: {layerDirectory: string, logger: Console}) => import('./storage/StorageProvider.js').StorageProvider}} definition
 */
export function registerStorageProvider(mode, { label, description, create }) {
  providers.set(mode, { mode, label, description, create });
}

registerStorageProvider('json', {
  label: 'JSON file',
  description: 'Saved on disk. Survives restarts.',
  create: ({ layerDirectory, logger }) => new JsonFileStorage({ directory: layerDirectory, logger }),
});

registerStorageProvider('memory', {
  label: 'In-memory',
  description: 'Kept only while the server is running.',
  create: () => new InMemoryStorage(),
});

registerStorageProvider('disabled', {
  label: 'Disabled',
  description: 'Not stored and not sent to DeepSeek.',
  create: () => new DisabledStorage(),
});

export function isStorageMode(mode) {
  return typeof mode === 'string' && providers.has(mode);
}

/**
 * @param {string} mode
 * @param {{layerDirectory: string, logger?: Console}} context
 */
export function createStorage(mode, { layerDirectory, logger = console }) {
  const definition = providers.get(mode);
  if (!definition) throw new Error(`Unknown storage mode: ${JSON.stringify(mode)}`);
  return definition.create({ layerDirectory, logger });
}

/** For the settings UI: every available mode with its human label. */
export function listStorageModes() {
  return [...providers.values()].map(({ mode, label, description }) => ({ mode, label, description }));
}
