import { isProviderType, normalizeProviderOptions } from './registry.js';
import { JsonDocument } from '../../persistence/jsonDocument.js';
import { DATA_FILES } from '../../persistence/dataPaths.js';
import { badRequest } from '../../utils/errors.js';
import { isPlainObject } from '../../utils/validate.js';

/**
 * The three memory layers and the data file each one uses with the JSON
 * provider. File names are fixed by the code, never taken from a request.
 */
export const MEMORY_LAYERS = Object.freeze({
  shortTerm: { label: 'Short-term memory', file: DATA_FILES.shortTerm, purpose: 'The current conversation.' },
  work: { label: 'Work memory', file: DATA_FILES.work, purpose: 'Objective, plan, decisions, facts and results of each task.' },
  longTerm: { label: 'Long-term memory', file: DATA_FILES.longTerm, purpose: 'Solutions and knowledge kept across tasks (the profile lives in data/profile/profile.json).' },
});

export const LAYER_IDS = Object.keys(MEMORY_LAYERS);
export const SHORT_TERM_LIMITS = Object.freeze({ min: 2, max: 500 });

/**
 * Persists which provider each layer uses, in `data/config/memory-storage.json`:
 *
 *   { "shortTerm": { "provider": "json", "options": { "backup": true } },
 *     "work":      { "provider": "json", ... },
 *     "longTerm":  { "provider": "memory", ... },
 *     "shortTermMaxMessages": 30 }
 *
 * The file itself is always plain JSON, so the choice survives a restart even
 * when a layer is set to volatile memory. Initial values come from the
 * environment (STORAGE_SHORT_TERM, STORAGE_WORK, STORAGE_LONG_TERM).
 */
export class StorageConfigStore {
  /**
   * @param {{dataDir: string, logger: object, defaults?: {providers?: object, shortTermMaxMessages?: number}}} options
   */
  constructor({ dataDir, logger, defaults = {} }) {
    this.defaults = {
      providers: Object.fromEntries(LAYER_IDS.map((id) => [id, isProviderType(defaults.providers?.[id]) ? defaults.providers[id] : 'json'])),
      shortTermMaxMessages: clampInt(defaults.shortTermMaxMessages, SHORT_TERM_LIMITS, 30),
    };
    this.doc = new JsonDocument({
      dataDir, file: DATA_FILES.memoryStorage, logger, empty: () => this.defaultConfig(), normalize: (v) => this.#normalize(v),
    });
  }

  defaultConfig() {
    const config = {};
    for (const id of LAYER_IDS) {
      const provider = this.defaults.providers[id];
      config[id] = { provider, options: normalizeProviderOptions(provider) };
    }
    config.shortTermMaxMessages = this.defaults.shortTermMaxMessages;
    config.updatedAt = null;
    return config;
  }

  async load() {
    await this.doc.init();
    return this.doc.read();
  }

  save(config) {
    return this.doc.update(() => ({ doc: { ...this.#normalize(config), updatedAt: new Date().toISOString() } }));
  }

  /**
   * Validate a change requested through the API and merge it into `current`.
   *
   * @param {object} current
   * @param {{shortTerm?: {provider?: string, options?: object}, work?: object, longTerm?: object,
   *          shortTermMaxMessages?: number}} patch
   */
  applyPatch(current, patch) {
    if (!isPlainObject(patch)) throw badRequest('The storage configuration must be a JSON object.');
    const unknown = Object.keys(patch).filter((k) => !LAYER_IDS.includes(k) && k !== 'shortTermMaxMessages');
    if (unknown.length) throw badRequest(`Unknown storage setting(s): ${unknown.join(', ')}.`);
    const next = structuredClone(current);

    for (const id of LAYER_IDS) {
      const change = patch[id];
      if (change === undefined) continue;
      if (!isPlainObject(change)) throw badRequest(`The configuration for ${id} must be an object.`);
      const provider = change.provider ?? next[id].provider;
      if (!isProviderType(provider)) throw badRequest(`Unknown storage provider "${provider}" for ${id}.`);
      const baseOptions = provider === next[id].provider ? next[id].options : {};
      try {
        next[id] = { provider, options: normalizeProviderOptions(provider, { ...baseOptions, ...(change.options ?? {}) }) };
      } catch (err) {
        throw badRequest(`${MEMORY_LAYERS[id].label}: ${err.message}`);
      }
    }

    if (patch.shortTermMaxMessages !== undefined) {
      const max = patch.shortTermMaxMessages;
      if (!Number.isInteger(max) || max < SHORT_TERM_LIMITS.min || max > SHORT_TERM_LIMITS.max) {
        throw badRequest(`Short-term retention must be a whole number from ${SHORT_TERM_LIMITS.min} to ${SHORT_TERM_LIMITS.max}.`);
      }
      next.shortTermMaxMessages = max;
    }
    return next;
  }

  #normalize(value) {
    const config = this.defaultConfig();
    if (!isPlainObject(value)) return config;
    for (const id of LAYER_IDS) {
      const layer = value[id];
      if (isPlainObject(layer) && isProviderType(layer.provider)) {
        let options;
        try {
          options = normalizeProviderOptions(layer.provider, layer.options);
        } catch {
          options = normalizeProviderOptions(layer.provider);
        }
        config[id] = { provider: layer.provider, options };
      }
    }
    config.shortTermMaxMessages = clampInt(value.shortTermMaxMessages, SHORT_TERM_LIMITS, config.shortTermMaxMessages);
    config.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
    return config;
  }
}

function clampInt(value, { min, max }, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
