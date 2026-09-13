'use strict';

const crypto = require('crypto');
const tokenService = require('../shared/tokenService');

/**
 * The shape of state.json — the single file that holds everything needed to
 * restore the app: messages, the context-management mode and its settings,
 * sticky facts, the checkpoint and its branches, and token statistics.
 *
 * Everything read from disk goes through normalizeState(), so the rest of the
 * code can rely on this shape even if the file was hand-edited.
 */

const STATE_VERSION = 1;
const MAIN_BRANCH = 'main';

const MODES = [
  { id: 'sliding-window', label: 'Sliding window' },
  { id: 'sticky-facts', label: 'Sticky facts (Key-value memory)' },
  { id: 'branching', label: 'Branching' }
];
const MODE_IDS = MODES.map(function (m) { return m.id; });

const WINDOW_LIMITS = { min: 1, max: 500 };
const DEFAULT_SLIDING_N = 10;
const DEFAULT_STICKY_N = 5;

const FACT_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FACT_VALUE_CHARS = 500;
const MAX_FACTS = 200;

function defaultState(now) {
  const ts = (now || new Date()).toISOString();
  return {
    version: STATE_VERSION,
    createdAt: ts,
    updatedAt: ts,
    settings: { model: null },
    contextManagement: {
      mode: 'sliding-window',
      slidingWindow: { N: DEFAULT_SLIDING_N },
      stickyFacts: { N: DEFAULT_STICKY_N, memories: { main: emptyFactsMemory() } },
      branching: { checkpoint: null, activeBranchId: MAIN_BRANCH, branches: [mainBranch(ts)] }
    },
    messages: [],
    // Entries that could not be used (hand-edited, orphaned). Kept, never shown.
    quarantinedMessages: [],
    statistics: emptyStatistics(),
    lastTurn: null
  };
}

function mainBranch(ts) {
  return { id: MAIN_BRANCH, name: 'Main', parentId: null, createdAt: ts };
}

/**
 * Facts for one branch. `messagesCovered` counts messages from the start of
 * that branch's path (base + branch) that have been folded into the facts;
 * `coveredThroughId` is the id of the last one, to detect a changed history.
 */
function emptyFactsMemory() {
  return { facts: {}, messagesCovered: 0, coveredThroughId: null, updatedAt: null, lastError: null };
}

function emptyStatistics() {
  return {
    messageCount: 0,
    requestCount: 0,
    responseCount: 0,
    totalRequestTokens: 0,
    totalResponseTokens: 0,
    totalTokens: 0,
    estimated: false,
    api: emptyApiUsage()
  };
}

/** Cumulative DeepSeek consumption. Never decreases, even when a branch is deleted. */
function emptyApiUsage() {
  return { calls: 0, answerCalls: 0, factExtractionCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false };
}

/**
 * Build a stored message. Id and timestamp are generated here — never taken
 * from a request body.
 *
 * @param {{type: 'request'|'response', content: string, branchId: string,
 *          tokens?: number|null, tokensSource?: 'api'|'estimate', timestamp?: Date, extra?: object}} fields
 */
function createMessage(fields) {
  if (fields.type !== 'request' && fields.type !== 'response') throw new Error('Unknown message type: ' + fields.type);
  const content = String(fields.content);
  const exact = isNonNegativeInt(fields.tokens);
  return Object.assign({
    id: newId(),
    timestamp: (fields.timestamp || new Date()).toISOString(),
    type: fields.type,
    branchId: fields.branchId || MAIN_BRANCH,
    content: content,
    tokens: exact ? fields.tokens : tokenService.count(content),
    tokensSource: exact && fields.tokensSource === 'api' ? 'api' : 'estimate'
  }, fields.extra || {});
}

/** @returns {number|null} The window size, or null when the value is not acceptable. */
function parseWindowSize(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= WINDOW_LIMITS.min && n <= WINDOW_LIMITS.max ? n : null;
}

/**
 * Validate and repair a parsed state.json.
 *
 * @returns {{state: object, repairs: string[]}} `repairs` describes anything
 *          that had to be changed; empty for a file this version wrote.
 * @throws {Error} When the data is not a state object at all.
 */
