import { randomUUID } from 'node:crypto';

import { JsonDocument } from '../utils/jsonDocument.js';
import { isPlainObject } from '../utils/validate.js';

export const TAGS = Object.freeze({ user: 'you asked', assistant: 'agent answered' });
const MAX_MESSAGES = 2000;

/**
 * The complete conversation log, `data/conversation.json`:
 *
 *   { "messages": [ { "id", "role", "tag": "you asked" | "agent answered",
 *                     "content", "timestamp", "taskId", "kind", "task", … } ] }
 *
 * This is what the chat shows after a reload. It is a record, not agent
 * memory: the model sees the conversation through short-term memory, which
 * keeps only the recent part and can be cleared on its own.
 *
 * Agent messages carry the task state they were given in (`task`), the token
 * usage of the call, detected invariant conflicts and long-term memory
 * suggestions, so the chat can be redrawn exactly.
 */
export class ConversationStore {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.doc = new JsonDocument({
      dataDir, file: 'conversation.json', logger, empty: () => ({ messages: [] }), normalize,
    });
  }

  get location() {
    return this.doc.location;
  }

  init() {
    return this.doc.init();
  }

  async list() {
    return (await this.doc.read()).messages;
  }

  /**
   * @param {{role: 'user'|'assistant', content: string, kind?: 'message'|'status'|'conflict',
   *          taskId?: string|null, task?: object, usage?: object, conflicts?: object[],
   *          proposals?: object[], memoryUpdates?: object[]}} input
   */
  add({ role, content, kind = 'message', taskId = null, ...extra }) {
    if (!TAGS[role]) throw new Error(`Invalid role: ${role}`);
    if (typeof content !== 'string' || !content.trim()) throw new Error('A message needs content.');
    const message = {
      id: randomUUID(),
      role,
      tag: TAGS[role],
      content,
      timestamp: new Date().toISOString(),
      kind,
      taskId,
    };
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) message[key] = value;
    }
    return this.doc.update((doc) => {
      doc.messages.push(message);
      if (doc.messages.length > MAX_MESSAGES) doc.messages = doc.messages.slice(-MAX_MESSAGES);
      return { doc, result: message };
    });
  }

  clear() {
    return this.doc.update(() => {
      this.logger.info('conversation.clear');
      return { doc: { messages: [] }, result: true };
    });
  }
}

function normalize(value) {
  const messages = isPlainObject(value) && Array.isArray(value.messages) ? value.messages : [];
  return {
    messages: messages.filter((m) => isPlainObject(m) && TAGS[m.role] && typeof m.content === 'string'
      && typeof m.id === 'string' && typeof m.timestamp === 'string')
      .map((m) => ({ ...m, tag: TAGS[m.role] })),
  };
}
