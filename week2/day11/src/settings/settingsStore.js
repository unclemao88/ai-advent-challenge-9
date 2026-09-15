import { isStorageMode, listStorageModes } from '../memory/storageManager.js';
import { DEFAULT_MAX_MESSAGES, MAX_MAX_MESSAGES, MIN_MAX_MESSAGES } from '../memory/shortTermMemory.js';
import { readJsonFile, writeJsonFile, CorruptJsonFileError, quarantineFile } from '../utils/jsonFile.js';
import { HttpError } from '../utils/httpError.js';

export const LAYER_IDS = ['shortTerm', 'work', 'longTerm'];

export const DEFAULT_SETTINGS = Object.freeze({
  memory: {
    shortTerm: { storage: 'json', maxMessages: DEFAULT_MAX_MESSAGES },
    work: { storage: 'json' },
    longTerm: { storage: 'json' },
  },
});

/**
 * Memory configuration, persisted in data/settings.json — deliberately apart
 * from the memory contents, so clearing a layer never resets its settings and
 * changing a setting never rewrites memory files.
 */
export class SettingsStore {
  #settings = structuredClone(DEFAULT_SETTINGS);

  /** @param {{file: string, logger?: Pick<Console, 'warn'>}} options */
  constructor({ file, logger = console }) {
    this.file = file;
    this.logger = logger;
  }

  /** Load settings, creating the file with defaults on first start. */
  async load() {
    let stored;
    try {
      stored = await readJsonFile(this.file);
    } catch (err) {
      if (!(err instanceof CorruptJsonFileError)) throw err;
      const backup = await quarantineFile(this.file);
      this.logger.warn(`${this.file} was not valid JSON. Moved it to ${backup}; using default settings.`);
    }

    // A stored value that is no longer valid (say, a storage mode that was
    // removed) falls back to its default instead of blocking startup.
    const { settings, errors } = mergeSettings(DEFAULT_SETTINGS, stored ?? {});
    for (const error of errors) this.logger.warn(`settings.json: ${error} Using the default.`);
    this.#settings = settings;

    if (stored === undefined || errors.length) await writeJsonFile(this.file, settings);
    return this.get();
  }

  /** @returns {typeof DEFAULT_SETTINGS} A copy; editing it changes nothing. */
  get() {
    return structuredClone(this.#settings);
  }

  /**
   * Validate a partial update, merge it and persist the result.
   *
   * @param {unknown} patch e.g. `{ memory: { work: { storage: 'memory' } } }`
   * @throws {HttpError} 400 listing every invalid field; nothing is saved.
   */
  async save(patch) {
    const { settings, errors } = mergeSettings(this.#settings, patch);
    if (errors.length) throw new HttpError(400, errors.join(' '), 'invalid_settings');
    await writeJsonFile(this.file, settings);
    this.#settings = settings;
    return this.get();
  }
}

/**
 * Merge `patch` over `base`, keeping only known, valid fields.
 *
 * @returns {{settings: typeof DEFAULT_SETTINGS, errors: string[]}}
 */
export function mergeSettings(base, patch) {
  const settings = structuredClone(base);
  const errors = [];

  if (!isObject(patch)) return { settings, errors: ['Settings must be a JSON object.'] };
  if (patch.memory === undefined) return { settings, errors };
  if (!isObject(patch.memory)) return { settings, errors: ['"memory" must be an object.'] };

  const modes = listStorageModes().map(({ mode }) => mode).join(', ');

  for (const [layerId, layerPatch] of Object.entries(patch.memory)) {
    if (!LAYER_IDS.includes(layerId)) {
      errors.push(`Unknown memory layer "${layerId}".`);
      continue;
    }
    if (!isObject(layerPatch)) {
      errors.push(`"memory.${layerId}" must be an object.`);
      continue;
    }

    if (layerPatch.storage !== undefined) {
      if (isStorageMode(layerPatch.storage)) settings.memory[layerId].storage = layerPatch.storage;
      else errors.push(`"memory.${layerId}.storage" must be one of: ${modes}.`);
    }

    if (layerId === 'shortTerm' && layerPatch.maxMessages !== undefined) {
      const n = Number(layerPatch.maxMessages);
      if (Number.isInteger(n) && n >= MIN_MAX_MESSAGES && n <= MAX_MAX_MESSAGES) {
        settings.memory.shortTerm.maxMessages = n;
      } else {
        errors.push(`"memory.shortTerm.maxMessages" must be a whole number from ${MIN_MAX_MESSAGES} to ${MAX_MAX_MESSAGES}.`);
      }
    }
  }

  return { settings, errors };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
