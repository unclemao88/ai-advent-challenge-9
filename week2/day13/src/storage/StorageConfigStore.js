import path from 'node:path';

import { JsonFileBackend } from './JsonFileBackend.js';
import { isBackendType, normalizeBackendOptions } from './registry.js';
import { badRequest } from '../utils/errors.js';
import { isPlainObject } from '../utils/validate.js';

/**
 * The three memory layers and where each one lives on disk when it uses the
 * JSON backend. The directories are fixed by the code, never by a request.
 */
export const MEMORY_LAYERS = Object.freeze({
  shortTerm: { label: 'Short-term memory', directory: 'short-term', purpose: 'The current conversation.' },
  work: { label: 'Work memory', directory: 'work-memory', purpose: 'Facts, decisions and results of each task.' },
  longTerm: { label: 'Long-term memory', directory: 'long-term', purpose: 'Profile notes, solutions and knowledge kept across tasks.' },
});

export const LAYER_IDS = Object.keys(MEMORY_LAYERS);

export const SHORT_TERM_LIMITS = Object.freeze({ min: 2, max: 500 });

/**
 * Persists the per-layer storage configuration in `data/config/storage.json`.
 * The file itself is always plain JSON, whatever the layers are set to, so the
 * configuration survives switching a layer to volatile memory.
 */
export class StorageConfigStore {
  /**
   * @param {{dataDir: string, logger: object, defaults?: {shortTermMaxMessages?: number}}} options
   */
  constructor({ dataDir, logger, defaults = {} }) {
    this.backend = new JsonFileBackend({ directory: path.join(dataDir, 'config'), dataDir, backup: true, logger });
    this.defaults = {
      shortTermMaxMessages: clampInt(defaults.shortTermMaxMessages, SHORT_TERM_LIMITS, 40),
    };
  }

  defaultConfig() {
    return {
      version: 1,
      layers: Object.fromEntries(LAYER_IDS.map((id) => [id, { backend: 'json', options: normalizeBackendOptions('json') }])),
      shortTerm: { maxMessages: this.defaults.shortTermMaxMessages },
      updatedAt: null,
    };
  }

  async load() {
    await this.backend.init();
    const stored = await this.backend.get('storage');
    const config = this.#normalize(stored);
    if (stored === undefined) await this.backend.put('storage', config);
    return config;
  }

  async save(config) {
    const next = { ...this.#normalize(config), updatedAt: new Date().toISOString() };
    await this.backend.put('storage', next);
    return next;
  }

  /**
   * Validate a change requested through the API and merge it into `current`.
   *
   * @param {object} current
   * @param {{layers?: Record<string, {backend?: string, options?: object}>, shortTerm?: {maxMessages?: number}}} patch
   */
  applyPatch(current, patch) {
    if (!isPlainObject(patch)) throw badRequest('The storage configuration must be a JSON object.');
    const next = structuredClone(current);

    if (patch.layers !== undefined) {
      if (!isPlainObject(patch.layers)) throw badRequest('"layers" must be an object.');
      for (const [id, change] of Object.entries(patch.layers)) {
        if (!LAYER_IDS.includes(id)) throw badRequest(`Unknown memory layer "${id}".`);
        if (!isPlainObject(change)) throw badRequest(`The configuration for ${id} must be an object.`);
        const backend = change.backend ?? next.layers[id].backend;
        if (!isBackendType(backend)) throw badRequest(`Unknown storage backend "${backend}" for ${id}.`);
        const baseOptions = backend === next.layers[id].backend ? next.layers[id].options : {};
        try {
          next.layers[id] = { backend, options: normalizeBackendOptions(backend, { ...baseOptions, ...(change.options ?? {}) }) };
        } catch (err) {
          throw badRequest(`${MEMORY_LAYERS[id].label}: ${err.message}`);
        }
      }
    }

    if (patch.shortTerm !== undefined) {
      const max = patch.shortTerm?.maxMessages;
      if (!Number.isInteger(max) || max < SHORT_TERM_LIMITS.min || max > SHORT_TERM_LIMITS.max) {
        throw badRequest(`Short-term retention must be a whole number from ${SHORT_TERM_LIMITS.min} to ${SHORT_TERM_LIMITS.max}.`);
      }
      next.shortTerm.maxMessages = max;
    }
    return next;
  }

  #normalize(value) {
    const config = this.defaultConfig();
    if (!isPlainObject(value)) return config;
    for (const id of LAYER_IDS) {
      const layer = value.layers?.[id];
      if (isPlainObject(layer) && isBackendType(layer.backend)) {
        try {
          config.layers[id] = { backend: layer.backend, options: normalizeBackendOptions(layer.backend, layer.options) };
        } catch {
          config.layers[id] = { backend: layer.backend, options: normalizeBackendOptions(layer.backend) };
        }
      }
    }
    config.shortTerm.maxMessages = clampInt(value.shortTerm?.maxMessages, SHORT_TERM_LIMITS, config.shortTerm.maxMessages);
    config.updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : null;
    return config;
  }
}

function clampInt(value, { min, max }, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
