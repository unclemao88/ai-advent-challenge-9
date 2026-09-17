import path from 'node:path';

import { ShortTermMemory } from './ShortTermMemory.js';
import { WorkMemory } from './WorkMemory.js';
import { LongTermMemory } from './LongTermMemory.js';
import { LAYER_IDS, MEMORY_LAYERS, StorageConfigStore } from '../storage/StorageConfigStore.js';
import { createBackend, listBackends } from '../storage/registry.js';
import { SerialQueue } from '../utils/serialQueue.js';

/**
 * Owns the three memory layers and their storage configuration.
 *
 * The layers never know which backend they use; this class creates the
 * backends from `data/config/storage.json` and swaps them on request. The
 * agent talks to the layers through the operations exposed here.
 */
export class MemoryManager {
  #configQueue = new SerialQueue();

  /**
   * @param {{dataDir: string, tokenCounter: object, logger: object, shortTermMaxMessages?: number}} options
   */
  constructor({ dataDir, tokenCounter, logger, shortTermMaxMessages }) {
    this.dataDir = path.resolve(dataDir);
    this.tokenCounter = tokenCounter;
    this.logger = logger;
    this.configStore = new StorageConfigStore({ dataDir, logger, defaults: { shortTermMaxMessages } });
    this.config = null;
  }

  async init() {
    this.config = await this.configStore.load();
    const backends = {};
    for (const id of LAYER_IDS) backends[id] = await this.#backendFor(id, this.config.layers[id]);

    const common = { tokenCounter: this.tokenCounter, logger: this.logger };
    this.shortTerm = new ShortTermMemory({ ...common, backend: backends.shortTerm, maxMessages: this.config.shortTerm.maxMessages });
    this.work = new WorkMemory({ ...common, backend: backends.work });
    this.longTerm = new LongTermMemory({ ...common, backend: backends.longTerm });

    for (const id of LAYER_IDS) {
      this.logger.info('memory.layer.ready', { layer: id, backend: this.config.layers[id].backend, location: backends[id].location });
    }
    return this;
  }

  // --- Short-term ----------------------------------------------------------

  getShortTermMemory() { return this.shortTerm.getShortTermMemory(); }
  addMessage(message) { return this.shortTerm.addMessage(message); }
  deleteMessage(id) { return this.shortTerm.deleteMessage(id); }
  clearShortTermMemory() { return this.shortTerm.clearShortTermMemory(); }

  // --- Work ----------------------------------------------------------------

  createWorkMemory(taskId, init) { return this.work.createWorkMemory(taskId, init); }
  getWorkMemory(taskId) { return this.work.getWorkMemory(taskId); }
  updateWorkMemory(taskId, updates, context) { return this.work.updateWorkMemory(taskId, updates, context); }
  replaceWorkMemory(taskId, fields) { return this.work.replaceWorkMemory(taskId, fields); }
  clearWorkMemory(taskId) { return this.work.clearWorkMemory(taskId); }
  deleteWorkMemory(taskId) { return this.work.deleteWorkMemory(taskId); }

  // --- Long-term -----------------------------------------------------------

  getLongTermMemory() { return this.longTerm.getLongTermMemory(); }
  saveFact(fact) { return this.longTerm.saveFact(fact); }
  updateFact(id, changes) { return this.longTerm.updateFact(id, changes); }
  deleteFact(id) { return this.longTerm.deleteFact(id); }
  searchMemory(query, options) { return this.longTerm.searchMemory(query, options); }
  clearMemory(category) { return this.longTerm.clearMemory(category); }

  // --- Statistics ----------------------------------------------------------

  /**
   * Token counts of each layer as stored (the work layer for one task).
   * @param {string|null} taskId
   */
  async tokenStats(taskId) {
    const [messages, longTerm, work] = await Promise.all([
      this.getShortTermMemory(),
      this.getLongTermMemory(),
      taskId ? this.getWorkMemory(taskId) : Promise.resolve(null),
    ]);
    return {
      shortTerm: await this.shortTerm.calculateTokenCount(messages),
      workMemory: work ? this.work.calculateTokenCount(work) : 0,
      longTerm: this.longTerm.calculateTokenCount(longTerm),
    };
  }

  // --- Storage configuration -------------------------------------------------

  /** The configuration as the UI shows it. */
  describeStorage() {
    const layers = {};
    const current = { shortTerm: this.shortTerm, work: this.work, longTerm: this.longTerm };
    for (const id of LAYER_IDS) {
      const { backend, options } = this.config.layers[id];
      const instance = current[id].backend;
      layers[id] = {
        ...MEMORY_LAYERS[id],
        backend,
        options,
        persistent: instance.persistent,
        location: instance.location,
      };
      delete layers[id].directory;
    }
    return {
      layers,
      shortTerm: { ...this.config.shortTerm },
      fixed: {
        profiles: { label: 'User profile', backend: 'json', location: 'data/profiles/' },
        tasks: { label: 'Tasks', backend: 'json', location: 'data/tasks/' },
        config: { label: 'Configuration', backend: 'json', location: 'data/config/' },
      },
      backends: listBackends(),
      updatedAt: this.config.updatedAt,
    };
  }

  /**
   * Apply a storage change. Data is never deleted by a change:
   *   - switching a layer copies its current documents into the new backend;
   *   - before anything is written into a persistent backend that already holds
   *     documents, those files are copied to data/backups/;
   *   - the old backend is left untouched (its files stay on disk).
   *
   * @returns {Promise<{storage: object, changes: object[]}>}
   */
  updateStorage(patch) {
    return this.#configQueue.run(async () => {
      const next = this.configStore.applyPatch(this.config, patch);
      const changes = [];
      const layers = { shortTerm: this.shortTerm, work: this.work, longTerm: this.longTerm };

      for (const id of LAYER_IDS) {
        const before = this.config.layers[id];
        const after = next.layers[id];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;

        const newBackend = await this.#backendFor(id, after);
        const change = { layer: id, from: before.backend, to: after.backend, copied: 0, backup: null };

        await layers[id].setBackend(newBackend, async (oldBackend) => {
          if (before.backend === after.backend) return; // Only options changed; same documents.
          change.backup = await newBackend.snapshot(id);
          for (const key of await oldBackend.list()) {
            const doc = await oldBackend.get(key);
            if (doc !== undefined) {
              await newBackend.put(key, doc);
              change.copied += 1;
            }
          }
        });
        changes.push(change);
        this.logger.info('memory.storage.changed', change);
      }

      if (next.shortTerm.maxMessages !== this.config.shortTerm.maxMessages) {
        await this.shortTerm.setMaxMessages(next.shortTerm.maxMessages);
        changes.push({ layer: 'shortTerm', retention: next.shortTerm.maxMessages });
        this.logger.info('memory.short_term.retention', { maxMessages: next.shortTerm.maxMessages });
      }

      this.config = await this.configStore.save(next);
      return { storage: this.describeStorage(), changes };
    });
  }

  #backendFor(id, { backend, options }) {
    return createBackend(backend, {
      directory: path.join(this.dataDir, MEMORY_LAYERS[id].directory),
      dataDir: this.dataDir,
      options,
      logger: this.logger,
    });
  }
}
