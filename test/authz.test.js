'use strict';
// One user cannot reach another user's documents, through any route.
// Each test names the THREATS.md entry it covers (T-xx).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, samplePdf, sampleTxt } = require('./helpers');

let h; let alice; let bob; let carol; let dave; let admin;
let users;

before(async () => {
  h = await startServer();
  users = {
    alice: await h.user('alice', 'owner'),
    bob: await h.user('bob', 'owner'),
    carol: await h.user('carol', 'viewer'),
    dave: await h.user('dave', 'viewer'),
    admin: await h.user('admin', 'admin'),
  };
  alice = await h.client('alice');
  bob = await h.client('bob');
  carol = await h.client('carol');
  dave = await h.client('dave');
  admin = await h.client('admin');
});
after(() => h.close());

async function newDoc(owner = alice, title = 'Private doc') {
  const res = await owner.upload(samplePdf(`secret ${title}`), { title, category: 'HR' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}
const grant = (owner, docId, user, level, extra = {}) =>
  owner.put(`/api/documents/${docId}/permissions/${users[user].id}`, { level, ...extra });

// Every route that acts on one document, with what a stranger would send.
function documentRoutes(id) {
  const form = new FormData();
  form.append('file', new Blob([samplePdf().buffer]), 'x.pdf');
  return [
    ['GET', `/api/documents/${id}`],
    ['GET', `/api/documents/${id}/download`],
    ['GET', `/api/documents/${id}/download?version=1`],
    ['PATCH', `/api/documents/${id}`, { json: { title: 'hacked' } }],
    ['POST', `/api/documents/${id}/versions`, { form }],
    ['DELETE', `/api/documents/${id}`],
    ['POST', `/api/documents/${id}/restore`],
    ['DELETE', `/api/documents/${id}/purge`],
    ['GET', `/api/documents/${id}/activity`],
    ['GET', `/api/documents/${id}/permissions`],
    ['PUT', `/api/documents/${id}/permissions/${users.carol.id}`, { json: { level: 'edit' } }],
    ['DELETE', `/api/documents/${id}/permissions/${users.carol.id}`],
    ['GET', `/api/documents/${id}/suggestions`],
  ];
}

describe('strangers (T-01 IDOR)', () => {
  test('another owner cannot reach a document through any route', async () => {
    const id = await newDoc();
    for (const [method, url, opts] of documentRoutes(id)) {
      const res = await bob.request(method, url, opts || {});
      assert.ok([403, 404].includes(res.status), `${method} ${url} returned ${res.status}`);
      assert.ok(!res.raw.includes('secret'), `${method} ${url} leaked content`);
    }
    // and nothing changed
    const own = await alice.get(`/api/documents/${id}`);
    assert.equal(own.body.document.title, 'Private doc');
    assert.equal(own.body.document.currentVersion, 1);
  });

  test('a viewer with no grant gets 404 (not 403), so existence is not revealed (T-02)', async () => {
    const id = await newDoc();
    assert.equal((await carol.get(`/api/documents/${id}`)).status, 404);
    assert.equal((await carol.get('/api/documents/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await carol.get('/api/documents/not-a-uuid')).status, 404);
  });

  test('an administrator cannot read or download document contents (T-12)', async () => {
    const id = await newDoc();
    assert.equal((await admin.get(`/api/documents/${id}`)).status, 404);
    assert.equal((await admin.get(`/api/documents/${id}/download`)).status, 404);
    const meta = await admin.get('/api/admin/documents');
    assert.equal(meta.status, 200);
    assert.ok(!meta.raw.includes('secret'));
  });

  test('unauthenticated requests are refused everywhere (T-03)', async () => {
    const id = await newDoc();
    const anon = await h.client();
    for (const [method, url, opts] of documentRoutes(id)) {
      const res = await anon.request(method, url, opts || {});
      assert.equal(res.status, 401, `${method} ${url} returned ${res.status}`);
    }
    assert.equal((await anon.get('/api/documents')).status, 401);
    assert.equal((await anon.get('/api/admin/audit')).status, 401);
  });
});

describe('listing and search do not leak (T-04)', () => {
  test('search by title, owner and category returns only accessible documents', async () => {
    const id = await newDoc(alice, 'Zebra merger plan');
    for (const q of ['?q=Zebra', '?owner=alice', '?category=HR', '?scope=shared', '?scope=all&q=merger']) {
      const res = await bob.get(`/api/documents${q}`);
      assert.equal(res.status, 200);
      assert.ok(!res.body.documents.some((d) => d.id === id), `bob saw it via ${q}`);
      assert.ok(!res.raw.includes('Zebra'), `title leaked via ${q}`);
    }
    const mine = await alice.get('/api/documents?q=Zebra');
    assert.ok(mine.body.documents.some((d) => d.id === id));
  });

  test('LIKE wildcards in search are treated literally', async () => {
    await newDoc(alice, 'Wildcard test');
    const res = await bob.get('/api/documents?q=%25');
    assert.equal(res.body.total, 0);
  });

  test('search shows a granted document, then stops showing it after revoke', async () => {
    const id = await newDoc(alice, 'Quokka report');
    await grant(alice, id, 'carol', 'read');
    assert.ok((await carol.get('/api/documents?q=Quokka')).body.documents.some((d) => d.id === id));
    await alice.del(`/api/documents/${id}/permissions/${users.carol.id}`);
    assert.equal((await carol.get('/api/documents?q=Quokka')).body.total, 0);
  });

  test('expired grants disappear from search', async () => {
    const id = await newDoc(alice, 'Narwhal memo');
    await grant(alice, id, 'carol', 'read');
    h.ctx.db.prepare('UPDATE permissions SET expires_at = ? WHERE document_id = ?').run(Date.now() - 1000, id);
    assert.equal((await carol.get('/api/documents?q=Narwhal')).body.total, 0);
  });
});

describe('read and edit grants (T-05)', () => {
  test('read grant: can view and download, nothing else', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    assert.equal((await carol.get(`/api/documents/${id}`)).status, 200);
    const dl = await carol.get(`/api/documents/${id}/download`);
    assert.equal(dl.status, 200);
    assert.ok(dl.raw.includes('secret'));
    assert.equal((await carol.patch(`/api/documents/${id}`, { title: 'x' })).status, 403);
    assert.equal((await carol.uploadVersion(id, samplePdf())).status, 403);
    assert.equal((await carol.del(`/api/documents/${id}`)).status, 403);
    assert.equal((await carol.get(`/api/documents/${id}/permissions`)).status, 403);
    assert.equal((await carol.get(`/api/documents/${id}/activity`)).status, 403);
    assert.equal((await grant(carol, id, 'dave', 'read')).status, 403);
  });

  test('edit grant: can edit and add versions, cannot delete or share (T-06)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'dave', 'edit');
    assert.equal((await dave.patch(`/api/documents/${id}`, { title: 'Redlined' })).status, 200);
    assert.equal((await dave.uploadVersion(id, samplePdf('v2'))).status, 201);
    assert.equal((await dave.del(`/api/documents/${id}`)).status, 403);
    assert.equal((await grant(dave, id, 'carol', 'edit')).status, 403);
    assert.equal((await dave.put(`/api/documents/${id}/permissions/${users.dave.id}`, { level: 'edit' })).status, 403);
    assert.equal((await dave.del(`/api/documents/${id}/permissions/${users.dave.id}`)).status, 403);
    const doc = await alice.get(`/api/documents/${id}`);
    assert.equal(doc.body.document.title, 'Redlined');
    assert.equal(doc.body.document.currentVersion, 2);
  });

  test('PATCH ignores fields other than title/description/category (T-07 mass assignment)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'dave', 'edit');
    await dave.patch(`/api/documents/${id}`, { owner_id: users.dave.id, ownerId: users.dave.id, deleted_at: 1, title: 'ok' });
    const row = h.ctx.db.prepare('SELECT owner_id, deleted_at FROM documents WHERE id = ?').get(id);
    assert.equal(row.owner_id, users.alice.id);
    assert.equal(row.deleted_at, null);
    assert.equal((await dave.del(`/api/documents/${id}`)).status, 403);
  });
});

describe('revocation is immediate (T-08)', () => {
  test('the same session is refused on its very next request', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    assert.equal((await carol.get(`/api/documents/${id}/download`)).status, 200);
    const revoke = await alice.del(`/api/documents/${id}/permissions/${users.carol.id}`);
    assert.equal(revoke.status, 200);
    assert.equal((await carol.get(`/api/documents/${id}/download`)).status, 404);
    assert.equal((await carol.get(`/api/documents/${id}`)).status, 404);
  });

  test('downgrading edit to read takes effect immediately', async () => {
    const id = await newDoc();
    await grant(alice, id, 'dave', 'edit');
    assert.equal((await dave.patch(`/api/documents/${id}`, { title: 'one' })).status, 200);
    await grant(alice, id, 'dave', 'read');
    assert.equal((await dave.patch(`/api/documents/${id}`, { title: 'two' })).status, 403);
  });

  test('an expired grant stops working without anyone revoking it (T-09)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    h.ctx.db.prepare('UPDATE permissions SET expires_at = ? WHERE document_id = ? AND user_id = ?').run(Date.now() - 1, id, users.carol.id);
    assert.equal((await carol.get(`/api/documents/${id}/download`)).status, 404);
  });

  test('deactivating a user ends their session at once (T-10)', async () => {
    const temp = await h.user('leaver', 'viewer');
    const leaver = await h.client('leaver');
    const id = await newDoc();
    await alice.put(`/api/documents/${id}/permissions/${temp.id}`, { level: 'read' });
    assert.equal((await leaver.get(`/api/documents/${id}/download`)).status, 200);
    assert.equal((await admin.patch(`/api/admin/users/${temp.id}`, { isActive: false })).status, 200);
    assert.equal((await leaver.get(`/api/documents/${id}/download`)).status, 401);
    const again = await h.client();
    assert.equal((await again.post('/api/auth/login', { username: 'leaver', password: 'TestPassw0rd!' })).status, 401);
  });

  test('reactivating a user does not bring their old sessions back (T-10)', async () => {
    const temp = await h.user('returner', 'viewer');
    const old = await h.client('returner');
    await admin.patch(`/api/admin/users/${temp.id}`, { isActive: false });
    assert.equal(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(temp.id).n, 0);
    await admin.patch(`/api/admin/users/${temp.id}`, { isActive: true });
    assert.equal((await old.get('/api/auth/me')).status, 401, 'a cookie from before deactivation must stay dead');
  });

  test('authorize() itself refuses a deactivated user, not only the session layer (defence in depth)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    const doc = h.ctx.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    const inactiveCarol = { ...users.carol, is_active: 0 };
    assert.equal(h.ctx.authz.accessLevel({ ...users.carol, is_active: 1 }, doc), 'read');
    assert.equal(h.ctx.authz.accessLevel(inactiveCarol, doc), null);
    assert.equal(h.ctx.authz.accessLevel({ ...users.alice, is_active: 0 }, doc), null);
  });

  test('administrator revoke works; there is no administrator grant route (T-12)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    assert.equal((await admin.del(`/api/admin/permissions/${id}/${users.carol.id}`)).status, 200);
    assert.equal((await carol.get(`/api/documents/${id}`)).status, 404);
    assert.equal((await admin.put(`/api/admin/permissions/${id}/${users.carol.id}`, { level: 'read' })).status, 404);
    assert.equal((await admin.put(`/api/documents/${id}/permissions/${users.carol.id}`, { level: 'read' })).status, 404);
  });
});

