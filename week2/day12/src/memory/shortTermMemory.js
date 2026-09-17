import { randomUUID } from 'node:crypto';

import { MemoryLayer, isPlainObject, isoTimestamp } from './memoryLayer.js';

export const DEFAULT_MAX_MESSAGES = 20;
export const MIN_MAX_MESSAGES = 2;
export const MAX_MAX_MESSAGES = 500;

const ROLES = new Set(['user', 'assistant']);

/**
 * Short-term memory: the current conversation, oldest message first.
 *
 * Stored as one document, `conversation`:
 *   { "messages": [{ "id", "role", "content", "timestamp" }] }
 *
 * It holds a bounded window of recent messages. When a new exchange pushes it
 * past `maxMessages`, the oldest messages are dropped.
 */
export class ShortTermMemory extends MemoryLayer {
  static id = 'shortTerm';
  static directory = 'short-term';

  #maxMessages;

  /**
   * @param {{storage: import('./storage/StorageProvider.js').StorageProvider, maxMessages?: number}} options
   */
  constructor({ storage, maxMessages = DEFAULT_MAX_MESSAGES }) {
    super({ storage });
    this.#maxMessages = maxMessages;
  }

  get documents() {
    return { conversation: () => ({ messages: [] }) };
  }

  get maxMessages() {
    return this.#maxMessages;
  }

  normalize(documentName, value) {
    const messages = isPlainObject(value) && Array.isArray(value.messages) ? value.messages : [];
    // A malformed entry (hand-edited, or from an older format) is dropped
    // rather than allowed to break every future request.
    return { messages: messages.filter(isUsableMessage).map(normalizeMessage) };
  }

  /** @returns {Promise<Array<{id: string, role: string, content: string, timestamp: string}>>} */
  async getMessages() {
    return (await this.read()).conversation.messages;
  }

  /**
   * Append messages in one atomic update, so a question and its answer are
   * always stored together and stay adjacent even under concurrent requests.
   */
  async append(...messages) {
    const data = await this.update((draft) => {
      draft.conversation.messages.push(...messages);
      draft.conversation.messages = trimToWindow(draft.conversation.messages, this.#maxMessages);
    });
    return data.conversation.messages;
  }

  /** Change the window size and trim the stored conversation to fit it now. */
  async setMaxMessages(maxMessages) {
    this.#maxMessages = maxMessages;
    await this.update((draft) => {
      draft.conversation.messages = trimToWindow(draft.conversation.messages, maxMessages);
    });
  }
}

/**
 * Build a conversation message. Id and timestamp are produced here, never taken
 * from a request.
 *
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {Date} [when]
 */
export function createConversationMessage(role, content, when = new Date()) {
  if (!ROLES.has(role)) throw new Error(`Unknown message role: ${role}`);
  return { id: randomUUID(), role, content: String(content), timestamp: when.toISOString() };
}

/**
 * Keep the newest `max` messages. A window must not open on an orphaned answer
 * whose question was dropped, so a leading assistant message goes too.
 */
function trimToWindow(messages, max) {
  if (messages.length <= max) return messages;
  const kept = messages.slice(-max);
  return kept[0]?.role === 'assistant' ? kept.slice(1) : kept;
}

function isUsableMessage(message) {
  return isPlainObject(message) && ROLES.has(message.role) && typeof message.content === 'string';
}

function normalizeMessage(message) {
  return {
    id: typeof message.id === 'string' && message.id ? message.id : randomUUID(),
    role: message.role,
    content: message.content,
    timestamp: isoTimestamp(message.timestamp, new Date(0).toISOString()),
  };
}