function normalizeState(raw) {
  if (!isObject(raw) || !Array.isArray(raw.messages)) {
    throw new Error('state.json has no "messages" array');
  }
  const repairs = [];
  const base = defaultState();
  const cmRaw = isObject(raw.contextManagement) ? raw.contextManagement : {};

  const state = {
    version: STATE_VERSION,
    createdAt: isoOr(raw.createdAt, base.createdAt),
    updatedAt: isoOr(raw.updatedAt, base.updatedAt),
    settings: { model: isObject(raw.settings) && typeof raw.settings.model === 'string' ? raw.settings.model : null },
    contextManagement: null,
    messages: [],
    quarantinedMessages: Array.isArray(raw.quarantinedMessages) ? raw.quarantinedMessages.slice() : [],
    statistics: null,
    lastTurn: isObject(raw.lastTurn) ? raw.lastTurn : null
  };

  // Messages -----------------------------------------------------------------
  const seen = {};
  raw.messages.forEach(function (m) {
    const message = normalizeMessage(m);
    if (!message || seen[message.id]) {
      state.quarantinedMessages.push(m);
      return;
    }
    seen[message.id] = true;
    state.messages.push(message);
  });
  if (state.quarantinedMessages.length > (Array.isArray(raw.quarantinedMessages) ? raw.quarantinedMessages.length : 0)) {
    repairs.push('Some stored messages were invalid and were moved to "quarantinedMessages".');
  }

  // Mode ---------------------------------------------------------------------
  let mode = cmRaw.mode;
  if (MODE_IDS.indexOf(mode) === -1) {
    if (mode !== undefined) repairs.push('Unknown context-management mode "' + String(mode) + '"; using Sliding window.');
    mode = 'sliding-window';
  }

  // Branching ----------------------------------------------------------------
  const bRaw = isObject(cmRaw.branching) ? cmRaw.branching : {};
  const branchesRaw = Array.isArray(bRaw.branches) ? bRaw.branches.filter(function (br) {
    return isObject(br) && typeof br.id === 'string' && br.id.length > 0;
  }) : [];
  const findBranch = function (id) {
    for (let i = 0; i < branchesRaw.length; i += 1) if (branchesRaw[i].id === id) return branchesRaw[i];
    return null;
  };
  const main = findBranch(MAIN_BRANCH);
  const branches = [Object.assign(mainBranch(base.createdAt), main ? { name: stringOr(main.name, 'Main'), createdAt: isoOr(main.createdAt, base.createdAt) } : {})];

  let checkpoint = null;
  const cp = bRaw.checkpoint;
  if (isObject(cp) && typeof cp.id === 'string' && Array.isArray(cp.branchIds) && cp.branchIds.length === 2
      && cp.branchIds[0] !== cp.branchIds[1]
      && cp.branchIds.every(function (id) { return typeof id === 'string' && id !== MAIN_BRANCH && findBranch(id); })) {
    checkpoint = {
      id: cp.id,
      createdAt: isoOr(cp.createdAt, base.createdAt),
      afterMessageId: typeof cp.afterMessageId === 'string' ? cp.afterMessageId : null,
      baseMessageCount: isNonNegativeInt(cp.baseMessageCount) ? cp.baseMessageCount : 0,
      branchIds: cp.branchIds.slice()
    };
    cp.branchIds.forEach(function (id, i) {
      const br = findBranch(id);
      branches.push({
        id: id,
        name: stringOr(br.name, i === 0 ? 'Branch A' : 'Branch B'),
        parentId: MAIN_BRANCH,
        createdAt: isoOr(br.createdAt, checkpoint.createdAt)
      });
    });
  } else if (cp !== null && cp !== undefined) {
    repairs.push('The checkpoint record was invalid and has been removed.');
  }

  let activeBranchId = MAIN_BRANCH;
  if (checkpoint) {
    activeBranchId = checkpoint.branchIds.indexOf(bRaw.activeBranchId) !== -1 ? bRaw.activeBranchId : checkpoint.branchIds[0];
  }

  // Messages that belong to no live branch cannot be placed in any conversation.
  const liveIds = branches.map(function (br) { return br.id; });
  const orphans = state.messages.filter(function (m) { return liveIds.indexOf(m.branchId) === -1; });
  if (orphans.length) {
    state.messages = state.messages.filter(function (m) { return liveIds.indexOf(m.branchId) !== -1; });
    orphans.forEach(function (m) { state.quarantinedMessages.push(m); });
    repairs.push(orphans.length + ' message(s) belonged to a branch that no longer exists and were moved to "quarantinedMessages".');
  }

  // Sticky facts -------------------------------------------------------------
  const sRaw = isObject(cmRaw.stickyFacts) ? cmRaw.stickyFacts : {};
  const memoriesRaw = isObject(sRaw.memories) ? sRaw.memories : {};
  const memories = {};
  liveIds.forEach(function (id) {
    if (isObject(memoriesRaw[id])) memories[id] = normalizeFactsMemory(memoriesRaw[id]);
  });
  if (!memories[MAIN_BRANCH]) {
    memories[MAIN_BRANCH] = emptyFactsMemory();
    // The flat {"facts": {...}} layout from the specification is accepted too.
    if (isObject(sRaw.facts)) memories[MAIN_BRANCH].facts = normalizeFacts(sRaw.facts);
  }
  liveIds.forEach(function (id) {
    if (!memories[id]) memories[id] = JSON.parse(JSON.stringify(memories[MAIN_BRANCH]));
  });

  state.contextManagement = {
    mode: mode,
    slidingWindow: { N: parseWindowSize(isObject(cmRaw.slidingWindow) ? cmRaw.slidingWindow.N : null) || DEFAULT_SLIDING_N },
    stickyFacts: { N: parseWindowSize(sRaw.N) || DEFAULT_STICKY_N, memories: memories },
    branching: { checkpoint: checkpoint, activeBranchId: activeBranchId, branches: branches }
  };

  state.statistics = computeStatistics(state, raw.statistics);
  return { state: state, repairs: repairs };
}