describe('trash and versions', () => {
  test('a deleted document is unreachable for grantees; owner can restore (T-11)', async () => {
    const id = await newDoc();
    await grant(alice, id, 'carol', 'read');
    assert.equal((await alice.del(`/api/documents/${id}`)).status, 200);
    assert.equal((await carol.get(`/api/documents/${id}/download`)).status, 404);
    assert.equal((await carol.get(`/api/documents/${id}`)).status, 404);
    assert.equal((await alice.get(`/api/documents/${id}/download`)).status, 404);
    assert.equal((await carol.post(`/api/documents/${id}/restore`)).status, 403);
    assert.equal((await bob.post(`/api/documents/${id}/restore`)).status, 404);
    assert.equal((await alice.post(`/api/documents/${id}/restore`)).status, 200);
    assert.equal((await carol.get(`/api/documents/${id}/download`)).status, 200);
  });

  test('purge removes the stored files; others cannot purge', async () => {
    const id = await newDoc();
    await alice.del(`/api/documents/${id}`);
    assert.equal((await bob.del(`/api/documents/${id}/purge`)).status, 404);
    const key = h.ctx.db.prepare('SELECT storage_key FROM document_versions WHERE document_id = ?').get(id).storage_key;
    assert.equal((await alice.del(`/api/documents/${id}/purge`)).status, 200);
    assert.throws(() => h.ctx.storage.read(key, 'x'));
    assert.equal((await alice.get(`/api/documents/${id}`)).status, 404);
  });

  test('a version number cannot select a version of a different document (T-13)', async () => {
    const shared = await newDoc(alice, 'Shared single version');
    const privateDoc = await newDoc(alice, 'Private two versions');
    await alice.uploadVersion(privateDoc, samplePdf('PRIVATE-V2'));
    await grant(alice, shared, 'carol', 'read');
    const res = await carol.get(`/api/documents/${shared}/download?version=2`);
    assert.equal(res.status, 404);
    assert.ok(!res.raw.includes('PRIVATE-V2'));
  });
});

