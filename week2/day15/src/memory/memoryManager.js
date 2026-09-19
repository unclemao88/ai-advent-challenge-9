import path from 'node:path';

import { ShortTermMemory } from './shortTermMemory.js';
import { PROMOTABLE_FIELDS, RESULT_LISTS, TEXT_LISTS, WorkMemory, formatWorkMemory } from './workMemory.js';
import { LongTermMemory, formatLongTermMemory, isCategory } from './longTermMemory.js';
import { KeywordRetriever } from './retrieval.js';
import { LAYER_IDS, MEMORY_LAYERS, StorageConfigStore } from './storage/storageConfig.js';
import { createProvider, listProviders } from './storage/registry.js';
import { formatProfile } from '../profile/profileManager.js';
import { badRequest, notFound } from '../utils/errors.js';
import { SerialQueue } from '../utils/serialQueue.js';

/**
 * Owns the three memory layers and where each one is stored.
 *
 * Each layer gets its own provider instance, created from
 * data/config/memory-storage.json, so the layers can never share storage and each can
 * be moved on its own. The layers never know which provider they use.
 *
 * The profile belongs to long-term memory logically; it is read from the
 * ProfileManager (data/profile/profile.json) and shown as part of that layer.
 */
export class MemoryManager {
  #configQueue = new SerialQueue();

  /**
   * @param {{dataDir: string, tokenCounter: object, logger: object, profiles: import('../profile/profileManager.js').ProfileManager,
   *          providers?: object, shortTermMaxMessages?: number, retriever?: object}} options
   */
  constructor({ dataDir, tokenCounter, logger, profiles, providers, shortTermMaxMessages, retriever = new KeywordRetriever() }) {
    this.dataDir = path.resolve(dataDir);
    this.tokenCounter = tokenCounter;
    this.logger = logger;
    this.profiles = profiles;
    this.retriever = retriever;
    this.configStore = new StorageConfigStore({ dataDir, logger, defaults: { providers, shortTermMaxMessages } });
    this.config = null;
  }

  async init() {
    this.config = await this.configStore.load();
    const providers = {};
    for (const id of LAYER_IDS) {
      // The JSON file of every layer exists from the first start, whatever provider is chosen.
      if (this.config[id].provider !== 'json') await this.#providerFor(id, { provider: 'json', options: {} });
      providers[id] = await this.#providerFor(id, this.config[id]);
    }

    const common = { tokenCounter: this.tokenCounter, logger: this.logger };
    this.shortTerm = new ShortTermMemory({ ...common, provider: providers.shortTerm, maxMessages: this.config.shortTermMaxMessages });
    this.work = new WorkMemory({ ...common, provider: providers.work });
    this.longTerm = new LongTermMemory({ ...common, provider: providers.longTerm, retriever: this.retriever });

    for (const id of LAYER_IDS) {
      this.logger.info('memory.layer.ready', { layer: id, provider: this.config[id].provider, location: providers[id].location });
    }
    return this;
  }

  // --- Short-term ----------------------------------------------------------

  getShortTermMemory() { return this.shortTerm.getShortTermMemory(); }
  saveShortTermMemory(messages) { return this.shortTerm.saveShortTermMemory(messages); }
  addMessage(message) { return this.shortTerm.addMessage(message); }
  clearShortTermMemory() { return this.shortTerm.clear(); }

  // --- Work ----------------------------------------------------------------

  createWorkMemory(taskId, init) { return this.work.createWorkMemory(taskId, init); }
  getWorkMemory(taskId) { return this.work.getWorkMemory(taskId); }
  getAllWorkMemory() { return this.work.getAll(); }
  saveWorkMemory(taskId, doc) { return this.work.saveWorkMemory(taskId, doc); }
  updateWorkMemory(taskId, updates, context) { return this.work.updateWorkMemory(taskId, updates, context); }
  clearWorkMemory(taskId) { return this.work.clearWorkMemory(taskId); }
  deleteWorkMemory(taskId) { return this.work.deleteWorkMemory(taskId); }

  // --- Long-term -----------------------------------------------------------