function normalizeMessage(m) {
  if (!isObject(m) || typeof m.id !== 'string' || !m.id
      || (m.type !== 'request' && m.type !== 'response')
      || typeof m.content !== 'string'
      || typeof m.timestamp !== 'string' || isNaN(Date.parse(m.timestamp))) {
    return null;
  }
  const out = Object.assign({}, m);
  out.branchId = typeof m.branchId === 'string' && m.branchId ? m.branchId : MAIN_BRANCH;
  if (isNonNegativeInt(m.tokens)) {
    out.tokensSource = m.tokensSource === 'api' ? 'api' : 'estimate';
  } else {
    out.tokens = tokenService.count(m.content);
    out.tokensSource = 'estimate';
  }
  return out;
}

function normalizeFactsMemory(raw) {
  return {
    facts: normalizeFacts(raw.facts),
    messagesCovered: isNonNegativeInt(raw.messagesCovered) ? raw.messagesCovered : 0,
    coveredThroughId: typeof raw.coveredThroughId === 'string' ? raw.coveredThroughId : null,
    updatedAt: isoOr(raw.updatedAt, null),
    lastError: isObject(raw.lastError) && typeof raw.lastError.message === 'string'
      ? { message: raw.lastError.message, at: isoOr(raw.lastError.at, null) } : null
  };
}

/** Accepts {key: {value, createdAt, updatedAt}} and the plain {key: "value"}. */
function normalizeFacts(raw) {
  const facts = {};
  if (!isObject(raw)) return facts;
  Object.keys(raw).forEach(function (key) {
    if (!FACT_KEY_RE.test(key) || Object.keys(facts).length >= MAX_FACTS) return;
    const entry = raw[key];
    const value = isObject(entry) ? entry.value : entry;
    if (typeof value !== 'string' || !value.trim()) return;
    facts[key] = {
      value: value.slice(0, MAX_FACT_VALUE_CHARS),
      createdAt: isObject(entry) ? isoOr(entry.createdAt, null) : null,
      updatedAt: isObject(entry) ? isoOr(entry.updatedAt, null) : null
    };
  });
  return facts;
}

/**
 * Token totals over every stored message (all branches). Derived from the
 * messages, so deleting a branch lowers them; the cumulative API usage is
 * carried over from `previous`.
 */
function computeStatistics(state, previous) {
  const stats = emptyStatistics();
  state.messages.forEach(function (m) {
    stats.messageCount += 1;
    if (m.type === 'request') {
      stats.requestCount += 1;
      stats.totalRequestTokens += m.tokens;
    } else {
      stats.responseCount += 1;
      stats.totalResponseTokens += m.tokens;
    }
    if (m.tokensSource !== 'api' && m.tokens > 0) stats.estimated = true;
  });
  stats.totalTokens = stats.totalRequestTokens + stats.totalResponseTokens;

  const api = isObject(previous) && isObject(previous.api) ? previous.api : {};
  Object.keys(stats.api).forEach(function (key) {
    if (key === 'estimated') stats.api.estimated = api.estimated === true;
    else if (isNonNegativeInt(api[key])) stats.api[key] = api[key];
  });
  return stats;
}

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isoOr(value, fallback) {
  return typeof value === 'string' && !isNaN(Date.parse(value)) ? value : fallback;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

module.exports = {
  STATE_VERSION,
  MAIN_BRANCH,
  MODES,
  MODE_IDS,
  WINDOW_LIMITS,
  DEFAULT_SLIDING_N,
  DEFAULT_STICKY_N,
  FACT_KEY_RE,
  MAX_FACT_VALUE_CHARS,
  MAX_FACTS,
  defaultState,
  emptyFactsMemory,
  emptyApiUsage,
  createMessage,
  parseWindowSize,
  normalizeState,
  computeStatistics,
  newId,
  isObject,
  isNonNegativeInt
};
