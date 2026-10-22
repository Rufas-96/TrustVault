'use strict';
const crypto = require('node:crypto');
const { HttpError, text, oneOf } = require('./http');
const { hashPassword, passwordProblem } = require('./passwords');

const ROLES = ['admin', 'owner', 'viewer'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function validateNewUser(input) {
  const username = text(input.username, 'Username', { min: 3, max: 32 });
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username may contain letters, numbers, dot, dash and underscore');
  const displayName = text(input.displayName, 'Display name', { min: 1, max: 80 });
  const email = text(input.email, 'Email', { min: 3, max: 254 });
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email address is not valid');
  const role = oneOf(input.role, 'Role', ROLES);
  const problem = passwordProblem(input.password);
  if (problem) throw new HttpError(400, problem);
  return { username, displayName, email, role, password: input.password };
}

// Hashes first (async), then inserts (sync). Returns the new user row.
async function createUser(db, input) {
  const u = validateNewUser(input);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) {
    throw new HttpError(409, 'That username is already taken');
  }
  const passwordHash = await hashPassword(u.password);
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, username, display_name, email, role, password_hash, password_changed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, u.username, u.displayName, u.email, u.role, passwordHash, now, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// Never returns the password hash or lockout internals.
function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active),
  };
}

module.exports = { ROLES, createUser, publicUser };
