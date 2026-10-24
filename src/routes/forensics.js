'use strict';
const express = require('express');
const multer = require('multer');
const { HttpError, isUuid, text } = require('../http');
const { requireAuth, requireRole } = require('../middleware');
const { transaction } = require('../db');
const { findTraceId, TRACE_EXACT } = require('../trace');
const { sha256 } = require('../documents');
const { REVIEW_AFTER_DAYS, REVIEW_AFTER_MS, LAST_CONFIRMED_SQL } = require('../reviews');

// Leak Tracer and access reviews.
module.exports = function forensicsRoutes(ctx) {
  const { db, audit, authz, config } = ctx;
  const router = express.Router();

  // A suspected leaked copy is read into memory only to hash it and look for a trace ID.
  // It is never written to disk or kept.
  const leakUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, parts: 6 } }).single('file');
  function acceptLeak(req, res, next) {
    leakUpload(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, `Upload rejected (${err.code})`));
      next(err);
    });
  }

  // ---- Leak Tracer -----------------------------------------------------------------------
  // Who may trace: document owners (only downloads of documents they currently own) and
  // administrators (everything, including IP addresses). Viewers may not trace at all.
  // Every lookup is itself audited, matches or not.
  router.post('/trace', requireRole(audit, 'owner', 'admin'), acceptLeak, (req, res) => {
    let traceId = null;
    let fileSha = null;
    if (req.file && req.file.buffer.length) {
      fileSha = sha256(req.file.buffer);
      traceId = findTraceId(req.file.buffer);
    } else {
      const given = text((req.body || {}).traceId, 'Trace ID', { max: 20 }).toUpperCase();
      if (!TRACE_EXACT.test(given)) throw new HttpError(400, 'Enter a trace ID like TV-ABCDE-FGHJK, or drop the leaked file');
      traceId = given;
    }

    const isAdmin = req.user.role === 'admin';
    const rows = db.prepare(`SELECT a.*, d.owner_id FROM audit_log a LEFT JOIN documents d ON d.id = a.document_id
      WHERE a.action = 'document.download' AND a.outcome = 'success'
        AND (json_extract(a.details, '$.traceId') = ? OR (? IS NOT NULL AND json_extract(a.details, '$.deliveredSha256') = ?))
      ORDER BY a.seq DESC LIMIT 20`).all(traceId, fileSha, fileSha)
      // Owners only learn about copies of their own documents: no oracle over other people's files.
      .filter((r) => isAdmin || r.owner_id === req.user.id);

    const matches = rows.map((r) => {
      const d = JSON.parse(r.details);
      return {
        seq: r.seq, ts: r.ts, downloadedBy: r.actor_username, documentId: r.document_id, title: d.title, version: d.version,
        file: d.file, traceId: d.traceId, method: d.traced, exactCopy: Boolean(fileSha && d.deliveredSha256 === fileSha),
        ...(isAdmin ? { ip: r.ip } : {}),
      };
    });
    audit.record({
      req, action: 'trace.lookup', outcome: matches.length ? 'success' : 'failure',
      documentId: matches[0] ? matches[0].documentId : null,
      details: { by: req.file ? 'file' : 'trace_id', traceId, sha256: fileSha, matches: matches.length },
    });
    res.json({ traceId, sha256: fileSha, matches });
  });

  // ---- Access reviews --------------------------------------------------------------------
  router.get('/reviews', requireRole(audit, 'owner'), (req, res) => {
    const now = Date.now();
    const rows = db.prepare(`SELECT p.document_id, p.user_id, p.level, p.granted_at, p.reviewed_at, p.expires_at,
        ${LAST_CONFIRMED_SQL} AS confirmed_at, d.title, d.category, u.username, u.display_name, u.is_active
      FROM permissions p JOIN documents d ON d.id = p.document_id JOIN users u ON u.id = p.user_id
      WHERE d.owner_id = ? AND d.deleted_at IS NULL
      ORDER BY confirmed_at ASC`).all(req.user.id);
    res.json({
      reviewAfterDays: REVIEW_AFTER_DAYS,
      grants: rows.map((r) => ({
        documentId: r.document_id, title: r.title, category: r.category, userId: r.user_id, username: r.username,
        displayName: r.display_name, userActive: Boolean(r.is_active), level: r.level, grantedAt: r.granted_at,
        reviewedAt: r.reviewed_at, expiresAt: r.expires_at, expired: r.expires_at !== null && r.expires_at <= now,
        ageDays: Math.floor((now - r.confirmed_at) / 86400000), due: now - r.confirmed_at > REVIEW_AFTER_MS,
      })),
    });
  });

  // The owner confirms a grant is still needed. Revoking uses the normal permissions route.
  router.post('/documents/:id/permissions/:userId/confirm', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'share');
    const userId = req.params.userId;
    const grant = isUuid(userId)
      ? db.prepare(`SELECT p.level, u.username FROM permissions p JOIN users u ON u.id = p.user_id
          WHERE p.document_id = ? AND p.user_id = ?`).get(doc.id, userId)
      : undefined;
    if (!grant) throw new HttpError(404, 'That person does not have access');
    transaction(db, () => {
      db.prepare('UPDATE permissions SET reviewed_at = ? WHERE document_id = ? AND user_id = ?').run(Date.now(), doc.id, userId);
      audit.record({ req, action: 'permission.review', documentId: doc.id, targetUserId: userId, details: { title: doc.title, grantee: grant.username, level: grant.level, decision: 'keep' } });
    });
    res.json({ ok: true });
  });

  return router;
};
