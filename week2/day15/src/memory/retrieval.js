/**
 * Chooses which long-term entries go into a request.
 *
 * The first implementation is deterministic keyword relevance, so every choice
 * can be explained ("matched: nginx, #deploy"):
 *
 *   explicit reference   the query names the entry id (ltm_…) or one of its tags as #tag   +10
 *   tag match            a query term equals a tag                                         +3
 *   content match        a query term appears as a word of the entry                        +2
 *   partial match        a word starts with the term (or the reverse, 4+ letters)          +1
 *   recency              updated in the last 7 days (only breaks ties between matches)     +0.5
 *   pinned               always included, before anything else
 *
 * Entries with no match are left out: long-term memory is never sent blindly.
 * The result then fits a token budget, highest score first.
 *
 * A semantic retriever (embeddings + vector search) implements the same
 * `select()` signature and is passed to the MemoryManager instead.
 */
export class KeywordRetriever {
  constructor({ minScore = 2 } = {}) {
    this.minScore = minScore;
    this.name = 'keyword';
  }

  /**
   * @param {Array<{id: string, content: string, tags: string[], pinned?: boolean, updatedAt?: string, category: string}>} items
   * @param {string} query
   * @param {{budgetTokens: number, cost: (item: object) => number, now?: Date}} options
   * @returns {{items: Array<object & {score: number, reasons: string[]}>, considered: number}}
   */
  select(items, query, { budgetTokens, cost, now = new Date() }) {
    const scored = items
      .map((item) => scoreItem(item, query, now))
      .filter((item) => item.pinned || item.score >= this.minScore)
      .sort((a, b) => (b.pinned - a.pinned) || (b.score - a.score) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

    const chosen = [];
    let used = 0;
    for (const item of scored) {
      const tokens = cost(item);
      if (used + tokens > budgetTokens) continue;
      chosen.push(item);
      used += tokens;
    }
    return { items: chosen, considered: items.length, usedTokens: used };
  }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'how', 'what', 'do', 'i', 'my', 'me',
  'with', 'can', 'you', 'this', 'that', 'be', 'are', 'please', 'should', 'would', 'will', 'use', 'make', 'from',
]);

export function words(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.+#-]*/gu)?.map((w) => w.replace(/[.-]+$/, '')) ?? [];
}

export function queryTerms(query) {
  return [...new Set(words(query).filter((w) => w.length > 1 && !STOP_WORDS.has(w)))];
}

export function scoreItem(item, query, now = new Date()) {
  const text = String(query ?? '');
  const lower = text.toLowerCase();
  const terms = queryTerms(text);
  const content = words(item.content);
  const tags = (item.tags ?? []).map((t) => t.toLowerCase());
  const reasons = [];
  let score = 0;

  if (lower.includes(item.id.toLowerCase())) {
    score += 10;
    reasons.push('referenced by id');
  }
  for (const tag of tags) {
    if (new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?![\\p{L}\\p{N}_-])`, 'u').test(lower)) {
      score += 10;
      reasons.push(`#${tag}`);
    }
  }
  for (const term of terms) {
    if (tags.includes(term)) {
      score += 3;
      reasons.push(`tag ${term}`);
    }
    if (content.includes(term)) {
      score += 2;
      reasons.push(term);
    } else if (content.some((w) => (w.length > 3 && term.length > 3) && (w.startsWith(term) || term.startsWith(w)))) {
      score += 1;
      reasons.push(`~${term}`);
    }
  }
  if (score > 0 && item.updatedAt && now - new Date(item.updatedAt) < 7 * 24 * 3600 * 1000) score += 0.5;
  if (item.pinned) reasons.unshift('pinned');
  return { ...item, pinned: Boolean(item.pinned), score, reasons: [...new Set(reasons)] };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
