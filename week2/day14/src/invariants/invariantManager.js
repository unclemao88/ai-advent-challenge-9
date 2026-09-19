import { randomBytes } from 'node:crypto';

import { JsonDocument } from '../utils/jsonDocument.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { isPlainObject, requireEnum, requireText } from '../utils/validate.js';

/**
 * Invariants: rules the agent must never violate.
 *
 * Stored on their own in `data/invariants.json` — never mixed with the
 * conversation, the memory layers or the profile:
 *
 *   { "invariants": [ { "id": "stack", "name": "Programming stack",
 *                       "value": "Node.js + Express", "category": "stack",
 *                       "enabled": true, "forbidden": ["eval("], ... } ] }
 *
 * `forbidden` is optional: terms whose appearance violates the rule, for rules
 * the technology catalogue cannot understand on its own (business and
 * security rules). Every enabled invariant goes into every request, whatever
 * its category.
 */
export const INVARIANT_CATEGORIES = ['architecture', 'stack', 'technical', 'business', 'security', 'other'];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIMITS = Object.freeze({ name: 120, value: 1000, forbidden: 20, term: 80, count: 100 });

/** Examples the UI can add with one click (the ones from the specification). */
export const EXAMPLE_INVARIANTS = Object.freeze([
  { id: 'architecture', name: 'Selected architecture', value: 'Modular Node.js architecture', category: 'architecture', enabled: true },
  { id: 'stack', name: 'Programming stack', value: 'Node.js + Express', category: 'stack', enabled: true },
  { id: 'security-secrets', name: 'Secrets handling', value: 'API keys and passwords are never hard-coded or sent to the browser; they come from environment variables only.', category: 'security', enabled: true, forbidden: ['hard-coded api key', 'hardcoded api key'] },
]);

export class InvariantManager {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.doc = new JsonDocument({
      dataDir, file: 'invariants.json', logger, empty: () => ({ invariants: [] }), normalize: normalizeDoc,
    });
  }

  init() {
    return this.doc.init();
  }

  get location() {
    return this.doc.location;
  }

  /** @returns {Promise<object[]>} Every invariant, in stored order. */
  async list() {
    return (await this.doc.read()).invariants;
  }

  async getActive() {
    return (await this.list()).filter((inv) => inv.enabled);
  }

  async get(id) {
    return (await this.list()).find((inv) => inv.id === id) ?? null;
  }

  async create(input) {
    const fields = validateInvariant(input, { partial: false });
    return this.doc.update((doc) => {
      if (doc.invariants.length >= LIMITS.count) throw conflict(`At most ${LIMITS.count} invariants can be stored.`, 'too_many_invariants');
      const id = fields.id ?? uniqueId(slug(fields.name), doc.invariants);
      if (doc.invariants.some((inv) => inv.id === id)) throw conflict(`An invariant with id "${id}" already exists.`, 'invariant_exists');
      const now = new Date().toISOString();
      const invariant = {
        id, name: fields.name, value: fields.value, category: fields.category ?? 'other',
        enabled: fields.enabled ?? true, forbidden: fields.forbidden ?? [], createdAt: now, updatedAt: now,
      };
      doc.invariants.push(invariant);
      this.logger.info('invariant.create', { id, category: invariant.category, enabled: invariant.enabled });
      return { doc, result: invariant };
    });
  }

  async update(id, input) {
    const fields = validateInvariant(input, { partial: true });
    if (fields.id !== undefined && fields.id !== id) throw badRequest('The id of an invariant cannot be changed.');
    return this.doc.update((doc) => {
      const index = doc.invariants.findIndex((inv) => inv.id === id);
      if (index === -1) throw notFound('Invariant not found.', 'invariant_not_found');
      const before = doc.invariants[index];
      const invariant = { ...before, ...fields, id, updatedAt: new Date().toISOString() };
      doc.invariants[index] = invariant;
      this.logger.info('invariant.update', { id, fields: Object.keys(fields), enabled: invariant.enabled });
      return { doc, result: invariant };
    });
  }

  setEnabled(id, enabled) {
    return this.update(id, { enabled });
  }

  async delete(id) {
    return this.doc.update((doc) => {
      const index = doc.invariants.findIndex((inv) => inv.id === id);
      if (index === -1) throw notFound('Invariant not found.', 'invariant_not_found');
      doc.invariants.splice(index, 1);
      this.logger.info('invariant.delete', { id });
      return { doc, result: true };
    });
  }

  /** Add the example invariants whose id is not taken yet. */
  async addExamples() {
    const added = [];
    for (const example of EXAMPLE_INVARIANTS) {
      if (await this.get(example.id)) continue;
      added.push(await this.create(example));
    }
    return added;
  }
}

