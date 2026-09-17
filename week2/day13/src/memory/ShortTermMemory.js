import { randomUUID } from 'node:crypto';

import { SerialQueue } from '../utils/serialQueue.js';
import { isPlainObject } from '../utils/validate.js';

const DOC_KEY = 'conversation';
const ROLES = new Set(['user', 'assistant']);

/**
 * Short-term memory: the current conversation.
 *
 * Stored as one document (`short-term/conversation.json`) holding the most
 * recent `maxMessages` messages. Each message records which task it belongs to
 * and, for agent answers, the task state at the moment it was given, so the
 * chat can be redrawn exactly after a reload.
 *
 * Messages of kind "status" (e.g. "Task complete") are shown in the chat but
 * are not replayed to the model.
 */
export class ShortTermMemory {
  #backend;
  #queue = new SerialQueue();

  /**
   * @param {{backend: import('../storage/StorageBackend.js').StorageBackend, maxMessages: number,
   *          tokenCounter: import('../tokens/TokenCounter.js').TokenCounter, logger: object}} options
   */
  constructor({ backend, maxMessages, tokenCounter, logger }) {
    this.#backend = backend;
    this.maxMessages = maxMessages;
    this.tokenCounter = tokenCounter;
    this.logger = logger;
  }

  get backend() {
    return this.#backend;
  }

  /**
   * Swap the backend under the layer's lock. `migrate(oldBackend)` runs first,
   * inside the same lock, so no write can land in the old backend after the copy.
   */
  setBackend(backend, migrate) {
    return this.#queue.run(async () => {
      const result = migrate ? await migrate(this.#backend) : undefined;
      this.#backend = backend;
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

  /**
   * @param {{role: 'user'|'assistant', content: string, kind?: 'message'|'status', taskId?: string,
   *          task?: object, proposals?: object[], usage?: object}} input
   * @returns {Promise<object>} The stored message.
   */
  addMessage({ role, content, kind = 'message', taskId = null, task = null, proposals, usage }) {
    if (!ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
    if (typeof content !== 'string' || !content.trim()) throw new Error('A message needs content.');
    const message = {
      id: randomUUID(),
      role,
      kind,
      content,
      timestamp: new Date().toISOString(),
      taskId,
    };
    if (task) message.task = task;
    if (proposals?.length) message.proposals = proposals;
    if (usage) message.usage = usage;

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

  clearShortTermMemory() {
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
  async calculateTokenCount(messages) {
    const list = messages ?? (await this.getShortTermMemory());
    return this.tokenCounter.countTurns(ShortTermMemory.toTurns(list));
  }

  async #read() {
    const doc = await this.#backend.get(DOC_KEY);
    const messages = Array.isArray(doc?.messages) ? doc.messages : [];
    return messages.filter((m) => isPlainObject(m) && ROLES.has(m.role) && typeof m.content === 'string'
      && typeof m.id === 'string' && typeof m.timestamp === 'string');
  }

  #write(messages) {
    return this.#backend.put(DOC_KEY, { version: 1, messages, updatedAt: new Date().toISOString() });
  }
}
