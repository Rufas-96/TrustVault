'use strict';
const crypto = require('node:crypto');
const { transaction } = require('./db');

const GENESIS = '0'.repeat(64);

// Append-only, hash-chained audit trail.
//  - SQLite triggers reject UPDATE and DELETE on audit_log.
//  - Each row stores HMAC(key, prev_hash + row). Editing or removing a row in the middle, or
//    rewriting history without the key, breaks the chain and verify() reports where.
//  - Every entry is also written to stdout, so the hosting platform's log is a second copy
//    held outside the database (this is what catches someone cutting off the newest rows).
function createAudit(db, key, { stdout = false } = {}) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO audit_log
    (ts, actor_id, actor_username, action, outcome, document_id, target_user_id, details, ip, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function digest(prevHash, e) {
    const canonical = JSON.stringify([
      prevHash, e.ts, e.actor_id, e.actor_username, e.action, e.outcome,
      e.document_id, e.target_user_id, e.details, e.ip,
    ]);
    return crypto.createHmac('sha256', key).update(canonical).digest('hex');
  }

  // actor defaults to the signed-in user on req. Pass actor: null for anonymous events.
  function record({ req = null, actor, action, outcome = 'success', documentId = null, targetUserId = null, details = {} }) {
    const who = actor !== undefined ? actor : (req && req.user) || null;
    const entry = {
      ts: Date.now(),
      actor_id: who ? who.id : null,
      actor_username: who ? who.username : null,
      action,
      outcome,
      document_id: documentId,
      target_user_id: targetUserId,
      details: JSON.stringify(details),
      ip: req ? req.ip || null : null,
    };
    return transaction(db, () => {
      const prev = last.get();
      const prevHash = prev ? prev.hash : GENESIS;
      const hash = digest(prevHash, entry);
      const { lastInsertRowid } = insert.run(
        entry.ts, entry.actor_id, entry.actor_username, entry.action, entry.outcome,
        entry.document_id, entry.target_user_id, entry.details, entry.ip, prevHash, hash,
      );
      const seq = Number(lastInsertRowid);
      if (stdout) console.log(JSON.stringify({ audit: seq, ts: entry.ts, action, outcome, actor: entry.actor_username, hash }));
      return seq;
    });
  }

  function verify() {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all();
    let prevHash = GENESIS;
    let expectedSeq = null;
    for (const row of rows) {
      if (expectedSeq !== null && row.seq !== expectedSeq) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: `Entries are missing before #${row.seq}` };
      }
      if (row.prev_hash !== prevHash) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: `Entry #${row.seq} does not link to the entry before it` };
      }
      if (digest(prevHash, row) !== row.hash) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: `Entry #${row.seq} was altered after it was written` };
      }
      prevHash = row.hash;
      expectedSeq = row.seq + 1;
    }
    return { ok: true, count: rows.length, headSeq: expectedSeq ? expectedSeq - 1 : 0, headHash: prevHash };
  }

  return { record, verify };
}

// Shape returned to clients. IP addresses are only included for administrators.
function presentAuditRow(row, { includeIp = false } = {}) {
  let details = {};
  try { details = JSON.parse(row.details); } catch { details = {}; }
  const out = {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor_username,
    actorId: row.actor_id,
    action: row.action,
    outcome: row.outcome,
    documentId: row.document_id,
    targetUserId: row.target_user_id,
    details,
  };
  if (includeIp) {
    out.ip = row.ip;
    out.hash = row.hash;
  }
  return out;
}

module.exports = { createAudit, presentAuditRow, GENESIS };
