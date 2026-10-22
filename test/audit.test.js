'use strict';
// The audit trail records who reached what (including refusals) and resists alteration.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, samplePdf } = require('./helpers');

let h; let alice; let carol; let bob; let admin; let users;

before(async () => {
  h = await startServer();
  users = {
    alice: await h.user('alice', 'owner'),
    bob: await h.user('bob', 'owner'),
    carol: await h.user('carol', 'viewer'),
    admin: await h.user('admin', 'admin'),
  };
  alice = await h.client('alice');
  bob = await h.client('bob');
  carol = await h.client('carol');
  admin = await h.client('admin');
});
after(() => h.close());

const entries = (where, ...params) => h.ctx.db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY seq`).all(...params);

async function newDoc(title = 'Audited') {
  return (await alice.upload(samplePdf(title), { title, category: 'Legal' })).body.id;
}

test('upload, view, download, change, permission changes and delete are all recorded (T-20)', async () => {
  const id = await newDoc();
  await alice.put(`/api/documents/${id}/permissions/${users.carol.id}`, { level: 'read' });
  await carol.get(`/api/documents/${id}`);
  await carol.get(`/api/documents/${id}/download`);
  await alice.patch(`/api/documents/${id}`, { title: 'Renamed' });
  await alice.put(`/api/documents/${id}/permissions/${users.carol.id}`, { level: 'edit' });
  await alice.del(`/api/documents/${id}/permissions/${users.carol.id}`);
  await alice.del(`/api/documents/${id}`);
  const actions = entries('document_id = ?', id).map((e) => `${e.actor_username}:${e.action}:${e.outcome}`);
  assert.deepEqual(actions, [
    'alice:document.upload:success',
    'alice:permission.grant:success',
    'carol:document.view:success',
    'carol:document.download:success',
    'alice:document.update:success',
    'alice:permission.update:success',
    'alice:permission.revoke:success',
    'alice:document.delete:success',
  ]);
});

test('refused attempts are recorded with who tried and what they tried (T-21)', async () => {
  const id = await newDoc();
  await bob.get(`/api/documents/${id}/download`);
  await bob.del(`/api/documents/${id}`);
  const denied = entries("document_id = ? AND outcome = 'denied'", id);
  assert.equal(denied.length, 2);
  assert.equal(denied[0].actor_username, 'bob');
  assert.equal(denied[0].action, 'document.download');
  assert.equal(JSON.parse(denied[0].details).reason, 'no_access');
  assert.equal(denied[1].action, 'document.delete');
});

test('refused attempts after revocation are recorded', async () => {
  const id = await newDoc();
  await alice.put(`/api/documents/${id}/permissions/${users.carol.id}`, { level: 'read' });
  await alice.del(`/api/documents/${id}/permissions/${users.carol.id}`);
  await carol.get(`/api/documents/${id}/download`);
  const last = entries('document_id = ?', id).pop();
  assert.equal(last.actor_username, 'carol');
  assert.equal(last.outcome, 'denied');
});

test('failed sign-ins and role refusals are recorded', async () => {
  const anon = await h.client();
  await anon.post('/api/auth/login', { username: 'alice', password: 'wrong-password-1' });
  await carol.get('/api/admin/audit');
  assert.ok(entries("action = 'auth.login' AND outcome = 'denied' AND json_extract(details, '$.username') = 'alice'").length >= 1);
  assert.ok(entries("action = 'access.role_denied' AND actor_username = 'carol'").length >= 1);
});

test('the database refuses UPDATE and DELETE on audit_log (T-22)', () => {
  assert.throws(() => h.ctx.db.prepare("UPDATE audit_log SET actor_username = 'nobody'").run(), /append-only/);
  assert.throws(() => h.ctx.db.prepare('DELETE FROM audit_log').run(), /append-only/);
});

test('the hash chain verifies, and detects an edited entry (T-23)', async () => {
  await newDoc();
  assert.equal(h.ctx.audit.verify().ok, true);
  const res = await admin.post('/api/admin/audit/verify');
  assert.equal(res.body.ok, true);

  // Simulate an attacker with raw database access: drop the trigger, change one row.
  const db = h.ctx.db;
  const target = db.prepare("SELECT seq FROM audit_log WHERE action = 'document.download' LIMIT 1").get().seq;
  db.exec('DROP TRIGGER audit_log_no_update');
  db.prepare("UPDATE audit_log SET actor_username = 'someone-else' WHERE seq = ?").run(target);
  const result = h.ctx.audit.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, target);

  // Put it back so later tests see a clean chain, and restore the trigger.
  db.prepare("UPDATE audit_log SET actor_username = 'carol' WHERE seq = ?").run(target);
  db.exec("CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;");
  assert.equal(h.ctx.audit.verify().ok, true);
});

test('the hash chain detects a deleted entry in the middle', async () => {
  const h2 = await startServer();
  try {
    for (let i = 0; i < 5; i += 1) h2.ctx.audit.record({ actor: null, action: 'test.event', details: { i } });
    h2.ctx.db.exec('DROP TRIGGER audit_log_no_delete');
    h2.ctx.db.prepare('DELETE FROM audit_log WHERE seq = 3').run();
    const result = h2.ctx.audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 4);
  } finally {
    await h2.close();
  }
});

test('rewriting the chain without the HMAC key is detected', async () => {
  const h2 = await startServer();
  try {
    for (let i = 0; i < 3; i += 1) h2.ctx.audit.record({ actor: null, action: 'test.event', details: { i } });
    const crypto = require('node:crypto');
    const db = h2.ctx.db;
    db.exec('DROP TRIGGER audit_log_no_update');
    // Attacker recomputes hashes with plain SHA-256 because they do not have the key.
    let prev = '0'.repeat(64);
    for (const row of db.prepare('SELECT * FROM audit_log ORDER BY seq').all()) {
      const details = row.seq === 2 ? '{"i":"forged"}' : row.details;
      const hash = crypto.createHash('sha256').update(prev + details).digest('hex');
      db.prepare('UPDATE audit_log SET details = ?, prev_hash = ?, hash = ? WHERE seq = ?').run(details, prev, hash, row.seq);
      prev = hash;
    }
    assert.equal(h2.ctx.audit.verify().ok, false);
  } finally {
    await h2.close();
  }
});

test('owners see activity only for their own documents; viewers see none (T-24)', async () => {
  const id = await newDoc();
  const bobDoc = (await bob.upload(samplePdf(), { title: 'Bob only', category: 'Legal' })).body.id;
  const res = await alice.get('/api/activity');
  assert.equal(res.status, 200);
  assert.ok(res.body.entries.some((e) => e.documentId === id));
  assert.ok(!res.body.entries.some((e) => e.documentId === bobDoc));
  assert.ok(res.body.entries.every((e) => e.ip === undefined), 'owners do not see IP addresses');
  assert.equal((await carol.get('/api/activity')).status, 403);
  assert.equal((await alice.get(`/api/documents/${bobDoc}/activity`)).status, 404);
});

test('CSV export neutralises spreadsheet formulas (T-25)', async () => {
  // Usernames cannot start with "=", so write a hostile cell value straight into the log.
  h.ctx.audit.record({ actor: { id: 'x', username: '=HYPERLINK("http://evil","click")' }, action: 'test.csv' });
  const res = await admin.get('/api/admin/audit/export.csv');
  assert.equal(res.status, 200);
  const text = res.raw.toString('utf8');
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""click"")"`));
  for (const line of text.split('\r\n')) {
    assert.ok(!/(^|,)"[=+\-@]/.test(line), `formula cell in: ${line.slice(0, 80)}`);
  }
});
