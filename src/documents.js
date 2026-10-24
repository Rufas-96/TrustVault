'use strict';
const crypto = require('node:crypto');
const { transaction } = require('./db');

const CATEGORIES = ['HR', 'Legal', 'Finance', 'Engineering', 'Audit', 'Sales', 'General'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Writes the encrypted blob, then the database rows and the audit entry in one transaction.
// If the transaction fails the blob is removed, so there are no orphaned files.
function createDocument(ctx, { req, owner, title, description, category, file }) {
  const { db, storage, audit } = ctx;
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const storageKey = storage.save(file.buffer, versionId);
  const now = Date.now();
  try {
    transaction(db, () => {
      db.prepare(`INSERT INTO documents (id, title, description, category, owner_id, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(documentId, title, description, category, owner.id, now, now);
      insertVersion(db, { versionId, documentId, version: 1, file, storageKey, userId: owner.id, now });
      audit.record({
        req, actor: owner, action: 'document.upload', documentId,
        details: { title, category, file: file.name, size: file.buffer.length, sha256: sha256(file.buffer) },
      });
    });
  } catch (err) {
    storage.remove(storageKey);
    throw err;
  }
  return documentId;
}

function addVersion(ctx, { req, doc, user, file }) {
  const { db, storage, audit } = ctx;
  const versionId = crypto.randomUUID();
  const storageKey = storage.save(file.buffer, versionId);
  const now = Date.now();
  try {
    return transaction(db, () => {
      // Re-read inside the transaction so two simultaneous uploads cannot take the same number.
      const { current_version: current } = db.prepare('SELECT current_version FROM documents WHERE id = ?').get(doc.id);
      const version = current + 1;
      insertVersion(db, { versionId, documentId: doc.id, version, file, storageKey, userId: user.id, now });
      db.prepare('UPDATE documents SET current_version = ?, updated_at = ? WHERE id = ?').run(version, now, doc.id);
      audit.record({
        req, actor: user, action: 'document.version_upload', documentId: doc.id,
        details: { title: doc.title, version, file: file.name, size: file.buffer.length, sha256: sha256(file.buffer) },
      });
      return version;
    });
  } catch (err) {
    storage.remove(storageKey);
    throw err;
  }
}

function insertVersion(db, { versionId, documentId, version, file, storageKey, userId, now }) {
  db.prepare(`INSERT INTO document_versions
    (id, document_id, version, original_name, extension, mime_type, size_bytes, sha256, storage_key, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    versionId, documentId, version, file.name, file.extension, file.mime,
    file.buffer.length, sha256(file.buffer), storageKey, userId, now,
  );
}

module.exports = { CATEGORIES, createDocument, addVersion, sha256 };
