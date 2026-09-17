import { WORK_FIELDS } from '../memory/workMemory.js';
import { PROFILE_FIELDS } from '../memory/profile.js';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a helpful AI agent with a user profile and three memory layers.',
  '- USER PROFILE: how this user wants you to answer. Follow it in every reply; it outranks your own defaults.',
  '- LONG-TERM MEMORY: solutions and knowledge kept from earlier conversations.',
  '- WORK MEMORY: the current task — requirements, constraints, decisions and progress.',
  '- The chat messages that follow are SHORT-TERM MEMORY: the recent conversation.',
  'Use the memory when it is relevant, prefer the newest information when entries conflict, '
    + 'and do not recite memory back unless asked.',
  'You cannot write to memory yourself. The user saves things with lines such as "task: …", '
    + '"decision: …", "remember: …" or "style: …"; never claim you saved something.',
].join('\n');

export const PROFILE_HEADER = '## USER PROFILE';
export const LONG_TERM_HEADER = '## LONG-TERM MEMORY';
export const WORK_HEADER = '## WORK MEMORY';

/**
 * Builds the exact message array sent to DeepSeek, in one fixed order:
 *
 *   system           instructions + USER PROFILE + LONG-TERM MEMORY + WORK MEMORY
 *   user/assistant…  SHORT-TERM MEMORY (the conversation, oldest first)
 *   user             the current request
 *
 * The profile, long-term and work memory go into the single system message
 * rather than extra system turns, which every DeepSeek model accepts. Empty and
 * disabled layers are left out entirely, so they cost nothing — and the profile
 * appears exactly once, never repeated per turn.
 *
 * Alongside the messages it returns each part as a separate string (`sections`),
 * so every layer can be counted on exactly the text that represents it. This is
 * the single source of both the payload and the token counts, which is why the
 * number shown in the UI cannot drift from what is actually sent.
 *
 * @param {{
 *   systemPrompt?: string,
 *   profile?: object,
 *   longTerm?: {solutions?: object[], knowledge?: object[]},
 *   work?: object,
 *   shortTerm?: Array<{role: string, content: string}>,
 *   request?: string
 * }} input
 */
export function buildContext({ systemPrompt = DEFAULT_SYSTEM_PROMPT, profile, longTerm, work, shortTerm, request }) {
  const sections = {
    system: String(systemPrompt).trim(),
    profile: formatProfile(profile),
    longTerm: formatLongTermMemory(longTerm),
    work: formatWorkMemory(work),
    shortTerm: formatConversation(shortTerm),
    request: typeof request === 'string' ? request.trim() : '',
  };

  const systemParts = [sections.system];
  if (sections.profile) systemParts.push(`${PROFILE_HEADER}\n${sections.profile}`);
  if (sections.longTerm) systemParts.push(`${LONG_TERM_HEADER}\n${sections.longTerm}`);
  if (sections.work) systemParts.push(`${WORK_HEADER}\n${sections.work}`);

  const messages = [{ role: 'system', content: systemParts.join('\n\n') }, ...sections.shortTerm];
  // An empty draft (the live preview before the user types) adds no turn.
  if (sections.request) messages.push({ role: 'user', content: sections.request });

  return { messages, sections };
}

/** The profile as labelled lines. Returns '' when the user has not filled it in. */
export function formatProfile(profile) {
  if (!profile) return '';
  const lines = [];
  for (const [field, { label }] of Object.entries(PROFILE_FIELDS)) {
    if (profile[field]) lines.push(`${label}: ${profile[field]}`);
  }
  return lines.join('\n');
}

/** Long-term memory as compact labelled lists. Returns '' when there is nothing. */
export function formatLongTermMemory(longTerm) {
  if (!longTerm) return '';
  const blocks = [];

  if (longTerm.solutions?.length) {
    blocks.push(['Solutions to earlier problems:',
      ...longTerm.solutions.map((s) => `- Problem: ${s.problem}\n  Solution: ${indent(s.solution)}`)]);
  }
  if (longTerm.knowledge?.length) {
    blocks.push(['Knowledge:', ...longTerm.knowledge.map((k) => `- [${k.topic}] ${k.fact}`)]);
  }

  return blocks.map((lines) => lines.join('\n')).join('\n');
}

/** Work memory in field order. Returns '' when the task is empty. */
export function formatWorkMemory(work) {
  if (!work) return '';
  const lines = [];

  for (const [field, { kind, label }] of Object.entries(WORK_FIELDS)) {
    const value = work[field];
    if (kind === 'single' && value) lines.push(`${label}: ${value}`);
    if (kind === 'list' && value?.length) lines.push(`${label}:`, ...value.map((item) => `- ${item}`));
  }

  return lines.join('\n');
}

/** Stored messages → API messages: role and content only, nothing else leaks. */
export function formatConversation(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .map(({ role, content }) => ({ role, content }));
}

function indent(text) {
  return String(text).replace(/\n/g, '\n  ');
}