describe('roles (T-14)', () => {
  test('viewers cannot upload, see the directory, trash, or owner activity', async () => {
    assert.equal((await carol.upload(samplePdf())).status, 403);
    assert.equal((await carol.get('/api/users/directory?q=al')).status, 403);
    assert.equal((await carol.get('/api/trash')).status, 403);
    assert.equal((await carol.get('/api/activity')).status, 403);
  });

  test('administrators cannot upload documents', async () => {
    assert.equal((await admin.upload(samplePdf())).status, 403);
  });

  test('only administrators reach /api/admin', async () => {
    for (const c of [alice, carol]) {
      for (const url of ['/api/admin/overview', '/api/admin/audit', '/api/admin/users', '/api/admin/permissions', '/api/admin/documents', '/api/admin/audit/export.csv']) {
        assert.equal((await c.get(url)).status, 403, url);
      }
      assert.equal((await c.post('/api/admin/users', { username: 'evil', displayName: 'e', email: 'e@e.ee', role: 'admin', password: 'Passw0rd1234' })).status, 403);
      assert.equal((await c.patch(`/api/admin/users/${users.carol.id}`, { role: 'admin' })).status, 403);
    }
  });

  test('owners cannot grant to themselves, to administrators, or to deactivated users', async () => {
    const id = await newDoc();
    assert.equal((await grant(alice, id, 'alice', 'read')).status, 400);
    assert.equal((await grant(alice, id, 'admin', 'read')).status, 400);
    const gone = await h.user('gone', 'viewer');
    h.ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(gone.id);
    assert.equal((await alice.put(`/api/documents/${id}/permissions/${gone.id}`, { level: 'read' })).status, 404);
  });

  test('a user can only end their own sessions', async () => {
    const list = await carol.get('/api/auth/sessions');
    const carolSession = list.body.sessions[0].id;
    assert.equal((await bob.del(`/api/auth/sessions/${carolSession}`)).status, 404);
    assert.equal((await carol.get('/api/auth/me')).status, 200);
  });

  test('the user directory never lists administrators', async () => {
    const res = await alice.get('/api/users/directory?q=adm');
    assert.equal(res.body.users.length, 0);
  });
});

