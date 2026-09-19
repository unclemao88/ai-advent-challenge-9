import { randomUUID } from 'node:crypto';

import { SerialQueue } from '../utils/serialQueue.js';
import { isPlainObject } from '../utils/validate.js';

const KEY = 'messages';
const ROLES = new Set(['user', 'assistant']);

/**
 * Short-term memory: the current conversation, as the agent remembers it.
 *
 * One value (`messages`) in its own provider — `data/memory/short-term.json`
 * with the JSON provider. It keeps the most recent `maxMessages` messages; the
 * complete history is the chat history (data/history/chat-history.json), which is
 * what the chat shows. Clearing this layer makes the agent forget the
 * conversation without deleting the visible history.
 *
 * Each message records the task and the task state it belongs to. Messages of
 * kind "status" (e.g. "Task complete") are kept for the record but are not
 * replayed to the model.
 */
export class ShortTermMemory {
  #provider;
  #queue = new SerialQueue();

  /**
   * @param {{provider: import('./storage/StorageProvider.js').StorageProvider, maxMessages: number,
   *          tokenCounter: import('../token/tokenCounter.js').TokenCounter, logger: object}} options
   */
  constructor({ provider, maxMessages, tokenCounter, logger }) {
    this.#provider = provider;
    this.maxMessages = maxMessages;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
  }

  get provider() {
    return this.#provider;
  }

  /** Swap the provider under the layer's lock; `migrate(old)` runs first, inside the same lock. */
  setProvider(provider, migrate) {
    return this.#queue.run(async () => {
      const result = migrate ? await migrate(this.#provider) : undefined;
      this.#provider = provider;
      return result;
    });
  }

  setMaxMessages(maxMessages) {
    return this.#queue.run(async () => {
      this.maxMessages = maxMessages;
      const messages = await this.#read();
      if (messages.length > maxMessages) await this.#write(messages.slice(-maxMessages));
    });
  }

  /** @returns {Promise<object[]>} Every retained message, oldest first. */
  getShortTermMemory() {
    return this.#queue.run(() => this.#read());
  }

  /** Replace the layer's content (validated). */
  saveShortTermMemory(messages) {
    if (!Array.isArray(messages)) throw new Error('Short-term memory must be an array of messages.');
    return this.#queue.run(async () => {
      const clean = messages.filter(isMessage).slice(-this.maxMessages);
      await this.#write(clean);
      return clean;
    });
  }

  /**
   * @param {{role: 'user'|'assistant', content: string, kind?: string, taskId?: string|null,
   *          state?: string|null, id?: string, timestamp?: string}} input
   * @returns {Promise<object>} The stored message.
   */
  addMessage({ role, content, kind = 'message', taskId = null, state = null, id, timestamp }) {
    if (!ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
    if (typeof content !== 'string' || !content.trim()) throw new Error('A message needs content.');
    const message = {
      id: id ?? randomUUID(),
      role,
      kind,
      content,
      timestamp: timestamp ?? new Date().toISOString(),
      taskId,
      state,
    };
    return this.#queue.run(async () => {
      const messages = await this.#read();
      messages.push(message);
      await this.#write(messages.slice(-this.maxMessages));
      this.logger.debug('memory.short_term.add', { role, kind, taskId, chars: content.length });
      return message;
    });
  }

  /** @returns {Promise<boolean>} Whether a message was removed. */
  deleteMessage(id) {
    return this.#queue.run(async () => {
      const messages = await this.#read();
      const kept = messages.filter((m) => m.id !== id);
      if (kept.length === messages.length) return false;
      await this.#write(kept);
      this.logger.info('memory.short_term.delete', { messageId: id });
      return true;
    });
  }

  clear() {
    return this.#queue.run(async () => {
      await this.#write([]);
      this.logger.info('memory.short_term.clear');
    });
  }

  /** Messages as the model sees them: role and content only, status notes left out. */
  static toTurns(messages, { excludeId } = {}) {
    return messages
      .filter((m) => m.kind !== 'status' && m.id !== excludeId && ROLES.has(m.role))
      .map(({ role, content }) => ({ role, content }));
  }

  /** Tokens of the whole layer as chat turns, including DeepSeek's role markers. */
  calculateTokenCount(messages) {
    return this.tokenCounter.countTurns(ShortTermMemory.toTurns(messages));
  }

  async #read() {
    const messages = await this.#provider.get(KEY);
    return Array.isArray(messages) ? messages.filter(isMessage) : [];
  }

  #write(messages) {
    return this.#provider.set(KEY, messages);
  }
}

function isMessage(m) {
  return isPlainObject(m) && ROLES.has(m.role) && typeof m.content === 'string'
    && typeof m.id === 'string' && typeof m.timestamp === 'string';
}
