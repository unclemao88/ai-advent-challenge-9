import { MemoryLayer, cleanText, isPlainObject, isoTimestamp } from './memoryLayer.js';

/**
 * The fields of the user profile, in the order they are shown and sent.
 *
 * `style`, `format` and `limitations` are the three required ones; `name` is
 * optional and only used to address the user.
 */
export const PROFILE_FIELDS = {
  name: { label: 'Name', max: 120, hint: 'How the agent should address you.' },
  style: { label: 'Style', max: 1000, hint: 'Tone and level of detail, e.g. "direct, technical, no small talk".' },
  format: { label: 'Format', max: 1000, hint: 'How answers should be laid out, e.g. "short paragraphs, code blocks for code".' },
  limitations: { label: 'Limitations', max: 1000, hint: 'What to avoid, e.g. "no emojis, never suggest paid services".' },
};

/**
 * The user profile: stable preferences that shape every answer.
 *
 * It is a layer of its own — its own storage provider, its own file — because
 * it is the one piece of memory the user owns outright: they type it, they edit
 * it, and it is attached to every single request. Nothing here is ever written
 * by the model.
 *
 * Stored as one document, `profile`:
 *   { "name", "style", "format", "limitations", "createdAt", "updatedAt" }
 */
export class ProfileStore extends MemoryLayer {
  static id = 'profile';
  static directory = 'profile';

  get documents() {
    return { profile: emptyProfile };
  }

  normalize(documentName, value) {
    const source = isPlainObject(value) ? value : {};
    const profile = emptyProfile();
    for (const [field, { max }] of Object.entries(PROFILE_FIELDS)) {
      profile[field] = cleanText(source[field], max);
    }
    profile.createdAt = isoTimestamp(source.createdAt);
    profile.updatedAt = isoTimestamp(source.updatedAt);
    return profile;
  }

  /** @returns {Promise<ReturnType<typeof emptyProfile>>} */
  async get() {
    return (await this.read()).profile;
  }

  /**
   * Replace the profile with `values`. Unknown keys are ignored and every
   * field is trimmed and length-capped, so what is stored is always the shape
   * the context builder expects.
   *
   * @param {Record<string, unknown>} values
   */
  async save(values) {
    const source = isPlainObject(values) ? values : {};
    const data = await this.update((draft) => {
      const profile = draft.profile;
      for (const [field, { max }] of Object.entries(PROFILE_FIELDS)) {
        // A field left out of the request keeps its stored value, so a partial
        // save from a future UI cannot silently erase the rest.
        if (source[field] !== undefined) profile[field] = cleanText(source[field], max);
      }
      profile.createdAt ??= new Date().toISOString();
      profile.updatedAt = new Date().toISOString();
    });
    return data.profile;
  }

  /**
   * Empty every field but keep the record itself, so "created" still says when
   * the user first wrote a profile. This is "clear"; `clear()` inherited from
   * MemoryLayer is "delete" and resets the document completely.
   */
  async clearFields() {
    const data = await this.update((draft) => {
      const { createdAt } = draft.profile;
      draft.profile = emptyProfile();
      draft.profile.createdAt = createdAt;
      draft.profile.updatedAt = createdAt ? new Date().toISOString() : null;
    });
    return data.profile;
  }

  /** Delete the profile completely: no fields, no dates. */
  async remove() {
    await this.clear();
    return this.get();
  }

  /** @returns {boolean} Whether the profile says anything at all. */
  static isEmpty(profile) {
    return Object.keys(PROFILE_FIELDS).every((field) => !profile?.[field]);
  }
}

export function emptyProfile() {
  return { name: '', style: '', format: '', limitations: '', createdAt: null, updatedAt: null };
}
