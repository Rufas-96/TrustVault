'use strict';
const express = require('express');
const { HttpError, isUuid, text, oneOf, dateParam, pageParam, likeContains } = require('../http');
const { requireRole } = require('../middleware');
const { transaction } = require('../db');
const { presentAuditRow } = require('../audit');
const { ROLES, createUser, publicUser } = require('../users');
const { hashPassword, passwordProblem } = require('../passwords');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Administrators operate the system: users, oversight, and narrowing access. They can see
// document metadata and the audit trail, but no route here returns file contents, and there
// is no route that lets an administrator grant access to anyone.
module.exports = function adminRoutes(ctx) {
  const { db, audit, sessions } = ctx;
  const router = express.Router();
  router.use(requireRole(audit, 'admin'));

  // ---- Overview: what is worth noticing --------------------------------------------------
  router.get('/overview', (req, res) => {
    const now = Date.now();
    const n = (sql, ...p) => db.prepare(sql).get(...p).n;
    const counts = {
      users: n('SELECT COUNT(*) AS n FROM users'),
      activeUsers: n('SELECT COUNT(*) AS n FROM users WHERE is_active = 1'),
      documents: n('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL'),
      inTrash: n('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL'),
      grants: n('SELECT COUNT(*) AS n FROM permissions'),
      auditEntries: n('SELECT COUNT(*) AS n FROM audit_log'),
      denied24h: n("SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'denied' AND ts > ?", now - DAY),
      downloads24h: n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'document.download' AND outcome = 'success' AND ts > ?", now - DAY),
      permissionChanges24h: n("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'permission.%' AND ts > ?", now - DAY),
      activeSessions: n('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', now),
    };

    const alerts = [];
    const deniedByActor = db.prepare(`SELECT actor_username AS who, COUNT(*) AS n FROM audit_log
      WHERE outcome = 'denied' AND actor_id IS NOT NULL AND ts > ? GROUP BY actor_id HAVING n >= 3 ORDER BY n DESC LIMIT 10`).all(now - DAY);
    for (const r of deniedByActor) {
      alerts.push({ severity: r.n >= 10 ? 'high' : 'medium', title: `${r.who} was refused ${r.n} times in 24 hours`, detail: 'Repeated attempts to reach documents or features outside their access.', link: `/admin-audit?actor=${encodeURIComponent(r.who)}&outcome=denied` });
    }
    const failedLogins = db.prepare(`SELECT json_extract(details, '$.username') AS who, COUNT(*) AS n FROM audit_log
      WHERE action = 'auth.login' AND outcome = 'denied' AND ts > ? GROUP BY who HAVING n >= 3 ORDER BY n DESC LIMIT 10`).all(now - DAY);
    for (const r of failedLogins) {
      alerts.push({ severity: r.n >= 10 ? 'high' : 'medium', title: `${r.n} failed sign-ins for "${r.who}" in 24 hours`, detail: 'Possible password guessing.', link: '/admin-audit?action=auth.login&outcome=denied' });
    }
    const heavy = db.prepare(`SELECT actor_username AS who, COUNT(*) AS n, COUNT(DISTINCT document_id) AS docs FROM audit_log
      WHERE action = 'document.download' AND outcome = 'success' AND ts > ? GROUP BY actor_id HAVING n >= 10 ORDER BY n DESC`).all(now - HOUR);
    for (const r of heavy) {
      alerts.push({ severity: 'medium', title: `${r.who} downloaded ${r.n} files (${r.docs} documents) in the last hour`, detail: 'Unusual download volume can indicate bulk exfiltration.', link: `/admin-audit?actor=${encodeURIComponent(r.who)}&action=document.download` });
    }
    const integrity = n("SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'failure' AND json_extract(details, '$.reason') = 'integrity_check_failed' AND ts > ?", now - 7 * DAY);
    if (integrity) alerts.push({ severity: 'high', title: `${integrity} file integrity failures in 7 days`, detail: 'A stored file did not decrypt or did not match its checksum. It was not served.', link: '/admin-audit?outcome=failure' });
    const crossSite = n("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'security.%' AND ts > ?", now - DAY);
    if (crossSite) alerts.push({ severity: 'medium', title: `${crossSite} rejected cross-site / CSRF requests in 24 hours`, detail: 'Requests that did not come from the TrustVault pages.', link: '/admin-audit?action=security.' });
    const locked = db.prepare('SELECT username FROM users WHERE locked_until > ?').all(now);
    for (const r of locked) alerts.push({ severity: 'low', title: `Account "${r.username}" is temporarily locked`, detail: 'Locked after 5 failed sign-ins; unlocks automatically after 15 minutes or on password reset.', link: '/admin-users' });
    const unreviewed = n(`SELECT COUNT(*) AS n FROM permissions p JOIN documents d ON d.id = p.document_id
      WHERE d.deleted_at IS NULL AND COALESCE(p.reviewed_at, p.granted_at) < ?`, now - 90 * DAY);
    if (unreviewed) alerts.push({ severity: 'medium', title: `${unreviewed} grants not reviewed by their owner in 90 days`, detail: 'Long-lived access is how leavers and finished contracts keep seeing files. Owners review grants on their Access reviews page.', link: '/admin-permissions' });
    const traces = n("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'trace.lookup' AND outcome = 'success' AND ts > ?", now - 7 * DAY);
    if (traces) alerts.push({ severity: 'high', title: `${traces} leaked copies traced in the last 7 days`, detail: 'Someone ran the Leak Tracer on a file and it matched a download. Review who it was.', link: '/admin-audit?action=trace.lookup' });
    const stale = n('SELECT COUNT(*) AS n FROM permissions p JOIN users u ON u.id = p.user_id WHERE u.is_active = 0');
    if (stale) alerts.push({ severity: 'low', title: `${stale} grants belong to deactivated users`, detail: 'They cannot be used (deactivated users cannot sign in), but you may want to clean them up.', link: '/admin-permissions?filter=inactive' });

    const chain = audit.verify();
    if (!chain.ok) alerts.unshift({ severity: 'high', title: 'Audit trail integrity check FAILED', detail: chain.reason, link: '/admin-audit' });

    const recentDenied = db.prepare("SELECT * FROM audit_log WHERE outcome = 'denied' ORDER BY seq DESC LIMIT 8").all().map((r) => presentAuditRow(r, { includeIp: true }));
    const recentPermissions = db.prepare("SELECT * FROM audit_log WHERE action LIKE 'permission.%' OR action LIKE 'suggestion.%' ORDER BY seq DESC LIMIT 8").all().map((r) => presentAuditRow(r, { includeIp: true }));
    const days = db.prepare(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
        SUM(outcome = 'success') AS ok, SUM(outcome = 'denied') AS denied, SUM(action = 'document.download' AND outcome = 'success') AS downloads
      FROM audit_log WHERE ts > ? GROUP BY day ORDER BY day`).all(now - 7 * DAY);

    res.json({ counts, alerts, chain, recentDenied, recentPermissions, days });
  });

  // ---- Audit log --------------------------------------------------------------------------
  function auditQuery(query) {
    const where = [];
    const params = [];
    const action = text(query.action, 'Action', { max: 60 });
    if (action) {
      if (action.endsWith('.')) { where.push("action LIKE ? ESCAPE '\\'"); params.push(`${action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
      else { where.push('action = ?'); params.push(action); }
    }
    if (query.outcome) { where.push('outcome = ?'); params.push(oneOf(query.outcome, 'Outcome', ['success', 'denied', 'failure'])); }
    const actor = text(query.actor, 'Actor', { max: 64 });
    if (actor) { where.push("(actor_username LIKE ? ESCAPE '\\' OR json_extract(details, '$.username') LIKE ? ESCAPE '\\')"); params.push(likeContains(actor), likeContains(actor)); }
    if (query.document) {
      if (!isUuid(query.document)) throw new HttpError(400, 'Document id is not valid');
      where.push('document_id = ?'); params.push(query.document);
    }
    const from = dateParam(query.from, 'From date');
    const to = dateParam(query.to, 'To date', { endOfDay: true });
    if (from !== null) { where.push('ts >= ?'); params.push(from); }
    if (to !== null) { where.push('ts <= ?'); params.push(to); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  router.get('/audit', (req, res) => {
    const { sql, params } = auditQuery(req.query);
    const page = pageParam(req.query.page);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${sql}`).get(...params).n;
    const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY seq DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
    res.json({ entries: rows.map((r) => presentAuditRow(r, { includeIp: true })), total, page, pageSize: 50 });
  });

  // CSV cells starting with = + - @ are prefixed with ' so a spreadsheet will not run them as formulas.
  const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  router.get('/audit/export.csv', (req, res) => {
    const { sql, params } = auditQuery(req.query);
    const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY seq ASC LIMIT 20000`).all(...params);
    audit.record({ req, action: 'audit.export', details: { rows: rows.length, filters: req.query } });
    const header = ['seq', 'time_utc', 'actor', 'action', 'outcome', 'document_id', 'target_user_id', 'ip', 'details', 'prev_hash', 'hash'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.seq, new Date(r.ts).toISOString(), r.actor_username, r.action, r.outcome, r.document_id, r.target_user_id, r.ip, r.details, r.prev_hash, r.hash].map(csvCell).join(','));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="trustvault-audit-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(lines.join('\r\n'));
  });

  router.post('/audit/verify', (req, res) => {
    const result = audit.verify();
    audit.record({ req, action: 'audit.verify', outcome: result.ok ? 'success' : 'failure', details: result });
    res.json(result);
  });

  // ---- Users ------------------------------------------------------------------------------
  router.get('/users', (req, res) => {
    const now = Date.now();
    const rows = db.prepare(`SELECT u.*,
        (SELECT COUNT(*) FROM documents d WHERE d.owner_id = u.id AND d.deleted_at IS NULL) AS owned,
        (SELECT COUNT(*) FROM permissions p WHERE p.user_id = u.id) AS grants,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
      FROM users u ORDER BY u.role, u.display_name`).all(now);
    res.json({
      users: rows.map((r) => ({
        ...publicUser(r), createdAt: r.created_at, lastLoginAt: r.last_login_at,
        locked: Boolean(r.locked_until && r.locked_until > now), owned: r.owned, grants: r.grants, sessions: r.sessions,
      })),
    });
  });

  router.post('/users', async (req, res) => {
    const user = await createUser(db, req.body || {});
    audit.record({ req, action: 'user.create', targetUserId: user.id, details: { username: user.username, role: user.role } });
    res.status(201).json({ user: publicUser(user) });
  });

  function targetUser(id) {
    const u = isUuid(id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : undefined;
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  }

  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1").get().n;

  // Body: { role?, isActive?, displayName? }. Any other field is ignored.
  router.patch('/users/:id', (req, res) => {
    const u = targetUser(req.params.id);
    const body = req.body || {};
    const changes = {};
    if (body.role !== undefined) changes.role = oneOf(body.role, 'Role', ROLES);
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new HttpError(400, 'isActive must be true or false');
      changes.is_active = body.isActive ? 1 : 0;
    }
    if (body.displayName !== undefined) changes.display_name = text(body.displayName, 'Display name', { min: 1, max: 80 });

    const losingAdmin = u.role === 'admin' && u.is_active === 1 && ((changes.role && changes.role !== 'admin') || changes.is_active === 0);
    if (u.id === req.user.id && losingAdmin) throw new HttpError(400, 'You cannot remove your own administrator access');
    if (losingAdmin && activeAdmins() <= 1) throw new HttpError(400, 'At least one active administrator must remain');
    const becomingAdmin = changes.role === 'admin' && u.role !== 'admin';
    if (becomingAdmin) {
      const holds = db.prepare('SELECT COUNT(*) AS n FROM permissions WHERE user_id = ?').get(u.id).n
        + db.prepare('SELECT COUNT(*) AS n FROM documents WHERE owner_id = ?').get(u.id).n;
      if (holds) throw new HttpError(400, 'This user owns or has been granted documents. Administrators hold no document access, so remove those first.');
    }

    const fields = Object.keys(changes).filter((k) => changes[k] !== u[k]);
    if (!fields.length) return res.json({ ok: true, changed: [] });
    let ended = 0;
    transaction(db, () => {
      for (const f of fields) db.prepare(`UPDATE users SET ${f} = ? WHERE id = ?`).run(changes[f], u.id); // f is from a fixed list above
      // Deactivation ends every session at once; role changes apply on the next request anyway.
      if (changes.is_active === 0) ended = sessions.destroyAllForUser(u.id);
      audit.record({
        req, action: 'user.update', targetUserId: u.id,
        details: { username: u.username, changes: Object.fromEntries(fields.map((f) => [f, { from: u[f], to: changes[f] }])), sessionsEnded: ended },
      });
    });
    res.json({ ok: true, changed: fields, sessionsEnded: ended });
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const u = targetUser(req.params.id);
    const { newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) throw new HttpError(400, problem);
    const hash = await hashPassword(newPassword);
    let ended = 0;
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hash, Date.now(), u.id);
      ended = sessions.destroyAllForUser(u.id);
      audit.record({ req, action: 'user.password_reset', targetUserId: u.id, details: { username: u.username, sessionsEnded: ended } });
    });
    res.json({ ok: true, sessionsEnded: ended });
  });

  router.post('/users/:id/logout', (req, res) => {
    const u = targetUser(req.params.id);
    const ended = sessions.destroyAllForUser(u.id, u.id === req.user.id ? req.session.id : null);
    audit.record({ req, action: 'user.sessions_revoked', targetUserId: u.id, details: { username: u.username, sessionsEnded: ended } });
    res.json({ ok: true, sessionsEnded: ended });
  });

  // ---- Documents (metadata only) -----------------------------------------------------------
  router.get('/documents', (req, res) => {
    const rows = db.prepare(`SELECT d.id, d.title, d.category, d.created_at, d.updated_at, d.deleted_at, d.current_version,
        o.username AS owner_username, o.display_name AS owner_name,
        (SELECT COUNT(*) FROM permissions p WHERE p.document_id = d.id) AS grant_count,
        (SELECT SUM(size_bytes) FROM document_versions v WHERE v.document_id = d.id) AS total_bytes,
        (SELECT COUNT(*) FROM audit_log a WHERE a.document_id = d.id AND a.action = 'document.download' AND a.outcome = 'success') AS downloads,
        (SELECT COUNT(*) FROM audit_log a WHERE a.document_id = d.id AND a.outcome = 'denied') AS denied
      FROM documents d JOIN users o ON o.id = d.owner_id ORDER BY d.updated_at DESC`).all();
    res.json({
      documents: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, createdAt: r.created_at, updatedAt: r.updated_at,
        deletedAt: r.deleted_at, versions: r.current_version, owner: { username: r.owner_username, displayName: r.owner_name },
        grantCount: r.grant_count, totalBytes: r.total_bytes, downloads: r.downloads, denied: r.denied,
      })),
    });
  });

  // ---- Permissions ------------------------------------------------------------------------
  router.get('/permissions', (req, res) => {
    const now = Date.now();
    const rows = db.prepare(`SELECT p.document_id, p.user_id, p.level, p.granted_at, p.expires_at,
        d.title, d.deleted_at, o.username AS owner_username, u.username, u.display_name, u.is_active, g.username AS granted_by
      FROM permissions p
      JOIN documents d ON d.id = p.document_id JOIN users o ON o.id = d.owner_id
      JOIN users u ON u.id = p.user_id JOIN users g ON g.id = p.granted_by
      ORDER BY p.granted_at DESC`).all();
    res.json({
      grants: rows.map((r) => ({
        documentId: r.document_id, title: r.title, documentDeleted: r.deleted_at !== null, owner: r.owner_username,
        userId: r.user_id, username: r.username, displayName: r.display_name, userActive: Boolean(r.is_active),
        level: r.level, grantedAt: r.granted_at, grantedBy: r.granted_by, expiresAt: r.expires_at,
        expired: r.expires_at !== null && r.expires_at <= now,
      })),
    });
  });

  // Administrators can take access away (e.g. someone leaves, or a grant looks wrong) but
  // never add it.
  router.delete('/permissions/:documentId/:userId', (req, res) => {
    const { documentId, userId } = req.params;
    const existing = isUuid(documentId) && isUuid(userId)
      ? db.prepare(`SELECT p.level, d.title, u.username FROM permissions p JOIN documents d ON d.id = p.document_id
          JOIN users u ON u.id = p.user_id WHERE p.document_id = ? AND p.user_id = ?`).get(documentId, userId)
      : undefined;
    if (!existing) throw new HttpError(404, 'Grant not found');
    transaction(db, () => {
      db.prepare('DELETE FROM permissions WHERE document_id = ? AND user_id = ?').run(documentId, userId);
      audit.record({
        req, action: 'permission.revoke', documentId, targetUserId: userId,
        details: { title: existing.title, grantee: existing.username, previousLevel: existing.level, byAdministrator: true },
      });
    });
    res.json({ ok: true });
  });

  return router;
};
