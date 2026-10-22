'use strict';
const express = require('express');
const multer = require('multer');
const { HttpError, text, oneOf, dateParam, pageParam, likeContains } = require('../http');
const { requireAuth, requireRole } = require('../middleware');
const { inspectUpload, contentDisposition } = require('../validation');
const { CATEGORIES, createDocument, addVersion, sha256 } = require('../documents');
const { ACCESSIBLE_SQL } = require('../authz');
const { transaction } = require('../db');
const { presentAuditRow } = require('../audit');

const PAGE_SIZE = 25;

function presentDocument(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    owner: { id: row.owner_id, username: row.owner_username, displayName: row.owner_name },
    currentVersion: row.current_version,
    fileName: row.original_name,
    extension: row.extension,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    myAccess: row.my_level,
    expiresAt: row.my_expires_at ?? null,
  };
}

module.exports = function documentRoutes(ctx) {
  const { db, audit, storage, authz, config } = ctx;
  const router = express.Router();

  const multerSingle = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 8, fieldSize: 8 * 1024, parts: 10 },
  }).single('file');

  function acceptFile(req, res, next) {
    multerSingle(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const mb = Math.round(config.maxUploadBytes / (1024 * 1024));
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const message = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than the ${mb} MB limit`
          : err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Send exactly one file in the "file" field'
          : `Upload rejected (${err.code})`;
        audit.record({ req, action: 'document.upload_rejected', outcome: 'failure', details: { reason: err.code } });
        return next(new HttpError(status, message));
      }
      next(err);
    });
  }

  // Validates the file and audits rejections (a rejected upload is worth knowing about).
  function validatedFile(req, documentId = null) {
    try {
      return inspectUpload(req.file, config.maxUploadBytes);
    } catch (err) {
      audit.record({
        req, action: 'document.upload_rejected', outcome: 'failure', documentId,
        details: { reason: err.message, file: req.file ? String(req.file.originalname).slice(0, 150) : null },
      });
      throw err;
    }
  }

  router.get('/meta/categories', requireAuth, (req, res) => res.json({ categories: CATEGORIES }));

  // ---- List and search ----------------------------------------------------------------------
  // The access filter is part of the SQL, so a document the caller cannot open never appears
  // in results, counts, or pagination totals.
  function searchDocuments(user, query) {
    const now = Date.now();
    const scope = oneOf(query.scope || 'all', 'Scope', ['all', 'mine', 'shared']);
    const where = ['d.deleted_at IS NULL', ACCESSIBLE_SQL];
    const params = [user.id, user.id, now];
    if (scope === 'mine') { where.push('d.owner_id = ?'); params.push(user.id); }
    if (scope === 'shared') { where.push('d.owner_id <> ?'); params.push(user.id); }

    const q = text(query.q, 'Search text', { max: 100 });
    if (q) {
      where.push("(d.title LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR v.original_name LIKE ? ESCAPE '\\')");
      params.push(likeContains(q), likeContains(q), likeContains(q));
    }
    const owner = text(query.owner, 'Owner', { max: 80 });
    if (owner) {
      where.push("(o.username LIKE ? ESCAPE '\\' OR o.display_name LIKE ? ESCAPE '\\')");
      params.push(likeContains(owner), likeContains(owner));
    }
    if (query.category) {
      where.push('d.category = ?');
      params.push(oneOf(query.category, 'Category', CATEGORIES));
    }
    const from = dateParam(query.from, 'From date');
    const to = dateParam(query.to, 'To date', { endOfDay: true });
    const dateColumn = query.dateField === 'created' ? 'd.created_at' : 'd.updated_at';
    if (from !== null) { where.push(`${dateColumn} >= ?`); params.push(from); }
    if (to !== null) { where.push(`${dateColumn} <= ?`); params.push(to); }

    const sorts = { updated: 'd.updated_at DESC', created: 'd.created_at DESC', title: 'd.title COLLATE NOCASE ASC' };
    const order = sorts[query.sort] || sorts.updated;
    const page = pageParam(query.page);
    const from_ = `FROM documents d
      JOIN users o ON o.id = d.owner_id
      JOIN document_versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE ${where.join(' AND ')}`;

    const total = db.prepare(`SELECT COUNT(*) AS n ${from_}`).get(...params).n;
    const rows = db.prepare(`SELECT d.*, o.username AS owner_username, o.display_name AS owner_name,
        v.original_name, v.extension, v.size_bytes,
        CASE WHEN d.owner_id = ? THEN 'owner'
             ELSE (SELECT level FROM permissions WHERE document_id = d.id AND user_id = ?) END AS my_level,
        (SELECT expires_at FROM permissions WHERE document_id = d.id AND user_id = ?) AS my_expires_at
      ${from_} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(user.id, user.id, user.id, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return { documents: rows.map(presentDocument), total, page, pageSize: PAGE_SIZE };
  }

  router.get('/documents', requireAuth, (req, res) => {
    res.json(searchDocuments(req.user, req.query));
  });

  // ---- Upload (owners only) -----------------------------------------------------------------
  router.post('/documents', requireRole(audit, 'owner'), acceptFile, (req, res) => {
    const body = req.body || {};
    const file = validatedFile(req);
    const title = text(body.title, 'Title', { max: 150 }) || file.name.replace(/\.[^.]+$/, '');
    const description = text(body.description, 'Description', { max: 1000 });
    const category = oneOf(body.category, 'Category', CATEGORIES);
    const id = createDocument(ctx, { req, owner: req.user, title, description, category, file });
    res.status(201).json({ id });
  });

  // ---- Single document ----------------------------------------------------------------------
  router.get('/documents/:id', requireAuth, (req, res) => {
    const { doc, level } = authz.authorize(req, req.params.id, 'view');
    const owner = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(doc.owner_id);
    const versions = db.prepare(`SELECT v.version, v.original_name, v.extension, v.size_bytes, v.sha256, v.created_at,
        u.display_name AS uploaded_by
      FROM document_versions v JOIN users u ON u.id = v.uploaded_by
      WHERE v.document_id = ? ORDER BY v.version DESC`).all(doc.id);
    const grant = level === 'owner' ? null
      : db.prepare('SELECT expires_at FROM permissions WHERE document_id = ? AND user_id = ?').get(doc.id, req.user.id);
    const grantCount = level === 'owner'
      ? db.prepare('SELECT COUNT(*) AS n FROM permissions WHERE document_id = ?').get(doc.id).n
      : undefined;
    audit.record({ req, action: 'document.view', documentId: doc.id, details: { title: doc.title, level } });
    res.json({
      document: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        category: doc.category,
        owner: { id: owner.id, username: owner.username, displayName: owner.display_name },
        currentVersion: doc.current_version,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        myAccess: level,
        myExpiresAt: grant ? grant.expires_at : null,
        grantCount,
        versions: versions.map((v) => ({
          version: v.version, fileName: v.original_name, extension: v.extension, sizeBytes: v.size_bytes,
          sha256: v.sha256, createdAt: v.created_at, uploadedBy: v.uploaded_by,
        })),
      },
    });
  });

  // Only title, description and category can change. Owner, ids and timestamps are never
  // taken from the request body.
  router.patch('/documents/:id', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'edit');
    const body = req.body || {};
    const changes = {};
    if (body.title !== undefined) changes.title = text(body.title, 'Title', { min: 1, max: 150 });
    if (body.description !== undefined) changes.description = text(body.description, 'Description', { max: 1000 });
    if (body.category !== undefined) changes.category = oneOf(body.category, 'Category', CATEGORIES);
    const fields = Object.keys(changes).filter((k) => changes[k] !== doc[k]);
    if (!fields.length) return res.json({ ok: true, changed: [] });
    transaction(db, () => {
      db.prepare('UPDATE documents SET title = ?, description = ?, category = ?, updated_at = ? WHERE id = ?').run(
        changes.title ?? doc.title, changes.description ?? doc.description, changes.category ?? doc.category, Date.now(), doc.id,
      );
      audit.record({
        req, action: 'document.update', documentId: doc.id,
        details: { title: changes.title ?? doc.title, changes: Object.fromEntries(fields.map((f) => [f, { from: doc[f], to: changes[f] }])) },
      });
    });
    res.json({ ok: true, changed: fields });
  });

  // Authorise BEFORE accepting the upload body, so a caller without edit access cannot even
  // make the server buffer their file.
  router.post('/documents/:id/versions', requireAuth, (req, res, next) => {
    req.authorized = authz.authorize(req, req.params.id, 'upload_version');
    next();
  }, acceptFile, (req, res) => {
    const { doc } = req.authorized;
    const file = validatedFile(req, doc.id);
    const version = addVersion(ctx, { req, doc, user: req.user, file });
    res.status(201).json({ version });
  });

  router.get('/documents/:id/download', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'download');
    const requested = req.query.version === undefined ? doc.current_version : Number.parseInt(req.query.version, 10);
    if (!Number.isInteger(requested) || requested < 1) throw new HttpError(400, 'Version must be a positive number');
    // Scoped by document id: a version number can only ever select a version of THIS document.
    const version = db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(doc.id, requested);
    if (!version) throw new HttpError(404, 'That version does not exist');

    let content;
    try {
      content = storage.read(version.storage_key, version.id);
      if (sha256(content) !== version.sha256) throw new Error('checksum mismatch');
    } catch (err) {
      audit.record({ req, action: 'document.download', outcome: 'failure', documentId: doc.id, details: { title: doc.title, version: requested, reason: 'integrity_check_failed' } });
      throw new HttpError(500, 'This file failed its integrity check and was not served. An administrator has been notified in the audit log.');
    }

    // Audit first: if the entry cannot be written, the file is not sent. No unrecorded reads.
    audit.record({ req, action: 'document.download', documentId: doc.id, details: { title: doc.title, version: requested, file: version.original_name } });
    res.set({
      'Content-Type': version.mime_type,
      'Content-Length': String(content.length),
      'Content-Disposition': contentDisposition(version.original_name),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, private',
    });
    res.end(content);
  });

  // ---- Delete, trash, restore, purge --------------------------------------------------------
  router.delete('/documents/:id', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'delete');
    transaction(db, () => {
      db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), req.user.id, doc.id);
      audit.record({ req, action: 'document.delete', documentId: doc.id, details: { title: doc.title } });
    });
    res.json({ ok: true });
  });

  router.get('/trash', requireRole(audit, 'owner'), (req, res) => {
    const rows = db.prepare(`SELECT d.id, d.title, d.category, d.deleted_at, d.current_version,
        (SELECT COUNT(*) FROM permissions p WHERE p.document_id = d.id) AS grant_count,
        (SELECT SUM(size_bytes) FROM document_versions v WHERE v.document_id = d.id) AS total_bytes
      FROM documents d WHERE d.owner_id = ? AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`).all(req.user.id);
    res.json({
      documents: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, deletedAt: r.deleted_at,
        versions: r.current_version, grantCount: r.grant_count, totalBytes: r.total_bytes,
      })),
    });
  });

  router.post('/documents/:id/restore', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'restore');
    transaction(db, () => {
      db.prepare('UPDATE documents SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?').run(Date.now(), doc.id);
      audit.record({ req, action: 'document.restore', documentId: doc.id, details: { title: doc.title } });
    });
    res.json({ ok: true });
  });

  // Permanent: removes every stored version and all grants. The audit trail keeps the history.
  router.delete('/documents/:id/purge', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'purge');
    const versions = db.prepare('SELECT storage_key FROM document_versions WHERE document_id = ?').all(doc.id);
    transaction(db, () => {
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      audit.record({ req, action: 'document.purge', documentId: doc.id, details: { title: doc.title, versionsRemoved: versions.length } });
    });
    for (const v of versions) storage.remove(v.storage_key);
    res.json({ ok: true });
  });

  // ---- Activity -----------------------------------------------------------------------------
  router.get('/documents/:id/activity', requireAuth, (req, res) => {
    const { doc } = authz.authorize(req, req.params.id, 'view_activity');
    const rows = db.prepare('SELECT * FROM audit_log WHERE document_id = ? ORDER BY seq DESC LIMIT 300').all(doc.id);
    res.json({ document: { id: doc.id, title: doc.title }, entries: rows.map((r) => presentAuditRow(r)) });
  });

  // Everything that happened to documents the caller currently owns, including refused attempts.
  router.get('/activity', requireRole(audit, 'owner'), (req, res) => {
    const page = pageParam(req.query.page);
    const where = ['a.document_id IN (SELECT id FROM documents WHERE owner_id = ?)'];
    const params = [req.user.id];
    if (req.query.outcome) { where.push('a.outcome = ?'); params.push(oneOf(req.query.outcome, 'Outcome', ['success', 'denied', 'failure'])); }
    const sql = `FROM audit_log a WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...params).n;
    const rows = db.prepare(`SELECT a.* ${sql} ORDER BY a.seq DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
    res.json({ entries: rows.map((r) => presentAuditRow(r)), total, page, pageSize: 50 });
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const u = req.user;
    const now = Date.now();
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    const stats = {
      owned: count('SELECT COUNT(*) AS n FROM documents WHERE owner_id = ? AND deleted_at IS NULL', u.id),
      sharedWithMe: count(`SELECT COUNT(*) AS n FROM permissions p JOIN documents d ON d.id = p.document_id
        WHERE p.user_id = ? AND d.deleted_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)`, u.id, now),
      grantsGiven: count(`SELECT COUNT(*) AS n FROM permissions p JOIN documents d ON d.id = p.document_id
        WHERE d.owner_id = ? AND d.deleted_at IS NULL`, u.id),
      inTrash: count('SELECT COUNT(*) AS n FROM documents WHERE owner_id = ? AND deleted_at IS NOT NULL', u.id),
      deniedOnMine: count(`SELECT COUNT(*) AS n FROM audit_log WHERE outcome = 'denied' AND ts > ?
        AND document_id IN (SELECT id FROM documents WHERE owner_id = ?)`, now - 7 * 86400000, u.id),
    };
    const recent = searchDocuments(u, { scope: 'all', sort: 'updated' }).documents.slice(0, 6);
    const activity = db.prepare(`SELECT * FROM audit_log WHERE document_id IN (SELECT id FROM documents WHERE owner_id = ?)
      ORDER BY seq DESC LIMIT 8`).all(u.id).map((r) => presentAuditRow(r));
    const expiring = db.prepare(`SELECT d.id, d.title, p.expires_at FROM permissions p JOIN documents d ON d.id = p.document_id
      WHERE p.user_id = ? AND d.deleted_at IS NULL AND p.expires_at > ? ORDER BY p.expires_at LIMIT 5`).all(u.id, now)
      .map((r) => ({ id: r.id, title: r.title, expiresAt: r.expires_at }));
    res.json({ stats, recent, activity, expiring });
  });

  return router;
};
