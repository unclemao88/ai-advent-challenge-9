import path from 'node:path';

import { JsonFileBackend } from '../storage/JsonFileBackend.js';
import { AppError, badRequest, conflict } from '../utils/errors.js';
import { SerialQueue } from '../utils/serialQueue.js';
import { isPlainObject, requireText } from '../utils/validate.js';

/**
 * The user profile: how the user wants to be answered.
 *
 * Stored in `data/profiles/<profileId>.json` (a single local user today, so
 * the id is "user"; the id parameter is where multi-user support plugs in).
 * The profile is read fresh for every request, so an edit made in the UI is
 * applied to the very next question.
 */
export const PROFILE_FIELDS = Object.freeze({
  style: { label: 'Style', hint: 'e.g. concise, detailed, technical, friendly', max: 2000 },
  format: { label: 'Format', hint: 'e.g. markdown, plain text, structured, bullet points', max: 2000 },
  limitations: { label: 'Limitations', hint: 'e.g. max 200 words, avoid topic X, no code unless asked', max: 2000 },
});

const FIELD_NAMES = Object.keys(PROFILE_FIELDS);
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class ProfileManager {
  #queue = new SerialQueue();

  constructor({ dataDir, logger }) {
    this.backend = new JsonFileBackend({ directory: path.join(dataDir, 'profiles'), dataDir, backup: true, logger });
    this.logger = logger;
  }

  async init() {
    await this.backend.init();
  }

  /** @returns {Promise<object|null>} The profile, or null when none exists. */
  getProfile(profileId = 'user') {
    return this.#queue.run(() => this.#read(profileId));
  }

  // Validation runs before the lock; the methods are async so a bad input
  // rejects like every other failure instead of throwing synchronously.

  /** Create a profile. Fails if one already exists. */
  async createProfile(input, profileId = 'user') {
    const fields = validateProfile(input, { partial: false });
    return this.#queue.run(async () => {
      if (await this.#read(profileId)) throw conflict('A profile already exists. Edit it instead.', 'profile_exists');
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), ...fields, createdAt: now, updatedAt: now };
      await this.#write(profileId, profile);
      this.logger.info('profile.create', { profileId });
      return profile;
    });
  }

  /** Create or replace every field. */
  async saveProfile(input, profileId = 'user') {
    const fields = validateProfile(input, { partial: false });
    return this.#queue.run(async () => {
      const existing = await this.#read(profileId);
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), ...fields, createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.#write(profileId, profile);
      this.logger.info('profile.save', { profileId, created: !existing });
      return profile;
    });
  }

  /** Change some fields; the others keep their value. Creates the profile if needed. */
  async updateProfile(input, profileId = 'user') {
    const fields = validateProfile(input, { partial: true });
    return this.#queue.run(async () => {
      const existing = await this.#read(profileId);
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), ...existing, ...fields, createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.#write(profileId, profile);
      this.logger.info('profile.update', { profileId, fields: Object.keys(fields) });
      return profile;
    });
  }

  /** Empty every field but keep the profile. */
  clearProfile(profileId = 'user') {
    return this.#queue.run(async () => {
      const existing = await this.#read(profileId);
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), createdAt: existing?.createdAt ?? now, updatedAt: now };
      await this.#write(profileId, profile);
      this.logger.info('profile.clear', { profileId });
      return profile;
    });
  }

  /** @returns {Promise<boolean>} Whether a profile existed. */
  deleteProfile(profileId = 'user') {
    return this.#queue.run(async () => {
      const existed = await this.backend.delete(assertProfileId(profileId));
      this.logger.info('profile.delete', { profileId, existed });
      return existed;
    });
  }

  async #read(profileId) {
    const stored = await this.backend.get(assertProfileId(profileId));
    if (!isPlainObject(stored)) return null;
    const profile = emptyFields();
    for (const name of FIELD_NAMES) {
      if (typeof stored[name] === 'string') profile[name] = stored[name].slice(0, PROFILE_FIELDS[name].max);
    }
    profile.createdAt = typeof stored.createdAt === 'string' ? stored.createdAt : null;
    profile.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null;
    return profile;
  }

  #write(profileId, profile) {
    return this.backend.put(assertProfileId(profileId), { version: 1, ...profile });
  }
}

function emptyFields() {
  return Object.fromEntries(FIELD_NAMES.map((name) => [name, '']));
}

function assertProfileId(id) {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new AppError(400, 'Invalid profile id.', 'invalid_profile');
  return id;
}

/**
 * @param {unknown} input
 * @param {{partial: boolean}} options With `partial: false`, missing fields become ''.
 * @returns {Record<string, string>}
 */
export function validateProfile(input, { partial }) {
  if (!isPlainObject(input)) throw badRequest('The profile must be a JSON object.', 'invalid_profile');
  const allowed = new Set([...FIELD_NAMES, 'createdAt', 'updatedAt']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw badRequest(`Unknown profile field(s): ${unknown.join(', ')}.`, 'invalid_profile');

  const fields = {};
  for (const name of FIELD_NAMES) {
    if (input[name] === undefined) {
      if (!partial) fields[name] = '';
      continue;
    }
    try {
      fields[name] = requireText(input[name], PROFILE_FIELDS[name].label, { min: 0, max: PROFILE_FIELDS[name].max });
    } catch (err) {
      err.code = 'invalid_profile';
      throw err;
    }
  }
  return fields;
}

/** True when at least one field has content. */
export function hasProfileContent(profile) {
  return Boolean(profile && FIELD_NAMES.some((name) => profile[name]?.trim()));
}

/** The profile as the text of the [USER PROFILE] section. '' when there is nothing to apply. */
export function formatProfile(profile) {
  if (!hasProfileContent(profile)) return '';
  return FIELD_NAMES
    .filter((name) => profile[name]?.trim())
    .map((name) => `${PROFILE_FIELDS[name].label}: ${profile[name].trim()}`)
    .join('\n');
}
