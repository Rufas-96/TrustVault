'use strict';
const express = require('express');
const { HttpError, isUuid } = require('../http');
const { verifyPassword, dummyVerify, hashPassword, passwordProblem } = require('../passwords');
const { requireAuth, rateLimit } = require('../middleware');
const { publicUser } = require('../users');
const { ABSOLUTE_MS } = require('../sessions');

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// One message for every failure, so the response never says whether a username exists.
const LOGIN_FAILED = 'Invalid username or password, or the account is temporarily locked.';

module.exports = function authRoutes(ctx) {
  const { db, audit, sessions, config } = ctx;
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.loginRateLimit,
    message: 'Too many sign-in attempts from this address. Try again in a few minutes.',
  });

  const cookieOptions = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' };

  router.post('/auth/login', loginLimiter, async (req, res) => {
    // JSON only: a cross-site HTML form cannot send application/json without a CORS preflight.
    if (!req.is('application/json')) throw new HttpError(415, 'Send credentials as JSON');
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password
      || username.length > 64 || password.length > 200) {
      throw new HttpError(400, 'Username and password are required');
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    const now = Date.now();
    const locked = Boolean(user && user.locked_until && user.locked_until > now);
    const passwordOk = user ? await verifyPassword(password, user.password_hash) : await dummyVerify(password);

    if (!user || locked || !passwordOk || !user.is_active) {
      let lockedNow = false;
      if (user && !locked && !passwordOk) {
        const failed = user.failed_logins + 1;
        lockedNow = failed >= MAX_FAILED_LOGINS;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .run(lockedNow ? 0 : failed, lockedNow ? now + LOCKOUT_MS : null, user.id);
      }
      const reason = !user ? 'unknown_user' : locked ? 'account_locked' : !passwordOk ? 'wrong_password' : 'account_disabled';
      audit.record({
        req, actor: null, action: 'auth.login', outcome: 'denied', targetUserId: user ? user.id : null,
        details: { username: username.trim().slice(0, 64), reason, lockedNow },
      });
      throw new HttpError(401, LOGIN_FAILED);
    }

    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, user.id);
    if (req.session) sessions.destroy(req.session.id); // never carry an old session across a login
    const session = sessions.create(user.id, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(config.cookieName, session.token, { ...cookieOptions, maxAge: ABSOLUTE_MS });
    audit.record({ req, actor: user, action: 'auth.login', details: { session: session.id.slice(0, 8) } });
    res.json({ user: publicUser(user), csrfToken: session.csrf });
  });

  router.post('/auth/logout', requireAuth, (req, res) => {
    sessions.destroy(req.session.id);
    res.clearCookie(config.cookieName, cookieOptions);
    audit.record({ req, action: 'auth.logout' });
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), csrfToken: req.session.csrfToken });
  });

  router.post('/auth/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword) throw new HttpError(400, 'Current password is required');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      audit.record({ req, action: 'auth.password_change', outcome: 'denied', details: { reason: 'wrong_current_password' } });
      throw new HttpError(400, 'Current password is incorrect');
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(400, problem);
    if (newPassword === currentPassword) throw new HttpError(400, 'Choose a password you have not just used');
    const hash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, Date.now(), req.user.id);
    const ended = sessions.destroyAllForUser(req.user.id, req.session.id);
    audit.record({ req, action: 'auth.password_change', details: { otherSessionsEnded: ended } });
    res.json({ ok: true, otherSessionsEnded: ended });
  });

  router.get('/auth/sessions', requireAuth, (req, res) => {
    const list = sessions.listForUser(req.user.id).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.id === req.session.id,
    }));
    res.json({ sessions: list });
  });

  router.delete('/auth/sessions/:id', requireAuth, (req, res) => {
    const id = req.params.id;
    // Scoped to the caller's own sessions: another user's session id simply matches nothing.
    const changes = isUuid(id)
      ? db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, req.user.id).changes
      : 0;
    if (!changes) throw new HttpError(404, 'Session not found');
    audit.record({ req, action: 'auth.session_revoke', details: { session: id.slice(0, 8) } });
    res.json({ ok: true });
  });

  return router;
};
