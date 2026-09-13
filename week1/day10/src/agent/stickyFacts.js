'use strict';

const schema = require('../storage/schema');

/**
 * Sticky facts: context = structured key-value facts + the latest N messages.
 *
 * Messages that fall out of the latest N are folded into the facts by
 * FactExtractor (a DeepSeek call that returns JSON). This module is the pure
 * part: which messages still need folding, what the model context contains,
 * and how a validated update is applied to the stored facts.
 *
 * Facts are kept per branch, so a fact learned in Branch A never leaks into
 * Branch B. A checkpoint copies the base facts into both branches; deleting it
 * makes the surviving branch's facts the main ones.
 */
class StickyFactsManager {
  /** The facts memory of one branch, created on first use. */
  memory(state, branchId) {
    const memories = state.contextManagement.stickyFacts.memories;
    if (!memories[branchId]) memories[branchId] = schema.emptyFactsMemory();
    return memories[branchId];
  }

  /**
   * How many leading messages of `path` the facts really cover. If the stored
   * boundary no longer lines up with the path (hand-edited file), assume
   * nothing is covered: the messages are then sent in full and re-extracted.
   */
  coverage(memory, path) {
    const covered = memory.messagesCovered;
    if (covered > path.length) return 0;
    if (covered > 0 && memory.coveredThroughId && path[covered - 1].id !== memory.coveredThroughId) return 0;
    return covered;
  }

  /**
   * The messages that must be folded into the facts so that
   * `facts + latest N` represents the whole path.
   * @returns {{from: number, to: number}|null} Half-open index range.
   */
  plan(path, memory, N) {
    const boundary = Math.max(0, path.length - N);
    const covered = this.coverage(memory, path);
    return covered < boundary ? { from: covered, to: boundary } : null;
  }

  /**
   * The model context. Normally the latest N messages; if extraction is behind
   * (it failed, or the mode was just switched on), the not-yet-covered older
   * messages are sent in full too, so nothing silently drops out of context.
   */
  select(path, N, memory) {
    const windowStart = Math.max(0, path.length - N);
    const start = Math.min(windowStart, this.coverage(memory, path));
    return {
      history: path.slice(start),
      excluded: path.slice(0, start),
      uncoveredIncluded: windowStart - start,
      facts: memory.facts
    };
  }

  /** Give each new branch its own copy of the base facts. */
  forkMemory(state, fromBranchId, toBranchIds) {
    const source = JSON.stringify(this.memory(state, fromBranchId));
    toBranchIds.forEach((id) => { state.contextManagement.stickyFacts.memories[id] = JSON.parse(source); });
  }

  /** After a checkpoint is deleted: the survivor's facts become the main facts. */
  adoptMemory(state, survivorBranchId, removedBranchIds) {
    const memories = state.contextManagement.stickyFacts.memories;
    memories[schema.MAIN_BRANCH] = this.memory(state, survivorBranchId);
    delete memories[survivorBranchId];
    removedBranchIds.forEach(function (id) { delete memories[id]; });
  }
}

/**
 * Parse and validate the model's fact update. Nothing from the model reaches
 * the state file without passing through here.
 *
 * Accepts {"factsToSet": {}, "factsToUpdate": {}, "factsToRemove": []}, bare or
 * inside a ```json fence. Keys are normalized to snake_case; values must be
 * scalars (a null value means "remove"). Unusable individual entries are
 * dropped; a response that is not such an object at all is rejected.
 *
 * @returns {{set: Object<string, string>, remove: string[]}}
 * @throws {Error} When the response is not a usable update.
 */
function parseExtraction(text) {
  if (typeof text !== 'string') throw new Error('Fact extraction returned no text.');
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence) body = fence[1];

  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new Error('Fact extraction did not return valid JSON.');
  }
  if (!schema.isObject(data)) throw new Error('Fact extraction did not return a JSON object.');

  const known = ['factsToSet', 'factsToUpdate', 'factsToRemove'];
  if (!Object.keys(data).some(function (k) { return known.indexOf(k) !== -1; })) {
    throw new Error('Fact extraction JSON has none of factsToSet, factsToUpdate, factsToRemove.');
  }

  const set = {};
  const remove = [];
  ['factsToSet', 'factsToUpdate'].forEach(function (field) {
    if (data[field] === undefined || data[field] === null) return;
    if (!schema.isObject(data[field])) throw new Error(field + ' must be an object.');
    Object.keys(data[field]).forEach(function (rawKey) {
      const key = normalizeFactKey(rawKey);
      if (!key) return;
      if (data[field][rawKey] === null) {
        remove.push(key);
        return;
      }
      const value = normalizeFactValue(data[field][rawKey]);
      if (value !== null) set[key] = value;
    });
  });

  if (data.factsToRemove !== undefined && data.factsToRemove !== null) {
    if (!Array.isArray(data.factsToRemove)) throw new Error('factsToRemove must be an array.');
    data.factsToRemove.forEach(function (rawKey) {
      const key = typeof rawKey === 'string' ? normalizeFactKey(rawKey) : null;
      if (key) remove.push(key);
    });
  }
  return { set: set, remove: remove };
}

/**
 * Apply a validated update. Newer values replace older ones; a key both set
 * and removed is set. Returns new objects and leaves `facts` untouched.
 *
 * @returns {{facts: object, changed: {set: string[], removed: string[]}}}
 */
function applyUpdate(facts, update, now) {
  const ts = (now || new Date()).toISOString();
  const next = JSON.parse(JSON.stringify(facts || {}));
  const changed = { set: [], removed: [] };

  update.remove.forEach(function (key) {
    if (next[key] && !Object.prototype.hasOwnProperty.call(update.set, key)) {
      delete next[key];
      changed.removed.push(key);
    }
  });
  Object.keys(update.set).forEach(function (key) {
    const value = update.set[key];
    if (next[key]) {
      if (next[key].value === value) return;
      next[key] = { value: value, createdAt: next[key].createdAt || ts, updatedAt: ts };
    } else {
      if (Object.keys(next).length >= schema.MAX_FACTS) return;
      next[key] = { value: value, createdAt: ts, updatedAt: ts };
    }
    changed.set.push(key);
  });
  return { facts: next, changed: changed };
}

/** "Preferred Language" → "preferred_language"; null if nothing usable is left. */
function normalizeFactKey(raw) {
  const key = String(raw).trim().toLowerCase()
    .replace(/[\s\-.\/]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return schema.FACT_KEY_RE.test(key) ? key : null;
}

function normalizeFactValue(raw) {
  let value;
  if (typeof raw === 'string') value = raw;
  else if (typeof raw === 'number' && isFinite(raw)) value = String(raw);
  else if (typeof raw === 'boolean') value = raw ? 'true' : 'false';
  else if (Array.isArray(raw) && raw.every(function (v) { return ['string', 'number', 'boolean'].indexOf(typeof v) !== -1; })) {
    value = raw.map(String).join(', ');
  } else {
    return null;
  }
  value = value.replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return value.length > schema.MAX_FACT_VALUE_CHARS ? value.slice(0, schema.MAX_FACT_VALUE_CHARS - 1) + '…' : value;
}

/** {key: {value, …}} → {key: value}, keys sorted. */
function plainFacts(facts) {
  const out = {};
  Object.keys(facts || {}).sort().forEach(function (key) { out[key] = facts[key].value; });
  return out;
}

module.exports = { StickyFactsManager, parseExtraction, applyUpdate, normalizeFactKey, normalizeFactValue, plainFacts };
