'use strict';

const path = require('path');

const Mutex = require('../utils/mutex');
const jsonFile = require('./jsonFile');
const schema = require('./schema');

const STATE_FILE = 'state.json';

/**
 * Owns data/state.json.
 *
 * Everything lives in one file on purpose: a turn changes messages, token
 * statistics and sometimes facts together, and a single atomic rename means a
 * crash can never leave, say, a new message without its branch record.
 *
 * Every public method runs under one lock, so concurrent requests perform their
 * read-modify-write cycles one after another, and every write is an atomic
 * rename (write temp file → fsync → rename). A reader never sees a half-written
 * file and two writers can never drop each other's changes.
 */
class StateStore {
  /**
   * @param {{dataDir: string, logger?: Console}} options
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.file = path.join(this.dataDir, STATE_FILE);
    this.logger = options.logger || console;
    this.lock = new Mutex();
    // Things the user should know about (a quarantined or repaired file). Shown in the UI.
    this.notices = [];
  }

  /** Create the file if missing; quarantine or repair a bad one. Run once at startup. */
  init() {
    return this.lock.run(async () => {
      await jsonFile.ensureDir(this.dataDir);
      const loaded = await this._load();
      if (loaded.repairs.length) {
        // Keep the original next to the repaired file before overwriting it.
        const backup = this.file.replace(/\.json$/, '') + '.pre-repair-' + stamp() + '.json';
        await jsonFile.writeJsonAtomic(backup, loaded.raw);
        loaded.repairs.forEach((r) => this._notice(r + ' (original kept as ' + path.basename(backup) + ')'));
      }
      if (loaded.fresh || loaded.repairs.length) await jsonFile.writeJsonAtomic(this.file, loaded.state);
    });
  }

  /** @returns {Promise<object>} The current, normalized state. */
  read() {
    return this.lock.run(async () => (await this._load()).state);
  }

  /**
   * Read-modify-write under the lock. `mutator` changes the state in place and
   * may return a value; if it throws, nothing is written.
   *
   * @param {(state: object) => any} mutator
   * @returns {Promise<{state: object, result: any}>}
   */
  update(mutator) {
    return this.lock.run(async () => {
      const state = (await this._load()).state;
      const result = await mutator(state);
      state.updatedAt = new Date().toISOString();
      state.statistics = schema.computeStatistics(state, state.statistics);
      await jsonFile.writeJsonAtomic(this.file, state);
      return { state: state, result: result };
    });
  }

  // --- Internals: call only while holding the lock -------------------------

  async _load() {
    const file = await jsonFile.readJson(this.file);
    if (file.status === 'missing') {
      return { state: schema.defaultState(), fresh: true, repairs: [] };
    }
    if (file.status === 'ok') {
      try {
        const normalized = schema.normalizeState(file.data);
        return { state: normalized.state, fresh: false, repairs: normalized.repairs, raw: file.data };
      } catch (err) {
        await this._quarantine('state.json is not a valid state file (' + err.message + ')');
        return { state: schema.defaultState(), fresh: true, repairs: [] };
      }
    }
    await this._quarantine(file.status === 'empty' ? 'state.json was empty' : 'state.json is not valid JSON');
    return { state: schema.defaultState(), fresh: true, repairs: [] };
  }

  async _quarantine(reason) {
    const backup = await jsonFile.quarantine(this.file);
    this._notice(reason + '. A new conversation was started; the unreadable file was kept as ' + path.basename(backup) + '.');
  }

  _notice(text) {
    this.logger.error('[storage] ' + text);
    this.notices.push(text);
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = { StateStore, STATE_FILE };
