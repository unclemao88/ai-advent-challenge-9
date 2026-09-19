import { GROUP_LABELS, TECH_BY_ID, findTechMentions, techForFence } from '../invariants/techCatalog.js';
import { clip, isPlainObject } from '../utils/validate.js';
import { CATEGORY_LABELS } from '../invariants/invariantManager.js';

/**
 * Checks requests, plans and answers against the active invariants.
 *
 * Two independent layers, merged by the agent:
 *
 *  1. Rules (this class, deterministic, no API call):
 *     - Technology rules. An invariant that names technologies ("Node.js +
 *       Express", "PostgreSQL only") restricts their groups: a text that
 *       *adopts* another technology of the same group (Python, Django,
 *       MongoDB) conflicts. "No MongoDB" / "never PHP" in an invariant makes
 *       that technology forbidden instead. A framework counts as its language
 *       (Django → Python). In an answer, a code block tagged with another
 *       language (```python) is a violation.
 *     - Prohibitions. "Never store full credit card numbers" in an invariant
 *       forbids a sentence that stores card numbers (all significant words of
 *       the phrase, loosely stemmed, in one sentence that is not negated).
 *       This is how business rules are checked without an API call.
 *     - Forbidden terms. Each invariant may list terms whose appearance
 *       violates it, for rules none of the above can read.
 *     A mention only counts when the sentence adopts the technology — a change
 *     verb (rewrite, migrate, use, implement…) or "in/with/using X" — and it is
 *     not negated ("instead of X", "without X", "from X"). Questions that only
 *     compare or explain ("what is X", "X vs Y") are not conflicts.
 *
 *  2. The model. The prompt shows every active invariant and makes the model
 *     report conflicts it sees (`invariantConflicts`); `fromModel()` validates
 *     those reports. This covers rules no keyword can capture.
 *
 * Every conflict names the invariant, the stage, the evidence and the method,
 * so the user can see exactly why the agent stopped.
 */
export class InvariantChecker {
  /**
   * @param {{type: 'request'|'plan'|'response', text: string}} action
   * @param {object[]} invariants All invariants; disabled ones are ignored.
   * @returns {{ok: boolean, stage: string, conflicts: object[]}}
   */
  check(action, invariants) {
    const stage = action?.type ?? 'request';
    const text = String(action?.text ?? '');
    const conflicts = [];
    for (const invariant of (invariants ?? []).filter((inv) => inv.enabled)) {
      conflicts.push(...this.#checkOne(invariant, text, stage));
    }
    return { ok: conflicts.length === 0, stage, conflicts: dedupe(conflicts) };
  }

  /**
   * @param {{steps?: string[], text?: string}|string[]|string} plan
   */
  checkPlan(plan, invariants) {
    const text = typeof plan === 'string' ? plan
      : Array.isArray(plan) ? plan.join('\n')
        : [...(plan?.steps ?? []), plan?.text ?? ''].join('\n');
    return this.check({ type: 'plan', text }, invariants);
  }

  checkResponse(response, invariants) {
    return this.check({ type: 'response', text: response }, invariants);
  }

  /**
   * Validate conflicts the model reported: only enabled invariants that exist
   * count; the reason is clipped.
   */
  fromModel(reported, invariants, stage) {
    if (!Array.isArray(reported)) return [];
    const byId = new Map((invariants ?? []).filter((inv) => inv.enabled).map((inv) => [inv.id, inv]));
    const out = [];
    for (const item of reported.slice(0, 10)) {
      if (!isPlainObject(item)) continue;
      const invariant = byId.get(item.invariantId) ?? byName(byId, item.invariantId);
      if (!invariant) continue;
      out.push(conflictOf(invariant, {
        stage, method: 'model', reason: clip(String(item.reason ?? ''), 400) || 'The agent reported a conflict with this invariant.', evidence: null,
      }));
    }
    return dedupe(out);
  }

  #checkOne(invariant, text, stage) {
    const out = [];
    const rule = parseRule(invariant);

    // Technology rules.
    for (const found of adoptedTechnologies(text, stage)) {
      const { tech } = found;
      const langOf = tech.implies ? TECH_BY_ID.get(tech.implies) : null;

      if (rule.forbidden.has(tech.id) || (langOf && rule.forbidden.has(langOf.id))) {
        const banned = rule.forbidden.has(tech.id) ? tech : langOf;
        out.push(conflictOf(invariant, {
          stage, method: 'rule', evidence: found.evidence,
          reason: `${describe(stage)} ${verb(found)} ${tech.label}, which the invariant forbids (${banned.label}).`,
        }));
        continue;
      }
      const allowedHere = rule.allowed.get(tech.group);
      if (allowedHere && !allowedHere.has(tech.id)) {
        out.push(conflictOf(invariant, {
          stage, method: 'rule', evidence: found.evidence,
          reason: `${describe(stage)} ${verb(found)} ${tech.label}, but the invariant requires ${labels(allowedHere)} as the ${GROUP_LABELS[tech.group]}.`,
        }));
        continue;
      }
      if (langOf) {
        const allowedLang = rule.allowed.get('language');
        if (allowedLang && !allowedLang.has(langOf.id)) {
          out.push(conflictOf(invariant, {
            stage, method: 'rule', evidence: found.evidence,
            reason: `${describe(stage)} ${verb(found)} ${tech.label} (${langOf.label}), but the invariant requires ${labels(allowedLang)}.`,
          }));
        }
      }
    }

    // Prohibitions stated in the rule ("never …", "must not …").
    for (const prohibition of parseProhibitions(invariant.value)) {
      const hit = findProhibited(text, prohibition);
      if (!hit) continue;
      out.push(conflictOf(invariant, {
        stage, method: 'rule', evidence: hit,
        reason: `${describe(stage)} would ${prohibition.phrase}, which the ${CATEGORY_LABELS[invariant.category]?.toLowerCase() ?? 'invariant'} forbids.`,
      }));
    }

    // Forbidden terms.
    const lower = text.toLowerCase();
    for (const term of invariant.forbidden ?? []) {
      const needle = term.toLowerCase();
      let from = 0;
      for (;;) {
        const index = lower.indexOf(needle, from);
        if (index === -1) break;
        from = index + needle.length;
        if (isNegated(text, index)) continue;
        out.push(conflictOf(invariant, {
          stage, method: 'rule', evidence: excerpt(text, index, needle.length),
          reason: `${describe(stage)} contains "${term}", which the invariant forbids.`,
        }));
        break;
      }
    }
    return out;
  }
}

