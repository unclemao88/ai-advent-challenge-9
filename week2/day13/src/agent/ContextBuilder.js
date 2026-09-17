import { CONTINUE_MARKER, STATE_INSTRUCTIONS, SYSTEM_INSTRUCTIONS } from './prompts.js';
import { formatProfile } from '../profile/ProfileManager.js';
import { formatLongTermMemory } from '../memory/LongTermMemory.js';
import { formatWorkMemory } from '../memory/WorkMemory.js';

export const HEADERS = Object.freeze({
  system: '[SYSTEM INSTRUCTIONS]',
  profile: '[USER PROFILE]',
  longTerm: '[LONG-TERM MEMORY]',
  work: '[WORK MEMORY]',
  shortTerm: '[SHORT-TERM MEMORY]',
  request: '[CURRENT REQUEST]',
});

/**
 * Builds the exact message array sent to DeepSeek, always in this order:
 *
 *   system     [SYSTEM INSTRUCTIONS] [USER PROFILE] [LONG-TERM MEMORY] [WORK MEMORY] [SHORT-TERM MEMORY] note
 *   user/assistant …   the short-term memory as chat turns, oldest first
 *   user       [CURRENT REQUEST]: task, state, step instruction, the user's message
 *
 * Every section header is always present; an empty layer leaves its section
 * empty. The same call returns the token count of each section and of the
 * complete request, so the number shown in the UI is computed from exactly the
 * payload that is sent.
 */
export class ContextBuilder {
  /**
   * @param {{tokenCounter: import('../tokens/TokenCounter.js').TokenCounter, maxContextTokens?: number,
   *          systemInstructions?: string}} options
   */
  constructor({ tokenCounter, maxContextTokens = 100_000, systemInstructions = SYSTEM_INSTRUCTIONS }) {
    this.tokenCounter = tokenCounter;
    this.maxContextTokens = maxContextTokens;
    this.systemInstructions = systemInstructions;
  }

  /**
   * @param {{
   *   profile: object|null,
   *   longTerm: object|null,
   *   work: object|null,
   *   shortTerm: Array<{role: string, content: string}>,
   *   task: {taskId: string, title?: string, mode: string},
   *   state: string,
   *   userMessage?: string|null
   * }} input
   */
  build({ profile, longTerm, work, shortTerm = [], task, state, userMessage = null }) {
    const tc = this.tokenCounter;
    const sections = {
      system: `${HEADERS.system}\n${this.systemInstructions}`,
      profile: `${HEADERS.profile}\n${formatProfile(profile)}`.trimEnd(),
      longTerm: `${HEADERS.longTerm}\n${formatLongTermMemory(longTerm)}`.trimEnd(),
      work: `${HEADERS.work}\n${work ? [`Task ID: ${task.taskId}`, formatWorkMemory(work)].filter(Boolean).join('\n') : ''}`.trimEnd(),
      request: formatRequest({ task, state, userMessage }),
    };
    const fixedTokens = {
      system: tc.countText(sections.system),
      profile: tc.countText(sections.profile),
      longTerm: tc.countText(sections.longTerm),
      work: tc.countText(sections.work),
    };

    // Keep the newest turns that fit the budget; the rest of the context is never cut.
    let turns = shortTerm;
    let droppedTurns = 0;
    let assembled = this.#assemble(sections, turns);
    let total = tc.countRequest(assembled);
    if (total > this.maxContextTokens && turns.length) {
      let excess = total - this.maxContextTokens;
      while (excess > 0 && droppedTurns < turns.length) {
        excess -= tc.countTurns([turns[droppedTurns]]);
        droppedTurns += 1;
      }
      // Never start the replay with an assistant turn.
      while (droppedTurns < turns.length && turns[droppedTurns].role === 'assistant') droppedTurns += 1;
      turns = turns.slice(droppedTurns);
      assembled = this.#assemble(sections, turns);
      total = tc.countRequest(assembled);
    }

    const tokens = {
      ...fixedTokens,
      shortTerm: tc.countText(shortTermNote(turns.length)) + tc.countTurns(turns),
      request: tc.countTurns([{ role: 'user', content: sections.request }]),
      total,
    };
    return {
      messages: assembled,
      sections: { ...sections, shortTerm: shortTermNote(turns.length), turns },
      tokens,
      droppedTurns,
      tokenizer: tc.info,
    };
  }

  #assemble(sections, turns) {
    const system = [
      sections.system, sections.profile, sections.longTerm, sections.work, shortTermNote(turns.length),
    ].join('\n\n');
    return [
      { role: 'system', content: system },
      ...turns.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: sections.request },
    ];
  }
}

function shortTermNote(count) {
  return count
    ? `${HEADERS.shortTerm}\nThe ${count} most recent message(s) of the conversation follow as chat messages.`
    : HEADERS.shortTerm;
}

function formatRequest({ task, state, userMessage }) {
  return [
    HEADERS.request,
    `Task ID: ${task.taskId}`,
    `Execution mode: ${task.mode}`,
    `Current state: ${state}`,
    `Step instruction: ${STATE_INSTRUCTIONS[state]}`,
    'User message:',
    userMessage?.trim() ? userMessage.trim() : CONTINUE_MARKER,
    '',
    'Answer with the single JSON object described in the system instructions.',
  ].join('\n');
}
