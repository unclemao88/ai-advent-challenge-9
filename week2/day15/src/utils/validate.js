import { badRequest } from './errors.js';

/** Small, explicit input validators. Each throws a 400 AppError with a readable message. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TASK_ID = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireObject(value, what = 'The request body') {
  if (!isPlainObject(value)) throw badRequest(`${what} must be a JSON object.`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name Field name used in the message.
 * @param {{min?: number, max: number, optional?: boolean}} limits
 * @returns {string|undefined} The trimmed string.
 */
export function requireText(value, name, { min = 1, max, optional = false }) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw badRequest(`${name} is required.`);
  }
  if (typeof value !== 'string') throw badRequest(`${name} must be text.`);
  const text = value.replace(/\r\n/g, '\n').trim();
  // Control characters other than tab and newline have no place in any field.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw badRequest(`${name} contains control characters.`);
  }
  if (text.length < min) throw badRequest(min === 1 ? `${name} must not be empty.` : `${name} is too short.`);
  if (text.length > max) throw badRequest(`${name} is too long (maximum ${max} characters).`);
  return text;
}

export function requireEnum(value, name, allowed, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!allowed.includes(value)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}.`);
  return value;
}

export function requireInt(value, name, { min, max, optional = false }) {
  if (value === undefined && optional) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) throw badRequest('Invalid task id.', 'invalid_task_id');
  return value;
}

export function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw badRequest(`Invalid ${name}.`);
  return value;
}

export function requireRecordId(value, name = 'id') {
  if (typeof value !== 'string' || !RECORD_ID.test(value)) throw badRequest(`Invalid ${name}.`);
  return value;
}

/** Reject fields the endpoint does not know, so typos are not silently ignored. */
export function rejectUnknownFields(body, allowed, what = 'The request') {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw badRequest(`${what} has unknown field(s): ${unknown.join(', ')}.`);
}

/** Cap a free-text value from an untrusted source (the model) without throwing. */
export function clip(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
