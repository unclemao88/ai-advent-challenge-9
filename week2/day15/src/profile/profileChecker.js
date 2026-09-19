import { hasProfileContent } from './profileManager.js';

/**
 * Checks a response against the user profile before the user sees it.
 *
 * The profile is free text, so only rules that can be read reliably are
 * enforced here; everything else is left to the model, which gets the profile
 * in every request. Recognised rules (in Format or Limitations, any case):
 *
 *   length      "max 150 words", "at most 100 words", "under 200 words", "no more than 80 words"
 *   code        "no code", "without code", "no code blocks"
 *   markdown    "plain text", "no markdown"
 *   emoji       "no emoji(s)"
 *   lists       "bullet points", "bulleted list" (Format) → at least one list item
 *   table       "as a table", "table format" (Format)      → a Markdown table
 *   language    "English only", "in English", "in Russian", "на русском"
 *
 * A violation is not accepted silently: the step asks the model once for a
 * corrected response, and if that still violates the profile, the answer is
 * shown with the issues listed under it.
 */
export class ProfileChecker {
  /**
   * @param {object|null} profile
   * @param {string} response
   * @returns {{ok: boolean, issues: Array<{rule: string, message: string}>, rules: string[]}}
   */
  check(profile, response) {
    if (!hasProfileContent(profile)) return { ok: true, issues: [], rules: [] };
    const rules = parseProfileRules(profile);
    const text = String(response ?? '');
    const issues = [];

    if (rules.maxWords) {
      const words = countWords(text);
      if (words > rules.maxWords) {
        issues.push({ rule: 'length', message: `The response has ${words} words; the profile allows at most ${rules.maxWords}.` });
      }
    }
    if (rules.noCode && /```|^( {4}|\t)\S/m.test(text)) {
      issues.push({ rule: 'code', message: 'The response contains code, but the profile says "no code".' });
    }
    if (rules.plainText && hasMarkdown(text)) {
      issues.push({ rule: 'markdown', message: 'The response uses Markdown formatting, but the profile asks for plain text.' });
    }
    if (rules.noEmoji && /\p{Extended_Pictographic}/u.test(text)) {
      issues.push({ rule: 'emoji', message: 'The response contains emoji, but the profile says "no emoji".' });
    }
    if (rules.bullets && !/^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(text)) {
      issues.push({ rule: 'lists', message: 'The profile asks for bullet points, but the response has no list.' });
    }
    if (rules.table && !/^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m.test(text)) {
      issues.push({ rule: 'table', message: 'The profile asks for a table, but the response has none.' });
    }
    if (rules.language === 'english' && letterShare(text, /[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿]/gu) > 0.2) {
      issues.push({ rule: 'language', message: 'The profile asks for English, but the response is mostly in another script.' });
    }
    if (rules.language === 'russian' && letterShare(text, /[Ѐ-ӿ]/gu) < 0.3) {
      issues.push({ rule: 'language', message: 'The profile asks for Russian, but the response is not in Russian.' });
    }
    return { ok: issues.length === 0, issues, rules: Object.keys(rules).filter((k) => rules[k]) };
  }
}

/** The rules this checker understands, read from the profile's format and limitations (and style). */
export function parseProfileRules(profile) {
  const text = [profile?.format, profile?.limitations, profile?.style].filter(Boolean).join('\n').toLowerCase();
  const rules = {};
  const words = text.match(/(?:max(?:imum)?|at most|no more than|not more than|under|up to|less than|fewer than|limit(?:ed)? to|≤)\s*(\d{1,5})\s*words?\b/)
    ?? text.match(/\b(\d{1,5})\s*words?\s*(?:max(?:imum)?|or (?:less|fewer)|at most)\b/);
  if (words) rules.maxWords = Number(words[1]);
  if (/\b(?:no|without|never (?:include|use|write))\s+(?:any\s+)?(?:source\s+)?code(?:\s*(?:blocks?|snippets?|samples?|examples?))?\b/.test(text)) rules.noCode = true;
  if (/\bplain[- ]text\b|\bno markdown\b|\bwithout markdown\b/.test(text)) rules.plainText = true;
  if (/\b(?:no|without)\s+emoj(?:i|is)\b/.test(text)) rules.noEmoji = true;
  // Layout requirements come from the Format field only: a style remark such as
  // "tables are fine" must not force a table into every answer.
  const format = String(profile?.format ?? '').toLowerCase();
  if (/\bbullet(?:ed)?[- ](?:points?|list)\b|\bbullets\b/.test(format) && !/\bno bullet/.test(format)) rules.bullets = true;
  if (/\b(?:as|in) an? (?:markdown )?table\b|\btable format\b|\btables? only\b/.test(format)) rules.table = true;
  if (/\benglish(?: only)?\b/.test(text)) rules.language = 'english';
  if (/\b(?:in )?russian\b|на русском|по-русски/.test(text)) rules.language = 'russian';
  return rules;
}

export function countWords(text) {
  return (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
}

function hasMarkdown(text) {
  return /```|^\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*|__[^_\n]+__|^\s*\|.*\|\s*$|\[[^\]\n]+\]\([^)\s]+\)/m.test(text);
}

function letterShare(text, pattern) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (!letters) return 0;
  return (text.match(pattern) ?? []).length / letters;
}

/** Issues as the note that asks the model for a corrected response. */
export function describeProfileIssues(issues) {
  return issues.map((i) => `- ${i.message}`).join('\n');
}