  /** @returns {Promise<{profile: object|null, solutions: object[], knowledge: object[]}>} */
  async getLongTermMemory() {
    const [profile, entries] = await Promise.all([this.profiles.getProfile(), this.longTerm.getEntries()]);
    return { profile, ...entries };
  }

  /** Replace solutions and/or knowledge. The profile is saved through the ProfileManager. */
  saveLongTermMemory(value) { return this.longTerm.saveEntries(value); }
  clearLongTermMemory(category) { return this.longTerm.clear(category); }

  /** The long-term entries relevant to `query`, within `budgetTokens`. */
  retrieveLongTerm(query, budgetTokens) { return this.longTerm.retrieve(query, budgetTokens); }

  // --- Generic operations ----------------------------------------------------

  /**
   * Add an item to a layer.
   *   shortTerm  {role, content, taskId?, state?}
   *   work       {taskId, field: requirements|decisions|facts, content}
   *   longTerm   {category: solutions|knowledge, content, tags?, pinned?, source?}
   */
  async addMemory(layer, data) {
    switch (layer) {
      case 'shortTerm':
        return this.addMessage(data);
      case 'work':
        if (!TEXT_LISTS.includes(data.field)) throw badRequest(`Work memory field must be one of: ${TEXT_LISTS.join(', ')}.`);
        return this.updateWorkMemory(data.taskId, { [data.field]: [data.content] }, { source: data.source ?? 'user' });
      case 'longTerm':
        if (!isCategory(data.category)) throw badRequest('Category must be "solutions" or "knowledge".');
        return this.longTerm.addEntry(data);
      default:
        throw badRequest(`Unknown memory layer "${layer}".`);
    }
  }

  /**
   * Change one item.
   *   work      ref = {taskId, field, index}, changes = {content}
   *   longTerm  ref = entry id, changes = {content?, tags?, pinned?, category?}
   */
  async updateMemory(layer, ref, changes) {
    if (layer === 'work') {
      const doc = await this.work.editItem(ref.taskId, ref.field, ref.index, changes.content);
      if (!doc) throw notFound('Work memory item not found.', 'memory_not_found');
      return doc;
    }
    if (layer === 'longTerm') {
      const entry = await this.longTerm.updateEntry(ref, changes);
      if (!entry) throw notFound('Long-term memory entry not found.', 'memory_not_found');
      return entry;
    }
    throw badRequest(`Items of layer "${layer}" cannot be edited.`);
  }

  /**
   * Delete one item.
   *   shortTerm  ref = message id
   *   work       ref = {taskId, field, index}
   *   longTerm   ref = entry id
   */
  async deleteMemory(layer, ref) {
    let ok;
    if (layer === 'shortTerm') ok = await this.shortTerm.deleteMessage(ref);
    else if (layer === 'work') ok = Boolean(await this.work.editItem(ref.taskId, ref.field, ref.index, null));
    else if (layer === 'longTerm') ok = await this.longTerm.deleteEntry(ref);
    else throw badRequest(`Unknown memory layer "${layer}".`);
    if (!ok) throw notFound('Memory item not found.', 'memory_not_found');
    return true;
  }

  /**
   * Copy one item of a task's work memory into long-term memory. This is the
   * only way work memory reaches long-term memory, and it is always an
   * explicit user action. The entry remembers where it came from.
   *
   * @param {{taskId: string, field: string, index?: number, category: 'solutions'|'knowledge',
   *          content?: string, tags?: string[]}} input `content` overrides the item's text (edit before saving).
   */
  async promoteToLongTerm({ taskId, field, index, category, content, tags = [] }) {
    if (!PROMOTABLE_FIELDS.includes(field)) throw badRequest(`Field must be one of: ${PROMOTABLE_FIELDS.join(', ')}.`);
    if (!isCategory(category)) throw badRequest('Category must be "solutions" or "knowledge".');
    const doc = await this.getWorkMemory(taskId);

    let text;
    if (field === 'objective') text = doc.objective;
    else if (field === 'plan' && index === undefined) text = doc.plan.map((s, i) => `${i + 1}. ${s}`).join('\n');
    else {
      const item = doc[field]?.[index];
      text = RESULT_LISTS.includes(field) ? item?.text : item;
    }
    if (!text) throw notFound('Work memory item not found.', 'memory_not_found');

    const result = await this.longTerm.addEntry({
      category, content: content?.trim() || text, tags, source: 'promoted', origin: { taskId, field, index: index ?? null },
    });
    await this.work.note(taskId, { source: 'user', fields: [`promoted ${field} → long-term ${category}`] });
    this.logger.info('memory.promoted', { taskId, field, index: index ?? null, category, created: result.created });
    return result;
  }

