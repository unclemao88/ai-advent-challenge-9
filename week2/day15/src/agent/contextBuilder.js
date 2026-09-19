import { CONTINUE_MARKER, STATE_INSTRUCTIONS, SYSTEM_INSTRUCTIONS, stepNotes } from './prompts.js';
import { LIFECYCLE, TRANSITIONS } from './stateMachine.js';
import { formatProfile } from '../profile/profileManager.js';
import { formatInvariants } from '../invariants/invariantManager.js';
import { formatLongTermMemory } from '../memory/longTermMemory.js';
import { formatWorkMemory } from '../memory/workMemory.js';

export const HEADERS = Object.freeze({
  system: '[SYSTEM INSTRUCTIONS]',
  profile: '[USER PROFILE]',
  invariants: '[AGENT INVARIANTS]',
  task: '[CURRENT TASK]',
  work: '[WORK MEMORY]',
  longTerm: '[LONG-TERM MEMORY]',
  shortTerm: '[SHORT-TERM MEMORY]',
  taskState: '[TASK STATE]',
  request: '[CURRENT REQUEST]',
});

/** The order of the sections in the request. Deterministic; the tests pin it. */
export const SECTION_ORDER = Object.freeze(['system', 'profile', 'invariants', 'task', 'work', 'longTerm', 'shortTerm', 'taskState', 'request']);

/**
 * Builds the exact message array sent to DeepSeek. It is the single source of
 * truth for the API context: the agent sends its `messages`, and every token
 * count shown in the UI is computed from the same output.
 *
 *   system            [SYSTEM INSTRUCTIONS] [USER PROFILE] [AGENT INVARIANTS] [CURRENT TASK]
 *                     [WORK MEMORY] [LONG-TERM MEMORY] (relevant entries) [SHORT-TERM MEMORY] (a note)
 *   user/assistant …  the short-term memory as chat turns, oldest first
 *   user              [TASK STATE] [CURRENT REQUEST]
 *
 * Every section is always present (the profile and the invariants go into
 * every request) and an empty one says so. When the request exceeds the
 * context budget, the oldest chat turns are dropped; nothing else is cut.
 */
export class ContextBuilder {
  /**
   * @param {{tokenCounter: import('../token/tokenCounter.js').TokenCounter, maxContextTokens?: number,
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
   *   invariants: object[],
   *   task: object,
   *   state: string,
   *   work: object|null,
   *   longTerm: {solutions: object[], knowledge: object[]}|null,
   *   shortTerm: Array<{role: string, content: string}>,
   *   userMessage?: string|null,
   *   notes?: object
   * }} input
   */
  build({ profile, invariants = [], task, state, work, longTerm, shortTerm = [], userMessage = null, notes = {} }) {
    const tc = this.tokenCounter;
    const workText = work ? formatWorkMemory(work) : '';
    const longText = formatLongTermMemory(longTerm);
    const sections = {
      system: `${HEADERS.system}\n${this.systemInstructions}`,
      profile: `${HEADERS.profile}\n${formatProfile(profile)}`,
      invariants: `${HEADERS.invariants}\n${formatInvariants(invariants)}`,
      task: `${HEADERS.task}\n${formatTask(task, state)}`,
      work: `${HEADERS.work}\n${workText || 'Empty: nothing is recorded for this task yet.'}`,
      longTerm: `${HEADERS.longTerm}\n${longText || 'Empty: no stored solution or knowledge is relevant to this request.'}`,
      taskState: formatTaskState({ state, notes }),
      request: formatRequest(userMessage),
    };

    // Keep the newest turns that fit the budget; the rest of the context is never cut.
    let turns = shortTerm;
    let droppedTurns = 0;
    let messages = assemble(sections, turns);
    let total = tc.countRequest(messages);
    if (total > this.maxContextTokens && turns.length) {
      let excess = total - this.maxContextTokens;
      while (excess > 0 && droppedTurns < turns.length) {
        excess -= tc.countTurns([turns[droppedTurns]]);
        droppedTurns += 1;
      }
      // Never start the replay with an assistant turn.
      while (droppedTurns < turns.length && turns[droppedTurns].role === 'assistant') droppedTurns += 1;
      turns = turns.slice(droppedTurns);
      messages = assemble(sections, turns);
      total = tc.countRequest(messages);
    }

    const shortTermText = shortTermNote(turns.length);
    const tokens = {
      system: tc.countText(sections.system),
      profile: tc.countText(sections.profile),
      invariants: tc.countText(sections.invariants),
      task: tc.countText(sections.task),
      work: tc.countText(sections.work),
      longTerm: tc.countText(sections.longTerm),
      shortTerm: tc.countText(shortTermText) + tc.countTurns(turns),
      taskState: tc.countText(sections.taskState),
      // The final user turn's text plus its role marker.
      request: tc.countText(sections.request) + 1,
      total,
    };
    return {
      messages,
      sections: { ...sections, shortTerm: shortTermText, turns },
      order: SECTION_ORDER,
      tokens,
      droppedTurns,
      tokenizer: tc.info,
    };
  }
}

function assemble(sections, turns) {
  const system = [
    sections.system, sections.profile, sections.invariants, sections.task, sections.work, sections.longTerm, shortTermNote(turns.length),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    ...turns.map(({ role, content }) => ({ role, content })),
    { role: 'user', content: `${sections.taskState}\n\n${sections.request}` },
  ];
}

function shortTermNote(count) {
  return count
    ? `${HEADERS.shortTerm}\nThe ${count} most recent message(s) of the conversation follow as chat messages.`
    : `${HEADERS.shortTerm}\nEmpty: this is the start of the conversation.`;
}

/** The task as the model needs it: what, how far, and where it may go from here. */
function formatTask(task, state) {
  const proposable = (TRANSITIONS[state] ?? []).filter((s) => LIFECYCLE.includes(s) && s !== state);
  const lines = [
    `Task ID: ${task.id}`,
    `Objective: ${task.objective || task.title || '(not recorded)'}`,
    `Execution mode: ${task.mode}`,
    `Lifecycle: ${LIFECYCLE.map((s) => (s === state ? `[${s}]` : s)).join(' → ')}`,
    `Allowed transitions from ${state}: ${(TRANSITIONS[state] ?? []).join(', ')}`,
    `You may propose as the next state: ${proposable.join(' or ') || 'nothing'}`,
  ];
  const attempts = task.validation?.attempts ?? 0;
  if (attempts) lines.push(`Failed validations so far: ${attempts}`);
  return lines.join('\n');
}

function formatTaskState({ state, notes }) {
  return [
    HEADERS.taskState,
    `Current state: ${state}`,
    `Step instruction: ${STATE_INSTRUCTIONS[state] ?? ''}`,
    ...stepNotes(notes).map((note) => `Note: ${note}`),
  ].join('\n');
}

function formatRequest(userMessage) {
  return [
    HEADERS.request,
    userMessage?.trim() ? userMessage.trim() : CONTINUE_MARKER,
    '',
    'Answer with the single JSON object described in the system instructions.',
  ].join('\n');
}