// --- Rule parsing -------------------------------------------------------------------

// A real negation may stand a few words before the technology ("do not split it into microservices");
// "from", "than" and "vs" only count right before it ("away from Python", but not "from X to MongoDB").
const NEGATION_BEFORE = /\b(?:no|not|never|without|avoid|avoiding|forbid|forbidden|ban|banned|don't|do not|must not|instead of|rather than|except|other than)\s+(?:[\w.+#-]+\s+){0,3}$/i;
const CONTRAST_BEFORE = /\b(?:away from|from|than|vs\.?|versus)\s+(?:the\s+|a\s+|an\s+)?$/i;
const NEGATION_AFTER = /^[\w.+#-]*\s+(?:is|are)\s+(?:not allowed|forbidden|banned|prohibited)\b/i;

/**
 * What an invariant allows and forbids, from the technologies in its name and value.
 * @returns {{allowed: Map<string, Set<string>>, forbidden: Set<string>}}
 */
export function parseRule(invariant) {
  const text = `${invariant.value}`;
  const allowed = new Map();
  const forbidden = new Set();
  for (const mention of findTechMentions(text)) {
    const { tech } = mention;
    const after = text.slice(mention.index);
    if (isNegated(text, mention.index) || NEGATION_AFTER.test(after)) {
      forbidden.add(tech.id);
      continue;
    }
    if (!allowed.has(tech.group)) allowed.set(tech.group, new Set());
    allowed.get(tech.group).add(tech.id);
    // "Express" implies Node.js: the language is then fixed as well.
    if (tech.implies) {
      if (!allowed.has('language')) allowed.set('language', new Set());
      allowed.get('language').add(tech.implies);
    }
  }
  return { allowed, forbidden };
}

// --- Prohibitions ---------------------------------------------------------------------

const PROHIBITION = /\b(?:never|must not|must never|mustn't|do not|don't|does not|doesn't|shall not|may not|cannot|can't|is not allowed to|are not allowed to|is forbidden to|are forbidden to|forbidden to)\s+(?:be\s+|ever\s+)?([^.;:!?\n]+)/gi;
const PHRASE_STOP = new Set([
  'the', 'a', 'an', 'any', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'into', 'our', 'their',
  'its', 'be', 'been', 'is', 'are', 'was', 'ever', 'all', 'this', 'that', 'these', 'those', 'it', 'them', 'we', 'you',
]);
const SENTENCE_NEGATION = /\b(?:not|never|no|without|avoid|avoids|avoiding|don't|doesn't|mustn't|cannot|can't|instead of|rather than|prohibited|forbidden|disallowed)\b/i;

// Verbs that mean the same for a prohibition: "save"/"persist" a value is "storing" it.
const SYNONYMS = { save: 'stor', pers: 'stor', dele: 'remo', drop: 'remo', eras: 'remo', shar: 'expo', leak: 'expo', disc: 'expo' };

/** Stems of the significant words: "storing credit cards" → stor, cred, card. */
function stems(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [])
    .filter((w) => w.length >= 3 && !PHRASE_STOP.has(w))
    .map((w) => (w.length > 4 ? w.slice(0, 4) : w))
    .map((stem) => SYNONYMS[stem] ?? stem);
}

/**
 * What an invariant's own text prohibits: "Never store full credit card numbers."
 * → {phrase: "store full credit card numbers", stems: [stor, full, cred, card, numb]}.
 */
export function parseProhibitions(value) {
  const out = [];
  for (const m of String(value ?? '').matchAll(PROHIBITION)) {
    const phrase = m[1].split(/\s+(?:and|but|unless|except|because|so)\s+|,/i)[0].trim().split(/\s+/).slice(0, 8).join(' ');
    const phraseStems = [...new Set(stems(phrase))];
    if (phraseStems.length >= 2) out.push({ phrase, stems: phraseStems });
  }
  return out;
}

/**
 * The first sentence of `text` that does what `prohibition` forbids: it
 * contains (nearly) all of the phrase's stems and is not itself a negation
 * ("we never store card numbers" is compliant).
 * @returns {string|null} The offending sentence, shortened.
 */
export function findProhibited(text, prohibition) {
  const prose = String(text ?? '').replace(/```[\s\S]*?(?:```|$)/g, (block) => block.replace(/[.!?;]/g, ' '));
  const needed = prohibition.stems.length <= 3 ? prohibition.stems.length : Math.ceil(prohibition.stems.length * 0.75);
  for (const sentence of prose.split(/[.!?;\n]+/)) {
    const words = new Set(stems(sentence));
    const hits = prohibition.stems.filter((s) => words.has(s)).length;
    if (hits >= needed && !SENTENCE_NEGATION.test(sentence)) return clip(sentence.replace(/\s+/g, ' '), 160);
  }
  return null;
}