  // --- Token counts ------------------------------------------------------------

  /**
   * Token counts of each layer as stored: short-term as chat turns, work
   * memory of one task as it is formatted into the context, long-term as the
   * profile plus every solution and knowledge entry.
   */
  async tokenStats(taskId) {
    const [messages, longTerm, work] = await Promise.all([
      this.getShortTermMemory(),
      this.getLongTermMemory(),
      taskId ? this.getWorkMemory(taskId) : Promise.resolve(null),
    ]);
    const tc = this.tokenCounter;
    const profile = longTerm.profile ? tc.countText(formatProfile(longTerm.profile)) : 0;
    const entries = tc.countText(formatLongTermMemory(longTerm));
    return {
      shortTerm: this.shortTerm.calculateTokenCount(messages),
      work: work ? tc.countText(formatWorkMemory(work)) : 0,
      longTerm: profile + entries,
      longTermBreakdown: { profile, entries },
      counts: {
        shortTermMessages: messages.length,
        solutions: longTerm.solutions.length,
        knowledge: longTerm.knowledge.length,
      },
    };
  }

  // --- Storage configuration -------------------------------------------------

  describeStorage() {
    const current = { shortTerm: this.shortTerm, work: this.work, longTerm: this.longTerm };
    const layers = {};
    for (const id of LAYER_IDS) {
      const instance = current[id].provider;
      layers[id] = {
        label: MEMORY_LAYERS[id].label,
        purpose: MEMORY_LAYERS[id].purpose,
        provider: this.config[id].provider,
        options: this.config[id].options,
        persistent: instance.persistent,
        location: instance.location,
      };
    }
    return {
      layers,
      shortTermMaxMessages: this.config.shortTermMaxMessages,
      providers: listProviders(),
      updatedAt: this.config.updatedAt,
      location: this.configStore.doc.location,
    };
  }

  /**
   * Apply a storage change. Data is never lost by a change: switching a
   * layer's provider copies its current content into the new provider (the
   * JSON provider keeps the replaced version as .bak), and the old provider is
   * left untouched.
   */
  updateStorage(patch) {
    return this.#configQueue.run(async () => {
      const next = this.configStore.applyPatch(this.config, patch);
      const changes = [];
      const layers = { shortTerm: this.shortTerm, work: this.work, longTerm: this.longTerm };

      for (const id of LAYER_IDS) {
        const before = this.config[id];
        const after = next[id];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;

        const provider = await this.#providerFor(id, after);
        const change = { layer: id, from: before.provider, to: after.provider, copied: 0 };
        await layers[id].setProvider(provider, async (old) => {
          if (before.provider === after.provider) return; // Only options changed; same data.
          const entries = await old.getAll();
          await provider.replaceAll(entries);
          change.copied = Object.keys(entries).length;
        });
        changes.push(change);
        this.logger.info('memory.storage.changed', change);
      }

      if (next.shortTermMaxMessages !== this.config.shortTermMaxMessages) {
        await this.shortTerm.setMaxMessages(next.shortTermMaxMessages);
        changes.push({ layer: 'shortTerm', retention: next.shortTermMaxMessages });
      }

      this.config = await this.configStore.save(next);
      return { storage: this.describeStorage(), changes };
    });
  }

  #providerFor(id, { provider, options }) {
    return createProvider(provider, { file: MEMORY_LAYERS[id].file, dataDir: this.dataDir, options, logger: this.logger });
  }
}
