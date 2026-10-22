'use strict';
const crypto = require('node:crypto');

// Sharing suggestions. This is a transparent rule, not a language model: people who already
// hold a live grant on the owner's other documents are suggested, ranked higher when those
// documents share this one's category. A suggestion is only a row in share_suggestions;
// nothing is granted until the owner accepts it, and both steps are audited.
function computeCandidates(db, doc, now = Date.now()) {
  return db.prepare(`
    SELECT p.user_id, u.username, u.display_name,
           SUM(CASE WHEN d.category = ? THEN 2 ELSE 1 END) AS score,
           SUM(CASE WHEN d.category = ? THEN 1 ELSE 0 END) AS same_category,
           COUNT(*) AS total
    FROM permissions p
    JOIN documents d ON d.id = p.document_id
    JOIN users u ON u.id = p.user_id
    WHERE d.owner_id = ? AND d.id <> ? AND d.deleted_at IS NULL
      AND u.is_active = 1 AND u.role <> 'admin' AND u.id <> ?
      AND (p.expires_at IS NULL OR p.expires_at > ?)
      AND p.user_id NOT IN (SELECT user_id FROM permissions WHERE document_id = ?)
      AND p.user_id NOT IN (SELECT user_id FROM share_suggestions WHERE document_id = ?)
    GROUP BY p.user_id
    ORDER BY score DESC, u.display_name
    LIMIT 5`).all(doc.category, doc.category, doc.owner_id, doc.id, doc.owner_id, now, doc.id, doc.id);
}

function reasonFor(candidate, doc) {
  if (candidate.same_category > 0) {
    const n = candidate.same_category;
    return `Already has access to ${n} other ${doc.category} document${n === 1 ? '' : 's'} you own`;
  }
  const n = candidate.total;
  return `Already has access to ${n} other document${n === 1 ? '' : 's'} you own`;
}

// Stores any new candidates as pending suggestions and returns the ones still pending.
function refreshSuggestions(ctx, req, doc) {
  const { db, audit } = ctx;
  const now = Date.now();
  const created = [];
  for (const c of computeCandidates(db, doc, now)) {
    const id = crypto.randomUUID();
    const reason = reasonFor(c, doc);
    db.prepare(`INSERT INTO share_suggestions (id, document_id, user_id, reason, score, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, doc.id, c.user_id, reason, c.score, now);
    created.push({ suggestionId: id, username: c.username, reason });
  }
  if (created.length) {
    audit.record({ req, action: 'suggestion.generated', documentId: doc.id, details: { title: doc.title, suggestions: created } });
  }
  return db.prepare(`SELECT s.id, s.reason, s.score, s.created_at, u.id AS user_id, u.username, u.display_name
    FROM share_suggestions s JOIN users u ON u.id = s.user_id
    WHERE s.document_id = ? AND s.status = 'pending' AND u.is_active = 1
      AND s.user_id NOT IN (SELECT user_id FROM permissions WHERE document_id = ?)
    ORDER BY s.score DESC, u.display_name`).all(doc.id, doc.id);
}

module.exports = { refreshSuggestions, computeCandidates };
