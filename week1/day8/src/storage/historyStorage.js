'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tokenCounter = require('../utils/tokenCounter');

const SCHEMA_VERSION = 1;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const RELATIVE_NAME = 'data/history.json';

// The two roles the application stores, and the type/tag pair each one carries
// into the UI. Nothing the client sends is trusted: a stored message is only
// ever built here, from a role this table knows.
const ROLE_LABELS = {
  user: { type: 'request', tag: 'you asked' },
  assistant: { type: 'response', tag: 'agent answered' }
};

/**
 * Every write is queued behind the previous one. Two requests finishing at the
 * same instant therefore read-modify-write in sequence instead of racing, so
 * neither can drop the other's messages. This is the mutex for the file.
 */
let writeQueue = Promise.resolve();

/**
 * Build a stored message. The id, the timestamp, the type and the tag are
 * produced here and never taken from a request body.
 *
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {{when?: Date, tokenCount?: number, tokenSource?: 'api'|'estimate'}} [options]
 *        `tokenCount` is DeepSeek's exact number when we have one; without it
 *        the content is estimated locally and marked as such.
 * @returns {object} A message matching the schema in the README.
 */
function createMessage(role, content, options) {
  const labels = ROLE_LABELS[role];
  if (!labels) throw new Error('Unknown message role: ' + role);

  const opts = options || {};
  const text = String(content);
  const exact = Number.isFinite(opts.tokenCount) && opts.tokenCount >= 0;

  return {
    id: newId(),
    type: labels.type,
    tag: labels.tag,
    role: role,
    content: text,
    timestamp: (opts.when || new Date()).toISOString(),
    tokenCount: exact ? Math.round(opts.tokenCount) : tokenCounter.estimateTokens(text),
    // Honesty about provenance: "api" came from DeepSeek's usage object and is
    // exact, "estimate" came from our own heuristic counter.
    tokenSource: exact ? (opts.tokenSource || 'api') : 'estimate'
  };
}

/**
 * Read the whole conversation file.
 *
 * A missing file means "no conversation yet", which is not an error. A corrupt
 * one *is*: silently starting over would throw away the agent's memory, so the
 * caller is told and the bad file is left on disk for inspection.
 *
 * @returns {Promise<{version: number, createdAt: string, updatedAt: string, messages: object[]}>}
 */
function loadHistory() {
  return readFile(HISTORY_FILE).then(function (raw) {
    if (raw === null) return emptyHistory();
    if (!raw.trim()) return emptyHistory(); // Zero-length file from an interrupted first run.

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(RELATIVE_NAME + ' is not valid JSON: ' + err.message);
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
      throw new Error(RELATIVE_NAME + ' has no "messages" array.');
    }

    return {
      version: Number(parsed.version) || SCHEMA_VERSION,
      createdAt: isoOr(parsed.createdAt, null),
      updatedAt: isoOr(parsed.updatedAt, null),
      // A single malformed entry (hand-edited, or from an older schema) is
      // dropped rather than allowed to break the whole conversation.
      messages: parsed.messages.filter(isUsableMessage).map(normalizeMessage)
    };
  });
}

/** Just the messages, oldest first — what the agent and the API layer want. */
function loadMessages() {
  return loadHistory().then(function (history) {
    return history.messages;
  });
}

/**
 * Append messages atomically and report the new totals.
 *
 * The whole read-modify-write runs inside the queue, and the file is replaced
 * by a rename, so an interrupted write leaves the previous history intact
 * rather than a half-written file.
 *
 * @param {object[]} messages
 * @returns {Promise<{messages: object[], historyTokenCount: number}>} The full
 *          stored conversation after the append.
 */
function appendMessages(messages) {
  const toAdd = (messages || []).filter(Boolean);

  const result = writeQueue.then(function () {
    return loadHistory().then(function (history) {
      if (!toAdd.length) return history;

      const updated = {
        version: SCHEMA_VERSION,
        createdAt: history.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: history.messages.concat(toAdd)
      };
      return writeAtomic(updated).then(function () {
        return updated;
      });
    });
  }).then(function (history) {
    return {
      messages: history.messages,
      historyTokenCount: tokenCounter.sumStoredTokens(history.messages)
    };
  });

  // Keep the queue alive after a failed write so later requests still run.
  writeQueue = result.catch(function () {});
  return result;
}

