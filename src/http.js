'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Validates a free-text field. Returns the trimmed string ('' when optional and empty).
function text(value, field, { min = 0, max = 200 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const v = value.trim();
  if (v.length < min) throw new HttpError(400, min === 1 ? `${field} is required` : `${field} must be at least ${min} characters`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(v)) throw new HttpError(400, `${field} contains invalid characters`);
  return v;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

// Accepts YYYY-MM-DD. Returns ms at the start (or end) of that UTC day, or null when empty.
function dateParam(value, field, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  const ms = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (Number.isNaN(ms)) throw new HttpError(400, `${field} is not a valid date`);
  return ms;
}

function pageParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 1;
}

// Escapes % and _ so user input in a LIKE pattern is matched literally (used with ESCAPE '\').
function likeContains(value) {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

module.exports = { HttpError, isUuid, text, oneOf, dateParam, pageParam, likeContains };
