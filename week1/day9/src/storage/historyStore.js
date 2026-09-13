'use strict';

const path = require('path');
const crypto = require('crypto');

const Mutex = require('../utils/mutex');
const tokenService = require('../services/tokenService');
const jsonFile = require('./jsonFile');

const HISTORY_VERSION = 1;

const TAGS = {
  user: 'you asked',
  assistant: 'agent answered'
};

/**
 * Build a stored message. Id, timestamp and tag are generated here — never
 * taken from a request body — so a client cannot forge an "agent answered".
 *
 * @param {'user'|'assistant'} role
 * @param {string} content Stored exactly as received / generated.
 * @param {{tokens?: number, tokensSource?: 'api'|'estimate', timestamp?: Date, usage?: object}} [options]
 */
function createMessage(role, content, options) {
  if (!TAGS[role]) throw new Error('Unknown message role: ' + role);
  const opts = options || {};
  const text = String(content);
  const exact = typeof opts.tokens === 'number' && isFinite(opts.tokens) && opts.tokens >= 0;

  const message = {
    id: newId(),
    timestamp: (opts.timestamp || new Date()).toISOString(),
    role: role,
    tag: TAGS[role],
    content: text,
    tokens: exact ? Math.round(opts.tokens) : tokenService.count(text),
    tokensSource: exact && opts.tokensSource === 'api' ? 'api' : 'estimate'
  };
  if (opts.usage) message.usage = opts.usage; // The API call that produced an answer.
  return message;
}

function emptySummary() {
  return { summary: '', tokens: 0, tokensSource: 'estimate', updatedAt: null, messagesCovered: 0 };
}

/**
 * The two JSON files that make up the agent's memory:
 *
 *   history.json — every message ever exchanged, append-only.
 *   summary.json — the compressed memory of the oldest `messagesCovered` of them.
 *
 * Every public method runs under one lock, so concurrent requests perform their
 * read-modify-write cycles one after another, and every write is an atomic
 * rename. A reader therefore never sees a half-written file, and two writers
 * can never drop each other's messages.
 */
class HistoryStore {
  /**
   * @param {{dataDir: string, logger?: Console}} options
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.historyFile = path.join(this.dataDir, 'history.json');
    this.summaryFile = path.join(this.dataDir, 'summary.json');
    this.logger = options.logger || console;
    this.lock = new Mutex();
    // Things the user should know about (a quarantined file). Shown in the UI.
    this.notices = [];
  }

  /** Create missing files; quarantine unreadable ones. Run once at startup. */
  init() {
    return this.lock.run(async () => {
      await jsonFile.ensureDir(this.dataDir);
      const history = await this._loadHistory();
      if (history.fresh) await this._writeHistory(history.raw);
      const summary = await this._loadSummary();
      if (summary.fresh) await jsonFile.writeJsonAtomic(this.summaryFile, summary.record);
    });
  }

  /**
   * The current memory: all usable messages (oldest first) and the summary.
   * @returns {Promise<{messages: object[], summary: object}>}
   */
  getState() {
    return this.lock.run(() => this._state());
  }

  /**
   * Append one message and return the updated state. The existing messages are
   * written back untouched — including entries this version cannot use.
   */
  appendMessage(message) {
    return this.lock.run(async () => {
      const history = await this._loadHistory();
      history.raw.messages.push(message);
      history.raw.updatedAt = new Date().toISOString();
      await this._writeHistory(history.raw);
      return this._state();
    });
  }

  /**
   * Replace the summary. Refuses a record that claims to cover messages that do
   * not exist, which would otherwise corrupt the memory boundary silently.
   */
  saveSummary(record) {
    return this.lock.run(async () => {
      const history = await this._loadHistory();
      const messages = usableMessages(history.raw);
      const covered = record.messagesCovered;
      if (!Number.isInteger(covered) || covered < 0 || covered > messages.length) {
        throw new Error('Summary covers ' + covered + ' messages but only ' + messages.length + ' exist.');
      }
      const stored = {
        summary: String(record.summary || ''),
        tokens: record.tokens,
        tokensSource: record.tokensSource === 'api' ? 'api' : 'estimate',
        updatedAt: new Date().toISOString(),
        messagesCovered: covered,
        // Lets a later read detect that history.json changed underneath the summary.
        coveredThroughId: covered > 0 ? messages[covered - 1].id : null
      };
      if (record.model) stored.model = record.model;
      await jsonFile.writeJsonAtomic(this.summaryFile, stored);
      return this._state();
    });
  }

