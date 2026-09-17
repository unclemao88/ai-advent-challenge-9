import { ShortTermMemory, DEFAULT_MAX_MESSAGES, MIN_MAX_MESSAGES, MAX_MAX_MESSAGES } from './shortTermMemory.js';
import { WorkMemory } from './workMemory.js';
import { LongTermMemory } from './longTermMemory.js';
import { ProfileStore } from './profile.js';
import { ConversationStore, DEFAULT_MAX_ENTRIES, MIN_MAX_ENTRIES, MAX_MAX_ENTRIES } from './conversationStore.js';

/**
 * Every persisted layer in one place: what it is called, which class implements
 * it, which directory it owns, and which storage modes it may use.
 *
 * The settings store validates against this, the memory manager builds from it
 * and the UI renders from it, so adding a layer or a mode means editing this
 * list and nothing else.
 *
 * `size` describes the one numeric setting a layer may have (how much of it is
 * kept), which is why short-term memory's "keep last N messages" is a setting
 * rather than a constant anywhere in the code.
 */
export const LAYER_DEFINITIONS = [
  {
    id: 'shortTerm',
    Class: ShortTermMemory,
    label: 'Short-term memory',
    purpose: 'The current conversation, replayed to DeepSeek on every request.',
    modes: ['json', 'memory', 'disabled'],
    size: {
      key: 'maxMessages',
      label: 'Keep last N messages',
      default: DEFAULT_MAX_MESSAGES,
      min: MIN_MAX_MESSAGES,
      max: MAX_MAX_MESSAGES,
    },
  },
  {
    id: 'work',
    Class: WorkMemory,
    label: 'Work memory',
    purpose: 'The current task: requirements, constraints, decisions, facts and progress.',
    modes: ['json', 'memory', 'disabled'],
  },
  {
    id: 'longTerm',
    Class: LongTermMemory,
    label: 'Long-term memory',
    purpose: 'Solutions and knowledge worth keeping after this task is over.',
    modes: ['json', 'memory', 'disabled'],
  },
  {
    id: 'profile',
    Class: ProfileStore,
    label: 'User profile',
    // Rule: the profile goes into every request, so it has no "disabled" mode.
    // An empty profile already costs nothing — it is left out of the context.
    purpose: 'Style, format and limitations. Attached to every request.',
    modes: ['json', 'memory'],
  },
  {
    id: 'conversation',
    Class: ConversationStore,
    label: 'Conversation history',
    purpose: 'The full record of the chat. Restored on reload, never sent to DeepSeek.',
    modes: ['json', 'memory'],
    size: {
      key: 'maxEntries',
      label: 'Keep last N entries',
      default: DEFAULT_MAX_ENTRIES,
      min: MIN_MAX_ENTRIES,
      max: MAX_MAX_ENTRIES,
    },
  },
];

/** The three layers the context is built from, in context order. */
export const MEMORY_LAYER_IDS = ['longTerm', 'work', 'shortTerm'];

export const LAYER_IDS = LAYER_DEFINITIONS.map((layer) => layer.id);

const BY_ID = new Map(LAYER_DEFINITIONS.map((layer) => [layer.id, layer]));

export function layerDefinition(id) {
  return BY_ID.get(id);
}

export function isLayerId(id) {
  return BY_ID.has(id);
}
