'use strict';
const { HttpError, isUuid } = require('./http');

// ---------------------------------------------------------------------------------------------
// THE authorisation decision for documents. Every route that touches a single document calls
// authorize() before reading or changing anything. There is no admin bypass here: an
// administrator is treated like anyone else and holds no document access unless they own it
// (admins cannot upload, so in practice they never do).
//
// Levels a user can hold on a document: 'owner' > 'edit' > 'read' > none.
// ---------------------------------------------------------------------------------------------
const RULES = {
  view:           ['owner', 'edit', 'read'],
  download:       ['owner', 'edit', 'read'],
  edit:           ['owner', 'edit'],
  upload_version: ['owner', 'edit'],
  share:          ['owner'],   // see, grant, change and revoke permissions; act on suggestions
  view_activity:  ['owner'],
  delete:         ['owner'],   // move to trash
  restore:        ['owner'],   // only for documents in the trash
  purge:          ['owner'],   // only for documents in the trash
};
const TRASH_ACTIONS = new Set(['restore', 'purge']);

function createAuthz(db, audit) {
  const getDocument = db.prepare('SELECT * FROM documents WHERE id = ?');
  const getGrant = db.prepare('SELECT level, expires_at FROM permissions WHERE document_id = ? AND user_id = ?');

  // Reads the live permissions table on every call. Nothing is cached, which is why revoking
  // a grant (deleting the row) takes effect on the grantee's next request.
  function accessLevel(user, doc, now = Date.now()) {
    if (!user || !user.is_active || !doc) return null;
    if (doc.owner_id === user.id) return 'owner';
    const grant = getGrant.get(doc.id, user.id);
    if (!grant) return null;
    if (grant.expires_at !== null && grant.expires_at <= now) return null;
    return grant.level;
  }

  // Returns { doc, level } or throws. Refusals are written to the audit trail.
  // Callers get 404 when they hold no access (so the response does not reveal whether the
  // document exists) and 403 when they can see it but their level is too low.
  function authorize(req, documentId, action) {
    const allowed = RULES[action];
    if (!allowed) throw new Error(`Unknown document action: ${action}`); // fail closed on typos

    const doc = isUuid(documentId) ? getDocument.get(documentId) : undefined;
    const level = accessLevel(req.user, doc);

    let reason = null;
    if (!doc) reason = 'no_such_document';
    else if (!level) reason = 'no_access';
    else if (doc.deleted_at !== null && !TRASH_ACTIONS.has(action)) reason = 'document_in_trash';
    else if (!allowed.includes(level)) reason = 'insufficient_level';

    if (reason) {
      audit.record({
        req,
        action: `document.${action}`,
        outcome: 'denied',
        documentId: doc ? doc.id : null,
        details: { reason, requested: String(documentId).slice(0, 64), level: level || 'none' },
      });
      if (reason === 'insufficient_level') {
        throw new HttpError(403, `Your ${level} access does not allow this action`);
      }
      throw new HttpError(404, 'Document not found');
    }

    if (doc.deleted_at === null && TRASH_ACTIONS.has(action)) {
      throw new HttpError(409, 'Document is not in the trash');
    }
    return { doc, level };
  }

  return { authorize, accessLevel };
}

// The same access rule as accessLevel(), as SQL, for list and search queries.
// Binds: userId, userId, now. Keep the two in step: test/authz.test.js checks both.
const ACCESSIBLE_SQL = `(d.owner_id = ? OR EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.document_id = d.id AND p.user_id = ? AND (p.expires_at IS NULL OR p.expires_at > ?)))`;

module.exports = { createAuthz, RULES, ACCESSIBLE_SQL };
