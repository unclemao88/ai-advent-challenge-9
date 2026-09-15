import { WORK_FIELDS } from '../memory/workMemory.js';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are a helpful AI agent with three memory layers.',
  '- LONG-TERM MEMORY: stable facts about the user and reusable knowledge from earlier conversations.',
  '- WORK MEMORY: the current task — requirements, decisions, constraints and progress.',
  '- The chat messages that follow are SHORT-TERM MEMORY: the recent conversation.',
  'Use the memory when it is relevant, prefer the newest information when entries conflict, '
    + 'and do not recite memory back unless asked.',
  'You cannot write to memory yourself. The user saves things with lines such as "task: …", '
    + '"decision: …", "todo: …", "remember: …" or "my name is …"; never claim you saved something.',
].join('\n');

/**
 * Builds the exact message array sent to DeepSeek.
 *
 *   system     instructions + LONG-TERM MEMORY + WORK MEMORY
 *   user/assistant …  SHORT-TERM MEMORY (the conversation, oldest first)
 *   user       the current request
 *
 * Memory goes into the single system message rather than extra system turns,
 * which every DeepSeek model accepts. Empty and disabled layers are left out
 * entirely, so they cost nothing.
 *
 * Alongside the messages it returns each part as a separate string (`sections`),
 * so every layer can be counted on exactly the text that represents it.
 *
 * @param {{
 *   systemPrompt?: string,
 *   longTerm?: object,
 *   work?: object,
 *   shortTerm?: Array<{role: string, content: string}>,
 *   request?: string
 * }} input
 */
export function buildContext({ systemPrompt = DEFAULT_SYSTEM_PROMPT, longTerm, work, shortTerm, request }) {
  const sections = {
    system: String(systemPrompt).trim(),
    longTerm: formatLongTermMemory(longTerm),
    work: formatWorkMemory(work),
    shortTerm: formatConversation(shortTerm),
    request: typeof request === 'string' ? request.trim() : '',
  };

  const systemParts = [sections.system];
  if (sections.longTerm) systemParts.push(`${LONG_TERM_HEADER}\n${sections.longTerm}`);
  if (sections.work) systemParts.push(`${WORK_HEADER}\n${sections.work}`);

  const messages = [{ role: 'system', content: systemParts.join('\n\n') }, ...sections.shortTerm];
  // An empty draft (the live preview before the user types) adds no turn.
  if (sections.request) messages.push({ role: 'user', content: sections.request });

  return { messages, sections };
}

export const LONG_TERM_HEADER = '## LONG-TERM MEMORY';
export const WORK_HEADER = '## WORK MEMORY';

/** Long-term memory as compact labelled lists. Returns '' when there is nothing. */
export function formatLongTermMemory(longTerm) {
  if (!longTerm) return '';
  const blocks = [];

  const profile = Object.entries(longTerm.profile ?? {});
  if (profile.length) {
    blocks.push(['Profile:', ...profile.map(([key, value]) => `- ${key.replace(/_/g, ' ')}: ${value}`)]);
  }
  if (longTerm.preferences?.length) {
    blocks.push(['Preferences:', ...longTerm.preferences.map((p) => `- ${p}`)]);
  }
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