// --- Mentions that adopt a technology -----------------------------------------------

const CHANGE_VERBS = /\b(?:rewrite|rewriting|re-?write|re-?implement|reimplement|migrate|migrating|migration|switch|switching|port|porting|convert|converting|move|moving|use|using|uses|implement|implementing|implementation|build|building|write|writing|written|create|creating|add|adding|develop|developing|redo|change|changing|translate|adopt|adopting|introduce|introducing|install|set up|setup|deploy|replace|replacing|based on|powered by|run on|built (?:with|in|on))\b/i;
const ADOPTING_PREPOSITION = /\b(?:in|into|to|with|using|via|on)\s+(?:the\s+|a\s+)?$/i;
const INFORMATIONAL = /\b(?:what is|what's|what are|explain|compare|comparison|difference|differences|versus|vs\.?|pros and cons|history of|tell me about)\b/i;

/**
 * Technologies the text adopts. In an answer, code blocks count too.
 * @returns {Array<{tech: object, evidence: string, via: 'text'|'code'}>}
 */
export function adoptedTechnologies(text, stage) {
  const found = [];
  const source = String(text ?? '');

  if (stage !== 'request') {
    for (const m of source.matchAll(/```[ \t]*([\w+#-]+)/g)) {
      const tech = techForFence(m[1]);
      if (tech) found.push({ tech, evidence: excerpt(source, m.index, m[0].length), via: 'code' });
    }
  }

  // Code blocks are judged by their tag only; their content is not prose.
  const prose = source.replace(/```[\s\S]*?(?:```|$)/g, (block) => ' '.repeat(block.length));
  for (const mention of findTechMentions(prose)) {
    const sentence = sentenceAround(prose, mention.index);
    const before = prose.slice(sentence.start, mention.index);
    if (isNegated(prose, mention.index)) continue;
    if (INFORMATIONAL.test(sentence.text) && !/\b(?:rewrite|migrate|switch|port|convert|implement)\b/i.test(sentence.text)) continue;
    if (!CHANGE_VERBS.test(sentence.text) && !ADOPTING_PREPOSITION.test(before)) continue;
    found.push({ tech: mention.tech, evidence: excerpt(prose, mention.index, mention.match.length), via: 'text' });
  }
  return found;
}

function isNegated(text, index) {
  const sentence = sentenceAround(text, index);
  const before = text.slice(Math.max(sentence.start, index - 60), index);
  return NEGATION_BEFORE.test(before) || CONTRAST_BEFORE.test(before);
}

function sentenceAround(text, index) {
  const boundary = /[.!?;\n](?:\s|$)|\n/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    if (m.index < index) start = m.index + m[0].length;
    else {
      end = m.index;
      break;
    }
  }
  return { start, end, text: text.slice(start, end) };
}

// --- Helpers ----------------------------------------------------------------------

function conflictOf(invariant, { stage, method, reason, evidence }) {
  return {
    invariantId: invariant.id,
    name: invariant.name,
    value: invariant.value,
    category: invariant.category,
    stage,
    method,
    reason,
    evidence,
  };
}

function dedupe(conflicts) {
  const seen = new Set();
  return conflicts.filter((c) => {
    const key = `${c.invariantId}|${c.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function byName(map, name) {
  if (typeof name !== 'string') return null;
  const wanted = name.trim().toLowerCase();
  return [...map.values()].find((inv) => inv.name.toLowerCase() === wanted) ?? null;
}

function describe(stage) {
  return { request: 'The request', plan: 'The plan', response: 'The result', validation: 'The result' }[stage] ?? 'The text';
}

function verb(found) {
  return found.via === 'code' ? 'contains code in' : 'uses';
}

function labels(ids) {
  return [...ids].map((id) => TECH_BY_ID.get(id)?.label ?? id).join(' / ');
}

function excerpt(text, index, length) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
