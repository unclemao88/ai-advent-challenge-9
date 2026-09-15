import path from 'node:path';

import { createStorage } from '../memory/storageManager.js';
import { ShortTermMemory } from '../memory/shortTermMemory.js';
import { WorkMemory } from '../memory/workMemory.js';
import { LongTermMemory } from '../memory/longTermMemory.js';
import { DEFAULT_SETTINGS, LAYER_IDS } from '../settings/settingsStore.js';
import { HttpError } from '../utils/httpError.js';

export const LAYER_LABELS = {
  shortTerm: 'Short-term memory',
  work: 'Work memory',
  longTerm: 'Long-term memory',
};

const LAYER_CLASSES = { shortTerm: ShortTermMemory, work: WorkMemory, longTerm: LongTermMemory };

/**
 * Owns the three memory layers and wires each one to the storage its settings
 * ask for. The agent and the API reach memory only through this object.
 */
export class MemoryManager {
  /**
   * @param {{dataDir: string, settings?: typeof DEFAULT_SETTINGS.memory, logger?: Console}} options
   */
  constructor({ dataDir, settings = DEFAULT_SETTINGS.memory, logger = console }) {
    this.dataDir = path.resolve(dataDir);
    this.logger = logger;

    this.shortTerm = new ShortTermMemory({
      storage: this.#storageFor('shortTerm', settings.shortTerm.storage),
      maxMessages: settings.shortTerm.maxMessages,
    });
    this.work = new WorkMemory({ storage: this.#storageFor('work', settings.work.storage) });
    this.longTerm = new LongTermMemory({ storage: this.#storageFor('longTerm', settings.longTerm.storage) });
  }

  /** Create missing directories and files for every JSON-backed layer. */
  async init() {
    await Promise.all(LAYER_IDS.map((id) => this.layer(id).init()));
  }

  /** @param {string} layerId @throws {HttpError} 400 for an unknown layer. */
  layer(layerId) {
    if (!LAYER_IDS.includes(layerId)) {
      throw new HttpError(400, `Unknown memory layer "${layerId}".`, 'unknown_layer');
    }
    return this[layerId];
  }

  /**
   * Bring every layer in line with the memory settings. Only layers whose mode
   * actually changed get a new provider, so saving unchanged settings is free.
   */
  async applySettings(settings) {
    for (const layerId of LAYER_IDS) {
      const wanted = settings[layerId].storage;
      if (this.layer(layerId).storageMode !== wanted) {
        await this.layer(layerId).switchStorage(this.#storageFor(layerId, wanted));
      }
    }
    if (settings.shortTerm.maxMessages !== this.shortTerm.maxMessages) {
      await this.shortTerm.setMaxMessages(settings.shortTerm.maxMessages);
    }
  }

  /**
   * Everything the context builder needs. A disabled layer reads as empty, so
   * it contributes nothing to the request.
   */
  async loadAll() {
    const [shortTerm, work, longTerm] = await Promise.all([
      this.shortTerm.getMessages(),
      this.work.getTask(),
      this.longTerm.read(),
    ]);
    return { shortTerm, work, longTerm };
  }

  async clear(layerId) {
    await this.layer(layerId).clear();
  }

  /** Storage details and raw contents of each layer, for the settings UI. */
  async describe() {
    const contents = await this.loadAll();
    return LAYER_IDS.map((id) => {
      const layer = this.layer(id);
      return {
        id,
        label: LAYER_LABELS[id],
        storage: layer.storageMode,
        enabled: layer.enabled,
        persistent: layer.persistent,
        location: layer.persistent ? path.join(path.basename(this.dataDir), LAYER_CLASSES[id].directory) : null,
        ...(id === 'shortTerm' ? { maxMessages: layer.maxMessages } : {}),
        contents: contents[id],
      };
    });
  }

  #storageFor(layerId, mode) {
    return createStorage(mode, {
      // Fixed per layer; nothing from a request ever reaches this path.
      layerDirectory: path.join(this.dataDir, LAYER_CLASSES[layerId].directory),
      logger: this.logger,
    });
  }
}