  /** Start a new, empty conversation. */
  clear() {
    return this.lock.run(async () => {
      await this._writeHistory(emptyHistory());
      await jsonFile.writeJsonAtomic(this.summaryFile, emptySummary());
      this.notices = [];
      return this._state();
    });
  }

  // --- Internals: call only while holding the lock -------------------------

  async _state() {
    const history = await this._loadHistory();
    const messages = usableMessages(history.raw);
    const summary = (await this._loadSummary()).record;
    return { messages: messages, summary: this._checkSummary(summary, messages) };
  }

  /**
   * @returns {Promise<{raw: object, fresh: boolean}>} `raw` is the file as
   *          stored; `fresh` means it did not exist (or was just quarantined).
   */
  async _loadHistory() {
    const file = await jsonFile.readJson(this.historyFile);
    if (file.status === 'ok' && file.data && Array.isArray(file.data.messages)) {
      return { raw: file.data, fresh: false };
    }
    if (file.status === 'ok' || file.status === 'corrupt') {
      const reason = file.status === 'corrupt' ? 'is not valid JSON' : 'has no "messages" array';
      await this._quarantine(this.historyFile, 'history.json ' + reason);
    }
    return { raw: emptyHistory(), fresh: true };
  }

  async _loadSummary() {
    const file = await jsonFile.readJson(this.summaryFile);
    if (file.status === 'ok' && file.data && typeof file.data === 'object'
        && typeof file.data.summary === 'string') {
      const d = file.data;
      return {
        fresh: false,
        record: {
          summary: d.summary,
          tokens: typeof d.tokens === 'number' && d.tokens >= 0 ? d.tokens : tokenService.count(d.summary),
          tokensSource: d.tokensSource === 'api' ? 'api' : 'estimate',
          updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
          messagesCovered: Number.isInteger(d.messagesCovered) && d.messagesCovered >= 0 ? d.messagesCovered : 0,
          coveredThroughId: typeof d.coveredThroughId === 'string' ? d.coveredThroughId : null,
          model: typeof d.model === 'string' ? d.model : undefined
        }
      };
    }
    if (file.status === 'ok' || file.status === 'corrupt') {
      // Nothing is lost: the summary is derived data and will be rebuilt from
      // history.json on the next request.
      await this._quarantine(this.summaryFile, 'summary.json is unreadable; the summary will be rebuilt from history');
    }
    return { fresh: true, record: emptySummary() };
  }

  /**
   * A summary is only trusted if it still lines up with history.json. If the
   * history was edited or replaced, fall back to "nothing summarized yet" — the
   * agent then rebuilds the summary from the original messages.
   */
  _checkSummary(summary, messages) {
    const covered = summary.messagesCovered;
    const aligned = covered <= messages.length
      && (covered === 0 || !summary.coveredThroughId || messages[covered - 1].id === summary.coveredThroughId);
    if (aligned) return summary;

    this.logger.warn('summary.json does not match history.json (covers ' + covered
      + ' of ' + messages.length + ' messages); it will be rebuilt.');
    return emptySummary();
  }

  _writeHistory(raw) {
    return jsonFile.writeJsonAtomic(this.historyFile, raw);
  }

  async _quarantine(file, reason) {
    const backup = await jsonFile.quarantine(file);
    const notice = reason + '. The unreadable file was kept as ' + path.basename(backup) + '.';
    this.logger.error('[storage] ' + notice);
    this.notices.push(notice);
  }
}

function emptyHistory() {
  const now = new Date().toISOString();
  return { version: HISTORY_VERSION, createdAt: now, updatedAt: now, messages: [] };
}

/**
 * Entries the app can use. Anything else (hand-edited, from a future schema) is
 * skipped for context and display but stays in the file untouched.
 */
function usableMessages(raw) {
  return raw.messages.filter(function (m) {
    return Boolean(m) && typeof m === 'object'
      && Object.prototype.hasOwnProperty.call(TAGS, m.role)
      && typeof m.content === 'string'
      && typeof m.id === 'string' && m.id.length > 0;
  });
}

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

module.exports = { HistoryStore, createMessage, emptySummary, TAGS };