/**
 * Create data/history.json if it is not there yet, and validate it if it is.
 * Called once at startup so a broken file is reported before the first request.
 */
function init() {
  return mkdirp(DATA_DIR).then(function () {
    return readFile(HISTORY_FILE);
  }).then(function (raw) {
    if (raw !== null && raw.trim()) {
      return loadHistory().then(function () {}); // Fail loudly, now, not mid-chat.
    }
    return writeAtomic(emptyHistory());
  });
}

function emptyHistory() {
  const now = new Date().toISOString();
  return { version: SCHEMA_VERSION, createdAt: now, updatedAt: now, messages: [] };
}

/** The minimum a stored entry needs for the agent and the UI to use it. */
function isUsableMessage(message) {
  return Boolean(message)
    && typeof message.content === 'string'
    && Object.prototype.hasOwnProperty.call(ROLE_LABELS, message.role);
}

/**
 * Fill in anything an older or hand-edited file is missing, so the rest of the
 * application can rely on every field being present.
 */
function normalizeMessage(message) {
  const labels = ROLE_LABELS[message.role];
  const hasCount = Number.isFinite(Number(message.tokenCount)) && Number(message.tokenCount) >= 0;
  return {
    id: typeof message.id === 'string' && message.id ? message.id : newId(),
    type: message.type === labels.type ? message.type : labels.type,
    tag: message.tag === labels.tag ? message.tag : labels.tag,
    role: message.role,
    content: message.content,
    timestamp: isoOr(message.timestamp, new Date(0).toISOString()),
    tokenCount: hasCount ? Math.round(Number(message.tokenCount)) : tokenCounter.estimateTokens(message.content),
    tokenSource: message.tokenSource === 'api' ? 'api' : 'estimate'
  };
}

function isoOr(value, fallback) {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

/**
 * Atomic replace: write a uniquely named temporary file in the same directory,
 * then rename it over the target. Rename within one filesystem is atomic, so a
 * reader never sees a partially written history.
 */
function writeAtomic(history) {
  const json = JSON.stringify(history, null, 2) + '\n';
  const tmp = HISTORY_FILE + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  return mkdirp(DATA_DIR).then(function () {
    return writeFile(tmp, json);
  }).then(function () {
    return rename(tmp, HISTORY_FILE);
  }).catch(function (err) {
    fs.unlink(tmp, function () {}); // Best effort; never mask the real error.
    throw err;
  });
}

// --- Promise wrappers (fs.promises is still experimental on Node 10) ---

function readFile(file) {
  return new Promise(function (resolve, reject) {
    fs.readFile(file, 'utf8', function (err, data) {
      if (err) return err.code === 'ENOENT' ? resolve(null) : reject(err);
      resolve(data);
    });
  });
}

function writeFile(file, data) {
  return new Promise(function (resolve, reject) {
    fs.writeFile(file, data, 'utf8', function (err) {
      err ? reject(err) : resolve();
    });
  });
}

function rename(from, to) {
  return new Promise(function (resolve, reject) {
    fs.rename(from, to, function (err) {
      err ? reject(err) : resolve();
    });
  });
}

function mkdirp(dir) {
  return new Promise(function (resolve, reject) {
    fs.mkdir(dir, { recursive: true }, function (err) {
      err && err.code !== 'EEXIST' ? reject(err) : resolve();
    });
  });
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  HISTORY_FILE: HISTORY_FILE,
  RELATIVE_NAME: RELATIVE_NAME,
  ROLE_LABELS: ROLE_LABELS,
  init: init,
  loadHistory: loadHistory,
  loadMessages: loadMessages,
  appendMessages: appendMessages,
  createMessage: createMessage
};