describe('suggestions never widen access on their own (T-15)', () => {
  test('a suggestion grants nothing until the owner accepts it; accepting gives read only', async () => {
    const first = await newDoc(alice, 'HR one');
    await grant(alice, first, 'carol', 'read');
    const second = await newDoc(alice, 'HR two');
    const s = await alice.get(`/api/documents/${second}/suggestions`);
    assert.equal(s.status, 200);
    const suggestion = s.body.suggestions.find((x) => x.userId === users.carol.id);
    assert.ok(suggestion, 'carol should be suggested');
    assert.equal((await carol.get(`/api/documents/${second}`)).status, 404, 'suggestion must not grant');
    assert.equal((await bob.post(`/api/documents/${second}/suggestions/${suggestion.id}/accept`)).status, 404);
    assert.equal((await carol.post(`/api/documents/${second}/suggestions/${suggestion.id}/accept`)).status, 404);
    assert.equal((await alice.post(`/api/documents/${second}/suggestions/${suggestion.id}/accept`)).status, 200);
    assert.equal((await carol.get(`/api/documents/${second}`)).status, 200);
    assert.equal((await carol.patch(`/api/documents/${second}`, { title: 'x' })).status, 403);
    const log = h.ctx.db.prepare("SELECT action FROM audit_log WHERE document_id = ? AND action LIKE 'suggestion.%'").all(second).map((r) => r.action);
    assert.deepEqual(log.sort(), ['suggestion.accepted', 'suggestion.generated']);
  });

  test('a suggestion id cannot be replayed against another document', async () => {
    const a = await newDoc(alice, 'S1');
    await grant(alice, a, 'dave', 'read');
    const b = await newDoc(alice, 'S2');
    const c = await newDoc(alice, 'S3');
    const sb = (await alice.get(`/api/documents/${b}/suggestions`)).body.suggestions[0];
    assert.equal((await alice.post(`/api/documents/${c}/suggestions/${sb.id}/accept`)).status, 404);
  });
});

describe('sanity: owners keep access to their own documents', () => {
  test('owner can do everything', async () => {
    const id = await newDoc();
    assert.equal((await alice.get(`/api/documents/${id}/download`)).status, 200);
    assert.equal((await alice.patch(`/api/documents/${id}`, { description: 'd' })).status, 200);
    assert.equal((await alice.uploadVersion(id, sampleTxt())).status, 201);
    assert.equal((await alice.get(`/api/documents/${id}/activity`)).status, 200);
  });
});
