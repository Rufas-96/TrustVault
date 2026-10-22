'use strict';
const crypto = require('node:crypto');

const IDLE_MS = 30 * 60 * 1000;          // signed out after 30 minutes without a request
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;  // and after 8 hours regardless
const TOUCH_INTERVAL_MS = 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createSessions(db) {
  const insert = db.prepare(`INSERT INTO sessions
    (id, token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // The user row is re-read on every request: a role change, deactivation or deletion of the
  // session takes effect on the very next request. Nothing about the user is cached in the cookie.
  const lookup = db.prepare(`SELECT s.id AS session_id, s.csrf_token, s.last_seen_at, s.expires_at,
      u.id, u.username, u.display_name, u.email, u.role, u.is_active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
  const removeById = db.prepare('DELETE FROM sessions WHERE id = ?');

  return {
    create(userId, { ip, userAgent }) {
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(32).toString('base64url');
      const id = crypto.randomUUID();
      const now = Date.now();
      insert.run(id, sha256(token), userId, csrf, now, now, now + ABSOLUTE_MS, ip || null, String(userAgent || '').slice(0, 200));
      return { id, token, csrf };
    },

    resolve(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const row = lookup.get(sha256(token));
      if (!row) return null;
      const now = Date.now();
      if (!row.is_active || row.expires_at <= now || now - row.last_seen_at > IDLE_MS) {
        removeById.run(row.session_id);
        return null;
      }
      if (now - row.last_seen_at > TOUCH_INTERVAL_MS) touch.run(now, row.session_id);
      return {
        session: { id: row.session_id, csrfToken: row.csrf_token },
        user: {
          id: row.id, username: row.username, display_name: row.display_name,
          email: row.email, role: row.role, is_active: row.is_active,
        },
      };
    },

    destroy(id) {
      removeById.run(id);
    },

    destroyAllForUser(userId, exceptSessionId = null) {
      return db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, exceptSessionId).changes;
    },

    listForUser(userId) {
      return db.prepare(`SELECT id, created_at, last_seen_at, expires_at, ip, user_agent
        FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`).all(userId);
    },
  };
}

module.exports = { createSessions, IDLE_MS, ABSOLUTE_MS };
