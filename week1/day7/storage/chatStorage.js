'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ./data next to the project when running from a checkout. A packaged install
// points this at a writable state directory instead (systemd's StateDirectory),
// because the code itself is deployed read-only.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat-history.json');

// The two roles the application stores, and the label each one carries into
// the UI. Anything the client sends is ignored; a message is only ever built
// here, from a role this table knows.
const TAGS = {
  user: 'you asked',
  assistant: 'agent answered'
};

/**
 * Every write is queued behind the previous one. Two requests finishing at the
 * same moment therefore read-modify-write in sequence instead of racing, so
 * neither can drop the other's messages.
 */
let writeQueue = Promise.resolve();

/**
 * Build a stored message. The id, the timestamp and the tag are produced here
 * and never taken from the request body.
 *
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {Date} [when] Lets a request/response pair record when each half happened.
 * @returns {{id: string, timestamp: string, tag: string, role: string, content: string}}
 */
function createMessage(role, content, when) {
  if (!TAGS[role]) throw new Error('Unknown message role: ' + role);
  return {
    id: newId(),
    timestamp: (when || new Date()).toISOString(),
    tag: TAGS[role],
    role: role,
    content: String(content)
  };
}

/**
 * Read the whole conversation. A missing file means "no conversation yet",
 * which is not an error; a corrupt one is, because silently starting over
 * would throw away the agent's memory.
 *
 * @returns {Promise<Array<object>>}
 */
function loadMessages() {
  return readFile(HISTORY_FILE).then(function (raw) {
    if (raw === null) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(HISTORY_FILE + ' is not valid JSON: ' + err.message);
    }
    const messages = parsed && parsed.messages;
    if (!Array.isArray(messages)) {
      throw new Error(HISTORY_FILE + ' has no "messages" array.');
    }
    return messages.filter(isUsableMessage);
  });
}

/**
 * Append messages and return them. The whole read-modify-write runs inside the
 * queue, and the file is replaced by an atomic rename, so a crash mid-write
 * leaves the previous history intact rather than a truncated file.
 *
 * @param {Array<object>} messages
 * @returns {Promise<Array<object>>}
 */
function appendMessages(messages) {
  const toAdd = messages.filter(Boolean);
  if (!toAdd.length) return Promise.resolve([]);

  const result = writeQueue.then(function () {
    return loadMessages().then(function (existing) {
      return writeAtomic({ messages: existing.concat(toAdd) });
    }).then(function () {
      return toAdd;
    });
  });

  // Keep the queue alive after a failed write so later requests still run.
  writeQueue = result.catch(function () {});
  return result;
}

/** Create data/chat-history.json if it is not there yet. Safe to call twice. */
function init() {
  return mkdirp(DATA_DIR).then(function () {
    return readFile(HISTORY_FILE);
  }).then(function (raw) {
    if (raw !== null) return loadMessages().then(function () {}); // Validate early.
    return writeAtomic({ messages: [] });
  });
}

function isUsableMessage(message) {
  return message
    && typeof message.content === 'string'
    && Object.prototype.hasOwnProperty.call(TAGS, message.role);
}

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

function writeAtomic(data) {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = HISTORY_FILE + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  return mkdirp(DATA_DIR).then(function () {
    return writeFile(tmp, json);
  }).then(function () {
    return rename(tmp, HISTORY_FILE);
  }).catch(function (err) {
    fs.unlink(tmp, function () {});
    throw err;
  });
}

// --- Promise wrappers (Node 10's fs.promises is still flagged experimental) ---

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
  HISTORY_FILE: HISTORY_FILE,
  TAGS: TAGS,
  init: init,
  loadMessages: loadMessages,
  appendMessages: appendMessages,
  createMessage: createMessage
};
