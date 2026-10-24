'use strict';
// Removes one security check at a time, runs the test suite, and reports whether the tests
// noticed. A "SURVIVED" line means a check could be deleted without any test failing.
// Files are always restored, even if the run is interrupted with Ctrl+C.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const MUTANTS = [
  ['src/authz.js', 'everyone is treated as the owner', "if (doc.owner_id === user.id) return 'owner';", "return 'owner';"],
  ['src/authz.js', 'grant expiry ignored', 'if (grant.expires_at !== null && grant.expires_at <= now) return null;', ''],
  ['src/authz.js', 'trash check removed', "else if (doc.deleted_at !== null && !TRASH_ACTIONS.has(action)) reason = 'document_in_trash';", ''],
  ['src/authz.js', 'level check removed (read can edit/share)', "else if (!allowed.includes(level)) reason = 'insufficient_level';", ''],
  ['src/authz.js', 'missing grant allowed', "else if (!level) reason = 'no_access';", ''],
  ['src/authz.js', 'inactive users keep access', 'if (!user || !user.is_active || !doc) return null;', 'if (!user || !doc) return null;'],
  ['src/routes/documents.js', 'search without access filter', "const where = ['d.deleted_at IS NULL', ACCESSIBLE_SQL];\n    const params = [user.id, user.id, now];", "const where = ['d.deleted_at IS NULL'];\n    const params = [];"],
  ['src/routes/documents.js', 'version lookup not scoped to document', "WHERE document_id = ? AND version = ?').get(doc.id, requested)", "WHERE version = ? ORDER BY created_at DESC').get(requested)"],
  ['src/routes/documents.js', 'viewers can upload', "router.post('/documents', requireRole(audit, 'owner'),", "router.post('/documents', requireAuth,"],
  ['src/routes/documents.js', 'download not audited', "audit.record({ req, action: 'document.download', documentId: doc.id, details: { title: doc.title, version: requested, file: version.original_name, traceId, traced: copy.method, deliveredSha256: sha256(copy.buffer) } });", ''],
  ['src/routes/documents.js', 'downloads not stamped with a trace', 'const copy = stamp(content, version.extension, { traceId, username: req.user.username });', 'const copy = { buffer: content, method: null };'],
  ['src/routes/forensics.js', 'tracer shows other owners\' downloads', '.filter((r) => isAdmin || r.owner_id === req.user.id);', '.filter(() => true);'],
  ['src/routes/forensics.js', 'tracer open to viewers', "router.post('/trace', requireRole(audit, 'owner', 'admin'),", "router.post('/trace', requireAuth,"],
  ['src/routes/forensics.js', 'review confirm needs only view access', "authz.authorize(req, req.params.id, 'share');\n    const userId = req.params.userId;", "authz.authorize(req, req.params.id, 'view');\n    const userId = req.params.userId;"],
  ['src/routes/forensics.js', 'tracer lookups not audited', "audit.record({\n      req, action: 'trace.lookup',", "void ({\n      req, action: 'trace.lookup',"],
  ['src/routes/documents.js', 'upload type check skipped', 'return inspectUpload(req.file, config.maxUploadBytes);', 'return { buffer: req.file.buffer, name: req.file.originalname, extension: "txt", mime: "text/plain" };'],
  ['src/routes/admin.js', 'admin routes open to everyone', "router.use(requireRole(audit, 'admin'));", ''],
  ['src/routes/admin.js', 'deactivation keeps sessions', 'if (changes.is_active === 0) ended = sessions.destroyAllForUser(u.id);', ''],
  ['src/routes/sharing.js', 'grants to administrators allowed', "if (target.role === 'admin') throw new HttpError(400, 'Administrator accounts operate the system and cannot be given document access');", ''],
  ['src/routes/sharing.js', 'suggestion not scoped to document', "WHERE id = ? AND document_id = ? AND status = 'pending'\").get(suggestionId, doc.id)", "WHERE id = ? AND status = 'pending'\").get(suggestionId)"],
  ['src/routes/sharing.js', 'directory open to viewers', "router.get('/users/directory', requireRole(audit, 'owner'),", "router.get('/users/directory', requireAuth,"],
  ['src/sessions.js', 'idle timeout ignored', ' || now - row.last_seen_at > IDLE_MS', ''],
  ['src/middleware.js', 'CSRF token not checked', "if (!safeEqual(req.get('x-csrf-token') || '', req.session.csrfToken)) {", 'if (false) {'],
  ['src/routes/auth.js', 'logout leaves session alive', 'sessions.destroy(req.session.id);\n    res.clearCookie', 'res.clearCookie'],
  ['src/audit.js', 'chain not verified', "if (digest(prevHash, row) !== row.hash) {", 'if (false) {'],
];

const originals = new Map();
function restore() {
  for (const [file, text] of originals) fs.writeFileSync(file, text);
}
process.on('SIGINT', () => { restore(); process.exit(130); });

let survived = 0;
try {
  for (const [rel, label, find, replace] of MUTANTS) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    originals.set(file, text);
    if (!text.includes(find)) {
      console.log(`SKIPPED   ${label} (pattern not found in ${rel}; update this script)`);
      continue;
    }
    fs.writeFileSync(file, text.replace(find, replace));
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', 'test/**/*.test.js'], { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(file, text);
    const failed = /ℹ fail (\d+)/.exec(run.stdout);
    const n = failed ? Number(failed[1]) : (run.status === 0 ? 0 : 1);
    if (n > 0) console.log(`killed    ${label} (${n} failing test${n === 1 ? '' : 's'})`);
    else { survived += 1; console.log(`SURVIVED  ${label}`); }
  }
} finally {
  restore();
}
console.log(survived ? `\n${survived} mutant(s) survived: add tests for them.` : '\nEvery removed check was caught by at least one test.');
process.exit(survived ? 1 : 0);
