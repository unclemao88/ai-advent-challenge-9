import path from 'node:path';

import { createStorage } from '../memory/storageManager.js';
import { LAYER_DEFINITIONS, LAYER_IDS, isLayerId, layerDefinition } from '../memory/layers.js';
import { DEFAULT_SETTINGS } from '../settings/settingsStore.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Owns every memory layer and wires each one to the storage its settings ask
 * for. The agent and the HTTP routes reach memory only through this object, so
 * nothing else in the application knows where anything is kept.
 *
 *   manager.shortTerm     the conversation window sent to DeepSeek
 *   manager.work          the current task
 *   manager.longTerm      solutions and knowledge
 *   manager.profile       style, format, limitations
 *   manager.conversation  the full chat log (never sent to DeepSeek)
 */
export class MemoryManager {
  /**
   * @param {{dataDir: string, settings?: typeof DEFAULT_SETTINGS.memory, logger?: Console}} options
   */
  constructor({ dataDir, settings = DEFAULT_SETTINGS.memory, logger = console }) {
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;

    for (const definition of LAYER_DEFINITIONS) {
      const layerSettings = settings[definition.id] ?? DEFAULT_SETTINGS.memory[definition.id];
      this[definition.id] = new definition.Class({
        storage: this.#storageFor(definition.id, layerSettings.storage),
        ...(definition.size ? { [definition.size.key]: layerSettings[definition.size.key] } : {}),
      });
    }
  }

  /** Create missing directories and files for every persistent layer. */
  async init() {
    await Promise.all(LAYER_IDS.map((id) => this.layer(id).init()));
  }

  /** @param {string} layerId @throws {HttpError} 400 for an unknown layer. */
  layer(layerId) {
    if (!isLayerId(layerId)) {
      throw new HttpError(400, `Unknown memory layer "${layerId}".`, 'unknown_layer');
    }
    return this[layerId];
  }

  /**
   * Bring every layer in line with the saved settings. Only layers whose mode
   * or size actually changed are touched, so saving unchanged settings is free.
   */
  async applySettings(settings) {
    for (const definition of LAYER_DEFINITIONS) {
      const layer = this.layer(definition.id);
      const wanted = settings[definition.id];

      if (layer.storageMode !== wanted.storage) {
        await layer.switchStorage(this.#storageFor(definition.id, wanted.storage));
      }
      if (definition.size) {
        const { key } = definition.size;
        if (layer[key] !== wanted[key]) await layer[`set${key[0].toUpperCase()}${key.slice(1)}`](wanted[key]);
      }
    }
  }

  /**
   * Everything the context builder needs, loaded in parallel. A disabled layer
   * reads as empty, so it contributes nothing to the request.
   *
   * The conversation log is deliberately absent: it is a record for the user,
   * not context for the model.
   */
  async loadAll() {
    const [shortTerm, work, longTerm, profile] = await Promise.all([
      this.shortTerm.getMessages(),
      this.work.getTask(),
      this.longTerm.getAll(),
      this.profile.get(),
    ]);
    return { shortTerm, work, longTerm, profile };
  }

  async clear(layerId) {
    await this.layer(layerId).clear();
  }

  /** Storage details and contents of every layer, for the memory UI. */
  async describe() {
    const contents = {
      ...(await this.loadAll()),
      conversation: { entries: await this.conversation.getEntries() },
    };

    return LAYER_DEFINITIONS.map(({ id, label, purpose, size }) => {
      const layer = this.layer(id);
      return {
        id,
        label,
        purpose,
        storage: layer.storageMode,
        enabled: layer.enabled,
        persistent: layer.persistent,
        location: layer.persistent
          ? path.join(path.basename(this.dataDir), layerDefinition(id).Class.directory)
          : null,
        ...(size ? { [size.key]: layer[size.key] } : {}),
        contents: contents[id],
      };
    });
  }

  #storageFor(layerId, mode) {
    return createStorage(mode, {
      // Fixed per layer; nothing from a request ever reaches this path.
      layerDirectory: path.join(this.dataDir, layerDefinition(layerId).Class.directory),
      logger: this.logger,
    });
  }
}
