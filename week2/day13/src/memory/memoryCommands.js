/**
 * The explicit memory rules: lines in the user's message that save something.
 *
 * Only the user's own words are matched, line by line, so it is always obvious
 * why something was stored. Long-term memory is written by these rules and by
 * approved suggestions only — never by the conversation itself.
 *
 *   remember: …                     → long-term knowledge
 *   remember solution: …            → long-term solutions
 *   remember preference: …          → long-term profile notes
 *   requirement: … / decision: … / fact: …  → work memory of the current task
 */
const LONG_TERM_RULES = [
  { pattern: /^remember\s+(?:solution|fix|procedure)s?\s*:\s*(.+)$/i, category: 'solutions' },
  { pattern: /^remember\s+(?:preference|profile|about me)s?\s*:\s*(.+)$/i, category: 'profile' },
  { pattern: /^remember(?:\s+(?:knowledge|fact|this))?\s*:\s*(.+)$/i, category: 'knowledge' },
];

const WORK_RULES = [
  { pattern: /^(?:requirement|req)\s*:\s*(.+)$/i, field: 'requirements' },
  { pattern: /^decision\s*:\s*(.+)$/i, field: 'decisions' },
  { pattern: /^fact\s*:\s*(.+)$/i, field: 'facts' },
];

/**
 * @param {string} message
 * @returns {{longTerm: Array<{category: string, content: string}>, work: Record<string, string[]>}}
 */
export function extractMemoryCommands(message) {
  const longTerm = [];
  const work = {};
  for (const raw of String(message ?? '').split('\n')) {
    const line = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    if (!line) continue;
    const lt = LONG_TERM_RULES.find(({ pattern }) => pattern.test(line));
    if (lt) {
      longTerm.push({ category: lt.category, content: line.match(lt.pattern)[1].trim() });
      continue;
    }
    const wk = WORK_RULES.find(({ pattern }) => pattern.test(line));
    if (wk) (work[wk.field] ??= []).push(line.match(wk.pattern)[1].trim());
  }
  return { longTerm, work };
}
