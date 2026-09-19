import { JsonDocument } from '../persistence/jsonDocument.js';
import { DATA_FILES } from '../persistence/dataPaths.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { isPlainObject, requireText } from '../utils/validate.js';

/**
 * The user profile: how the user wants the agent to behave.
 *
 * Stored in `data/profile/profile.json` as `{ "profile": { style, format, limitations,
 * createdAt, updatedAt } }`, or `{ "profile": null }` when there is none.
 * Logically it is part of long-term memory; it is managed here because the
 * user edits it directly and it goes into every request.
 *
 * The profile is read fresh for every request, so an edit made in the modal is
 * applied to the very next question.
 */
export const PROFILE_FIELDS = Object.freeze({
  style: { label: 'Style', hint: 'e.g. concise, detailed, technical, friendly', max: 2000 },
  format: { label: 'Format', hint: 'e.g. markdown, plain text, bullet points, code first', max: 2000 },
  limitations: { label: 'Limitations', hint: 'e.g. max 200 words, no code unless asked, English only', max: 2000 },
});

const FIELD_NAMES = Object.keys(PROFILE_FIELDS);

export class ProfileManager {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.doc = new JsonDocument({
      dataDir, file: DATA_FILES.profile, logger, empty: () => ({ profile: null }), normalize: normalizeDoc,
    });
  }

  init() {
    return this.doc.init();
  }

  get location() {
    return this.doc.location;
  }

  /** @returns {Promise<object|null>} */
  async getProfile() {
    return (await this.doc.read()).profile;
  }

  /** Create a profile. Fails with 409 when one exists. */
  async createProfile(input) {
    const fields = validateProfile(input, { partial: false });
    return this.doc.update((doc) => {
      if (doc.profile) throw conflict('A profile already exists. Edit it instead.', 'profile_exists');
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), ...fields, createdAt: now, updatedAt: now };
      this.logger.info('profile.create');
      return { doc: { profile }, result: profile };
    });
  }

  /** Change the given fields (creating the profile if needed); the others keep their value. */
  async updateProfile(input) {
    const fields = validateProfile(input, { partial: true });
    return this.doc.update((doc) => {
      const now = new Date().toISOString();
      const profile = { ...emptyFields(), ...doc.profile, ...fields, createdAt: doc.profile?.createdAt ?? now, updatedAt: now };
      this.logger.info('profile.update', { fields: Object.keys(fields), created: !doc.profile });
      return { doc: { profile }, result: profile };
    });
  }

  /** Empty every field but keep the profile. 404 when there is none. */
  async clearProfile() {
    return this.doc.update((doc) => {
      if (!doc.profile) throw notFound('There is no profile to clear.', 'profile_not_found');
      const profile = { ...emptyFields(), createdAt: doc.profile.createdAt, updatedAt: new Date().toISOString() };
      this.logger.info('profile.clear');
      return { doc: { profile }, result: profile };
    });
  }

  /** @returns {Promise<boolean>} Whether a profile existed. */
  async deleteProfile() {
    return this.doc.update((doc) => {
      const existed = Boolean(doc.profile);
      this.logger.info('profile.delete', { existed });
      return { doc: { profile: null }, result: existed };
    });
  }
}

function emptyFields() {
  return Object.fromEntries(FIELD_NAMES.map((name) => [name, '']));
}

function normalizeDoc(value) {
  const stored = isPlainObject(value) ? value.profile : null;
  if (!isPlainObject(stored)) return { profile: null };
  const profile = emptyFields();
  for (const name of FIELD_NAMES) {
    if (typeof stored[name] === 'string') profile[name] = stored[name].slice(0, PROFILE_FIELDS[name].max);
  }
  profile.createdAt = typeof stored.createdAt === 'string' ? stored.createdAt : null;
  profile.updatedAt = typeof stored.updatedAt === 'string' ? stored.updatedAt : null;
  return { profile };
}

/**
 * @param {unknown} input
 * @param {{partial: boolean}} options With `partial: false`, missing fields become ''.
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

export function hasProfileContent(profile) {
  return Boolean(profile && FIELD_NAMES.some((name) => profile[name]?.trim()));
}

/**
 * The profile as the body of the [USER PROFILE] section. The section is sent
 * with every request, so an absent profile is stated explicitly.
 */
export function formatProfile(profile) {
  if (!hasProfileContent(profile)) return 'No profile is set. Use neutral defaults: clear, well-structured answers.';
  return FIELD_NAMES
    .map((name) => `${PROFILE_FIELDS[name].label}: ${profile[name]?.trim() || '(not specified)'}`)
    .join('\n');
}
