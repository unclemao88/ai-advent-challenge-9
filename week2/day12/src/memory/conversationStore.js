import { randomUUID } from 'node:crypto';

import { MemoryLayer, cleanText, isPlainObject, isoTimestamp } from './memoryLayer.js';

export const DEFAULT_MAX_ENTRIES = 500;
export const MIN_MAX_ENTRIES = 10;
export const MAX_MAX_ENTRIES = 10_000;

/** The tag shown on a bubble, decided by the entry's type. */
export const ENTRY_TAGS = {
  user: 'you asked',
  assistant: 'agent answered',
  error: 'agent could not answer',
};

const MAX_ENTRY_CHARS = 20_000;

/**
 * The conversation log: the full record of what was asked and answered.
 *
 * This is NOT short-term memory. Short-term memory is the bounded window of
 * recent messages that is replayed to DeepSeek; this log keeps everything, is
 * never sent to the API, and is what the browser rebuilds the chat from after
 * a reload. The two are stored separately and trimmed by different settings.
 *
 * Stored as one document, `conversations`:
 *   { "entries": [{ "id", "timestamp", "date", "time", "type", "tag", "content" }] }
 */
export class ConversationStore extends MemoryLayer {
  static id = 'conversation';
  static directory = 'conversations';

  #maxEntries;

  constructor({ storage, maxEntries = DEFAULT_MAX_ENTRIES }) {
    super({ storage });
    this.#maxEntries = maxEntries;
  }

  get documents() {
    return { conversations: () => ({ entries: [] }) };
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  normalize(documentName, value) {
    const entries = isPlainObject(value) && Array.isArray(value.entries) ? value.entries : [];
    return { entries: entries.filter(isUsableEntry).map(normalizeEntry) };
  }

  /** @returns {Promise<object[]>} Every stored entry, oldest first. */
  async getEntries() {
    return (await this.read()).conversations.entries;
  }

  /** Append entries in one atomic update, keeping the newest `maxEntries`. */
  async append(...entries) {
    const data = await this.update((draft) => {
      draft.conversations.entries.push(...entries);
      if (draft.conversations.entries.length > this.#maxEntries) {
        draft.conversations.entries = draft.conversations.entries.slice(-this.#maxEntries);
      }
    });
    return data.conversations.entries;
  }

  async setMaxEntries(maxEntries) {
    this.#maxEntries = maxEntries;
    await this.update((draft) => {
      if (draft.conversations.entries.length > maxEntries) {
        draft.conversations.entries = draft.conversations.entries.slice(-maxEntries);
      }
    });
  }
}

/**
 * Build a log entry. The id, timestamp and tag are produced here and never
 * taken from a request, so the browser cannot invent its own.
 *
 * `date` and `time` are the UTC calendar fields of the same instant, stored
 * alongside the timestamp because the record is meant to be readable on its
 * own; the UI formats the ISO timestamp in the reader's own time zone.
 *
 * @param {'user'|'assistant'|'error'} type
 * @param {string} content
 * @param {Date} [when]
 */
export function createEntry(type, content, when = new Date()) {
  if (!ENTRY_TAGS[type]) throw new Error(`Unknown conversation entry type: ${type}`);
  const timestamp = when.toISOString();
  return {
    id: randomUUID(),
    timestamp,
    date: timestamp.slice(0, 10),
    time: timestamp.slice(11, 19),
    type,
    tag: ENTRY_TAGS[type],
    content: String(content),
  };
}

function isUsableEntry(entry) {
  return isPlainObject(entry) && ENTRY_TAGS[entry.type] && typeof entry.content === 'string';
}

function normalizeEntry(entry) {
  const timestamp = isoTimestamp(entry.timestamp, new Date(0).toISOString());
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
    timestamp,
    date: timestamp.slice(0, 10),
    time: timestamp.slice(11, 19),
    type: entry.type,
    // The tag is derived, not trusted: a hand-edited file cannot relabel a
    // question as an answer.
    tag: ENTRY_TAGS[entry.type],
    content: cleanText(entry.content, MAX_ENTRY_CHARS),
  };
}
