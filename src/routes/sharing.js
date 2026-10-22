'use strict';
const express = require('express');
const { HttpError, isUuid, text, oneOf, dateParam, likeContains } = require('../http');
const { requireAuth, requireRole } = require('../middleware');
const { transaction } = require('../db');
const { refreshSuggestions } = require('../suggestions');

module.exports = function sharingRoutes(ctx) {
  const { db, audit, authz } = ctx;
  const router = express.Router();

  function listGrants(documentId) {
    return db.prepare(`SELECT p.user_id, p.level, p.granted_at, p.expires_at, u.username, u.display_name, u.role, u.is_active,
        g.display_name AS granted_by
      FROM permissions p JOIN users u ON u.id = p.user_id JOIN users g ON g.id = p.granted_by
      WHERE p.document_id = ? ORDER BY u.display_name`).all(documentId).map((r) => ({
      userId: r.user_id, username: r.username, displayName: r.display_name, role: r.role,
      isActive: Boolean(r.is_active), level: r.level, grantedAt: r.granted_at, grantedBy: r.granted_by,
      expiresAt: r.expires_at, expired: r.expires_at !== null && r.expires_at <= Date.now(),
    }));
  }

  // Who a grant may go to. Checked for direct grants and for accepted suggestions alike.
  function eligibleGrantee(doc, userId) {
    const target = isUuid(userId) ? db.prepare('SELECT * FROM users WHERE id = ?').get(userId) : undefined;
    if (!target || !target.is_active) throw new HttpError(404, 'User not found or deactivated');
    if (target.id === doc.owner_id) throw new HttpError(400, 'The owner already has full access');
    if (target.role === 'admin') throw new HttpError(400, 'Administrator accounts operate the system and cannot be given document access');
    return target;
  }

  router.get('/documents/:id/permissions', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    res.json({ document: { id: doc.id, title: doc.title, category: doc.category }, grants: listGrants(doc.id) });
  });

  // Grant, or change an existing grant's level/expiry. Body: { level: 'read'|'edit', expiresOn?: 'YYYY-MM-DD' }
  router.put('/documents/:id/permissions/:userId', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const target = eligibleGrantee(doc, req.params.userId);
    const body = req.body || {};
    const level = oneOf(body.level, 'Level', ['read', 'edit']);
    const expiresAt = dateParam(body.expiresOn, 'Expiry date', { endOfDay: true });
    if (expiresAt !== null && expiresAt <= Date.now()) throw new HttpError(400, 'Expiry date must be in the future');

    const existing = db.prepare('SELECT level, expires_at FROM permissions WHERE document_id = ? AND user_id = ?').get(doc.id, target.id);
    transaction(db, () => {
      if (existing) {
        db.prepare('UPDATE permissions SET level = ?, expires_at = ?, granted_by = ?, granted_at = ? WHERE document_id = ? AND user_id = ?')
          .run(level, expiresAt, req.user.id, Date.now(), doc.id, target.id);
      } else {
        db.prepare('INSERT INTO permissions (document_id, user_id, level, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(doc.id, target.id, level, req.user.id, Date.now(), expiresAt);
      }
      audit.record({
        req, action: existing ? 'permission.update' : 'permission.grant', documentId: doc.id, targetUserId: target.id,
        details: {
          title: doc.title, grantee: target.username, level, expiresAt,
          ...(existing ? { previousLevel: existing.level, previousExpiresAt: existing.expires_at } : {}),
        },
      });
    });
    res.json({ ok: true, grants: listGrants(doc.id) });
  });

  // Revocation deletes the row. authorize() reads this table on every request, so the
  // grantee's very next request (including a download already open in another tab) is refused.
  router.delete('/documents/:id/permissions/:userId', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const userId = req.params.userId;
    const existing = isUuid(userId)
      ? db.prepare(`SELECT p.level, u.username FROM permissions p JOIN users u ON u.id = p.user_id
          WHERE p.document_id = ? AND p.user_id = ?`).get(doc.id, userId)
      : undefined;
    if (!existing) throw new HttpError(404, 'That person does not have access');
    transaction(db, () => {
      db.prepare('DELETE FROM permissions WHERE document_id = ? AND user_id = ?').run(doc.id, userId);
      audit.record({
        req, action: 'permission.revoke', documentId: doc.id, targetUserId: userId,
        details: { title: doc.title, grantee: existing.username, previousLevel: existing.level },
      });
    });
    res.json({ ok: true, grants: listGrants(doc.id) });
  });

  // ---- Suggestions: advisory only ----------------------------------------------------------
  router.get('/documents/:id/suggestions', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const rows = refreshSuggestions(ctx, req, doc);
    res.json({
      suggestions: rows.map((r) => ({ id: r.id, userId: r.user_id, username: r.username, displayName: r.display_name, reason: r.reason, score: r.score })),
    });
  });

  function pendingSuggestion(doc, suggestionId) {
    const s = isUuid(suggestionId)
      ? db.prepare("SELECT * FROM share_suggestions WHERE id = ? AND document_id = ? AND status = 'pending'").get(suggestionId, doc.id)
      : undefined;
    if (!s) throw new HttpError(404, 'Suggestion not found or already decided');
    return s;
  }

  // Accepting grants READ only. Wider access is a separate, deliberate choice by the owner.
  router.post('/documents/:id/suggestions/:sid/accept', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const s = pendingSuggestion(doc, req.params.sid);
    const target = eligibleGrantee(doc, s.user_id);
    transaction(db, () => {
      db.prepare("UPDATE share_suggestions SET status = 'accepted', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), req.user.id, s.id);
      const already = db.prepare('SELECT 1 FROM permissions WHERE document_id = ? AND user_id = ?').get(doc.id, target.id);
      audit.record({
        req, action: 'suggestion.accepted', documentId: doc.id, targetUserId: target.id,
        details: { title: doc.title, grantee: target.username, reason: s.reason, alreadyHadAccess: Boolean(already) },
      });
      if (!already) {
        db.prepare("INSERT INTO permissions (document_id, user_id, level, granted_by, granted_at, expires_at) VALUES (?, ?, 'read', ?, ?, NULL)")
          .run(doc.id, target.id, req.user.id, Date.now());
        audit.record({
          req, action: 'permission.grant', documentId: doc.id, targetUserId: target.id,
          details: { title: doc.title, grantee: target.username, level: 'read', expiresAt: null, via: 'suggestion', suggestionId: s.id },
        });
      }
    });
    res.json({ ok: true, grants: listGrants(doc.id) });
  });

  router.post('/documents/:id/suggestions/:sid/dismiss', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const s = pendingSuggestion(doc, req.params.sid);
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(s.user_id);
    transaction(db, () => {
      db.prepare("UPDATE share_suggestions SET status = 'dismissed', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), req.user.id, s.id);
      audit.record({ req, action: 'suggestion.dismissed', documentId: doc.id, targetUserId: s.user_id, details: { title: doc.title, grantee: target ? target.username : null, reason: s.reason } });
    });
    res.json({ ok: true });
  });

  // People an owner can share with. Owners only, needs 2+ characters, returns at most 10, and
  // never lists administrators. Viewers get no directory at all.
  router.get('/users/directory', requireRole(audit, 'owner'), (req, res) => {
    const q = text(req.query.q, 'Search', { max: 64 });
    if (q.length < 2) return res.json({ users: [] });
    const like = likeContains(q);
    const rows = db.prepare(`SELECT id, username, display_name, role FROM users
      WHERE is_active = 1 AND role <> 'admin' AND id <> ?
        AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
      ORDER BY display_name LIMIT 10`).all(req.user.id, like, like);
    res.json({ users: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, role: r.role })) });
  });

  return router;
};
