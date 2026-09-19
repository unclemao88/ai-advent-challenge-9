import { STATES, WORK_STATES } from './stateMachine.js';
import { isCategory } from '../memory/longTermMemory.js';
import { clip, isPlainObject } from '../utils/validate.js';

const SUGGESTABLE = new Set([...WORK_STATES, STATES.DONE]);
const MAX_RESPONSE_CHARS = 60_000;

/**
 * Turn the model's reply into a trusted, bounded structure.
 *
 * The reply should be the JSON object described in prompts.js. Anything else
 * (prose, a fenced block, JSON with missing or wrongly typed fields) is handled
 * without failing the step: the text becomes the response and the state
 * machine falls back to its default transition. `structured` tells whether the
 * JSON contract was met; it is logged.
 *
 * @param {string} content
 * @param {string} state The state that was performed.
 */
export function parseAgentReply(content, state) {
  const raw = String(content ?? '').trim();
  const json = parseJsonObject(raw);

  if (!json) {
    return {
      structured: false,
      response: clip(raw, MAX_RESPONSE_CHARS) || 'The agent returned no text for this step.',
      suggestedNext: null,
      plannedAction: null,
      needsUserInput: false,
      invariantConflicts: [],
      validation: state === STATES.VALIDATION ? inferVerdict(raw) : null,
      workMemory: {},
      memoryProposals: [],
    };
  }

  const response = typeof json.response === 'string' && json.response.trim()
    ? clip(json.response, MAX_RESPONSE_CHARS)
    : clip(typeof json.validation?.summary === 'string' && json.validation.summary.trim()
      ? json.validation.summary : 'The agent returned no text for this step.', MAX_RESPONSE_CHARS);

  let validation = null;
  if (state === STATES.VALIDATION) {
    validation = isPlainObject(json.validation) && typeof json.validation.passed === 'boolean'
      ? {
        passed: json.validation.passed,
        summary: clip(json.validation.summary, 1000),
        issues: stringList(json.validation.issues, 500, 10) ?? [],
      }
      : inferVerdict(response);
  }

  return {
    structured: true,
    response,
    suggestedNext: SUGGESTABLE.has(json.nextState) ? json.nextState : null,
    plannedAction: clip(json.plannedAction, 300) || null,
    needsUserInput: json.needsUserInput === true,
    invariantConflicts: sanitizeConflicts(json.invariantConflicts),
    validation,
    workMemory: sanitizeWorkMemory(json.workMemory),
    memoryProposals: sanitizeProposals(json.memoryProposals),
  };
}

function parseJsonObject(text) {
  const candidates = [text];
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first > 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (isPlainObject(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Without a structured verdict, only an explicit statement counts; otherwise unknown. */
function inferVerdict(text) {
  if (/\b(validation|check)\s+(failed|did not pass)\b|\bFAILED\b/.test(text)) return { passed: false, summary: '', issues: [] };
  if (/\b(validation|check)\s+passed\b|\bPASSED\b/.test(text)) return { passed: true, summary: '', issues: [] };
  return null;
}

function stringList(value, max, count) {
  if (!Array.isArray(value)) return undefined;
  const list = value.map((item) => clip(typeof item === 'string' ? item : '', max)).filter(Boolean).slice(0, count);
  return list.length ? list : undefined;
}

function sanitizeConflicts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => isPlainObject(c) && typeof c.invariantId === 'string' && c.invariantId.trim())
    .slice(0, 10)
    .map((c) => ({ invariantId: clip(c.invariantId, 64), reason: clip(typeof c.reason === 'string' ? c.reason : '', 400) }));
}

function sanitizeWorkMemory(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  if (typeof value.objective === 'string' && value.objective.trim()) out.objective = clip(value.objective, 1000);
  const plan = stringList(value.plan, 500, 20);
  if (plan) out.plan = plan;
  for (const field of ['requirements', 'decisions', 'facts']) {
    const list = stringList(value[field], 1000, 15);
    if (list) out[field] = list;
  }
  const result = clip(typeof value.result === 'string' ? value.result : '', 1000);
  if (result) out.result = result;
  if (isPlainObject(value.variables)) {
    const vars = Object.entries(value.variables)
      .filter(([k, v]) => k.trim() && ['string', 'number', 'boolean'].includes(typeof v))
      .slice(0, 15)
      .map(([k, v]) => [clip(k, 60), clip(String(v), 500)]);
    if (vars.length) out.variables = Object.fromEntries(vars);
  }
  return out;
}

function sanitizeProposals(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => isPlainObject(p) && isCategory(p.category) && typeof p.content === 'string' && p.content.trim())
    .slice(0, 2)
    .map((p) => ({ category: p.category, content: clip(p.content, 500) }));
}
