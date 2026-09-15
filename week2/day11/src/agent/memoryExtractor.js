/**
 * Decides what an exchange adds to work and long-term memory.
 *
 * Deliberately simple and transparent: a fixed set of rules over the user's own
 * words, applied line by line. Nothing the model says is saved on its own, and
 * nothing is saved unless a rule below matches, so the user always knows why
 * something was remembered — the UI reports every update it made.
 *
 * The agent depends only on the function's shape,
 *   ({ userMessage, assistantMessage, previousExchange }) => { work, longTerm }
 * so an LLM-based extractor can replace this module later without touching it.
 */

/** Explicit "field: value" commands for work memory. */
const WORK_RULES = [
  { pattern: /^task:\s*(.+)$/i, field: 'task' },
  { pattern: /^(?:state|status):\s*(.+)$/i, field: 'currentState' },
  { pattern: /^(?:requirement|req):\s*(.+)$/i, field: 'requirements' },
  { pattern: /^constraint:\s*(.+)$/i, field: 'constraints' },
  { pattern: /^decision:\s*(.+)$/i, field: 'decisions' },
  { pattern: /^we decided (?:to |that )?(.+)$/i, field: 'decisions' },
  { pattern: /^result:\s*(.+)$/i, field: 'results' },
  { pattern: /^todo:\s*(.+)$/i, field: 'todos' },
  { pattern: /^(?:file|entity):\s*(.+)$/i, field: 'entities' },
];

/** Stable facts for long-term memory. Each returns an update or null. */
const LONG_TERM_RULES = [
  {
    // "call me" only at the start of a line: "can you call me back" is not a name.
    pattern: /(?:\bmy name is|^(?:please\s+)?call me)\s+(.+)$/i,
    build: (m) => profile('name', personName(m[1])),
  },
  {
    pattern: /^my (role|job|location|city|country|time ?zone|preferred language) is\s+(.+)$/i,
    build: (m) => profile(m[1].toLowerCase().replace(/\s+/g, '_').replace('time_zone', 'timezone'), m[2]),
  },
  { pattern: /^i live in\s+(.+)$/i, build: (m) => profile('location', m[1]) },
  { pattern: /^(?:preference:\s*|i prefer\s+)(.+)$/i, build: (m) => ({ category: 'preferences', value: sentence(m[1]) }) },
  {
    pattern: /^remember(?: about ([^:]{1,60}))?:\s*(.+)$/i,
    build: (m) => ({ category: 'knowledge', topic: m[1]?.trim() || 'general', fact: sentence(m[2]) }),
  },
  { pattern: /^remember that\s+(.+)$/i, build: (m) => ({ category: 'knowledge', topic: 'general', fact: sentence(m[1]) }) },
  {
    pattern: /^solution:\s*(.+?)\s*(?:=>|->)\s*(.+)$/i,
    build: (m) => ({ category: 'solutions', problem: sentence(m[1]), solution: sentence(m[2]) }),
  },
];

/**
 * "That worked" after an answer files the previous question and answer as a
 * solved problem — the one rule that looks back at the conversation.
 */
const SOLVED = /^(?:(?:that|this|it)\s+(?:worked|solved it|fixed it|helped)|solved|save (?:this|that) solution)\b/i;

const MAX_SAVED_ANSWER_CHARS = 1500;

/**
 * @param {{userMessage: string, assistantMessage?: string,
 *          previousExchange?: {question: string, answer: string} | null}} exchange
 * @returns {{work: Array<{field: string, value: string}>, longTerm: object[]}}
 */
export function extractMemoryUpdates({ userMessage, previousExchange = null }) {
  const work = [];
  const longTerm = [];

  for (const line of String(userMessage ?? '').split(/\r?\n/).map(stripListMarker).filter(Boolean)) {
    for (const { pattern, field } of WORK_RULES) {
      const match = line.match(pattern);
      if (match) work.push({ field, value: sentence(match[1]) });
    }
    for (const { pattern, build } of LONG_TERM_RULES) {
      const match = line.match(pattern);
      const update = match && build(match);
      if (update) longTerm.push(update);
    }
  }

  if (previousExchange && SOLVED.test(String(userMessage ?? '').trim())) {
    longTerm.push({
      category: 'solutions',
      problem: previousExchange.question,
      solution: truncate(previousExchange.answer, MAX_SAVED_ANSWER_CHARS),
    });
  }

  return { work, longTerm };
}

/** The last question/answer pair of a conversation, or null. */
export function lastExchange(messages) {
  for (let i = messages.length - 1; i > 0; i -= 1) {
    if (messages[i].role === 'assistant' && messages[i - 1].role === 'user') {
      return { question: messages[i - 1].content, answer: messages[i].content };
    }
  }
  return null;
}

function profile(key, value) {
  const text = sentence(value ?? '');
  return text ? { category: 'profile', key, value: text } : null;
}

/** "Max, and I like tea" → "Max". Names stop at punctuation or a joining word. */
function personName(text) {
  const words = text.split(/[.,!?;:()]/)[0].trim().split(/\s+/);
  const stop = words.findIndex((w, i) => i > 0 && /^(and|but|i|i'm|im|from|who|here|btw)$/i.test(w));
  return words.slice(0, stop === -1 ? 3 : Math.min(stop, 3)).join(' ');
}

function stripListMarker(line) {
  return line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
}

/** Trim and drop one trailing full stop, so "Use Express." and "Use Express" dedupe. */
function sentence(text) {
  return String(text).trim().replace(/\.$/, '').trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