function normalizeDoc(value) {
  const list = isPlainObject(value) && Array.isArray(value.invariants) ? value.invariants : [];
  const seen = new Set();
  const invariants = [];
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id)) continue;
    if (typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    seen.add(item.id);
    invariants.push({
      id: item.id,
      name: item.name.slice(0, LIMITS.name),
      value: item.value.slice(0, LIMITS.value),
      category: INVARIANT_CATEGORIES.includes(item.category) ? item.category : 'other',
      enabled: item.enabled !== false,
      forbidden: Array.isArray(item.forbidden) ? item.forbidden.filter((t) => typeof t === 'string' && t.trim()).slice(0, LIMITS.forbidden) : [],
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
    });
  }
  return { invariants };
}

/**
 * @param {unknown} input
 * @param {{partial: boolean}} options
 */
export function validateInvariant(input, { partial }) {
  if (!isPlainObject(input)) throw badRequest('The invariant must be a JSON object.', 'invalid_invariant');
  const allowed = ['id', 'name', 'value', 'category', 'enabled', 'forbidden', 'createdAt', 'updatedAt'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw badRequest(`Unknown invariant field(s): ${unknown.join(', ')}.`, 'invalid_invariant');

  const out = {};
  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || !ID.test(input.id)) {
      throw badRequest('The id must be 1-64 lowercase letters, digits, "-" or "_".', 'invalid_invariant');
    }
    out.id = input.id;
  }
  if (input.name !== undefined || !partial) out.name = requireText(input.name, 'Name', { max: LIMITS.name });
  if (input.value !== undefined || !partial) out.value = requireText(input.value, 'Rule', { max: LIMITS.value });
  if (input.category !== undefined) out.category = requireEnum(input.category, 'category', INVARIANT_CATEGORIES);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw badRequest('"enabled" must be true or false.', 'invalid_invariant');
    out.enabled = input.enabled;
  }
  if (input.forbidden !== undefined) {
    if (!Array.isArray(input.forbidden) || input.forbidden.length > LIMITS.forbidden) {
      throw badRequest(`"forbidden" must be a list of at most ${LIMITS.forbidden} terms.`, 'invalid_invariant');
    }
    out.forbidden = [...new Set(input.forbidden.map((t) => requireText(t, 'Forbidden term', { max: LIMITS.term })))];
  }
  return out;
}

function slug(text) {
  const s = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || `inv-${randomBytes(3).toString('hex')}`;
}

function uniqueId(base, existing) {
  const taken = new Set(existing.map((inv) => inv.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Active invariants as the body of the [AGENT INVARIANTS] section. */
export function formatInvariants(invariants) {
  const active = (invariants ?? []).filter((inv) => inv.enabled);
  if (!active.length) return 'No active invariants.';
  return active.map((inv) => {
    const forbidden = inv.forbidden?.length ? ` (forbidden: ${inv.forbidden.join(', ')})` : '';
    return `- [${inv.id}] ${inv.name} (${inv.category}): ${inv.value}${forbidden}`;
  }).join('\n');
}
