'use strict';
// Leak forensics (traceable downloads, Leak Tracer) and access reviews.
const zlib = require('node:zlib');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, samplePdf, sampleTxt } = require('./helpers');
const { stamp, findTraceId, newTraceId, TRACE_EXACT } = require('../src/trace');

let h; let alice; let bob; let carol; let admin; let users;

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

async function sharedTxt(title = 'Leakable notes') {
  const id = (await alice.upload(sampleTxt('confidential numbers'), { title, category: 'HR' })).body.id;
  await alice.put(`/api/documents/${id}/permissions/${users.carol.id}`, { level: 'read' });
  return id;
}
const traceByFile = (client, buffer, name = 'leak.txt') => {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  return client.request('POST', '/api/trace', { form });
};

describe('traceable downloads (T-70)', () => {
  test('every download is a unique copy with its own trace ID, recorded in the audit', async () => {
    const id = await sharedTxt();
    const one = await carol.get(`/api/documents/${id}/download`);
    const two = await carol.get(`/api/documents/${id}/download`);
    const t1 = one.headers.get('x-trustvault-trace');
    const t2 = two.headers.get('x-trustvault-trace');
    assert.match(t1, TRACE_EXACT);
    assert.notEqual(t1, t2);
    assert.ok(one.raw.toString().includes(`${t1} | downloaded by carol`));
    assert.notDeepEqual(one.raw, two.raw);
    const logged = h.ctx.db.prepare("SELECT json_extract(details, '$.traceId') AS t FROM audit_log WHERE document_id = ? AND action = 'document.download'").all(id).map((r) => r.t);
    assert.deepEqual(logged.sort(), [t1, t2].sort());
  });

  test('a stamped PDF is still a PDF and carries the trace after %%EOF', async () => {
    const out = stamp(samplePdf().buffer, 'pdf', { traceId: 'TV-AAAAA-BBBBB', username: 'carol' });
    assert.ok(out.buffer.subarray(0, 5).toString() === '%PDF-');
    assert.ok(out.buffer.toString('latin1').includes('%%EOF'));
    assert.equal(findTraceId(out.buffer), 'TV-AAAAA-BBBBB');
  });

  test('Office files get the trace in the zip comment, keeping the archive valid', () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    const zip = Buffer.concat([Buffer.from('PK\x03\x04[Content_Types].xml word/', 'latin1'), eocd]);
    const out = stamp(zip, 'docx', { traceId: 'TV-CCCCC-DDDDD', username: 'dave' });
    assert.equal(out.method, 'archive comment');
    // The end-of-central-directory record is intact and its comment length runs exactly to the end.
    const at = out.buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(at + 22 + out.buffer.readUInt16LE(at + 20), out.buffer.length);
    assert.equal(findTraceId(out.buffer), 'TV-CCCCC-DDDDD');
  });

  test('PNG gets a tEXt chunk with a correct CRC; JPEG gets a comment segment', () => {
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), iend]);
    const p = stamp(png, 'png', { traceId: 'TV-EEEEE-FFFFF', username: 'x' }).buffer;
    const at = p.indexOf(Buffer.from('tEXt'));
    const len = p.readUInt32BE(at - 4);
    assert.equal(p.readUInt32BE(at + 4 + len), zlib.crc32(p.subarray(at, at + 4 + len)) >>> 0);
    assert.ok(p.subarray(-12).equals(iend), 'IEND stays last');
    const jpg = stamp(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpg', { traceId: 'TV-GGGGG-HHHHH', username: 'x' }).buffer;
    assert.deepEqual([...jpg.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xfe]);
    assert.equal(findTraceId(jpg), 'TV-GGGGG-HHHHH');
  });

  test('trace IDs are well formed and random', () => {
    const ids = new Set(Array.from({ length: 200 }, newTraceId));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, TRACE_EXACT);
  });
});

describe('Leak Tracer (T-71, T-74)', () => {
  test('the owner can trace a leaked file back to the exact download', async () => {
    const id = await sharedTxt('Traced document');
    const leaked = (await carol.get(`/api/documents/${id}/download`)).raw;
    const res = await traceByFile(alice, leaked);
    assert.equal(res.status, 200);
    assert.equal(res.body.matches.length, 1);
    assert.equal(res.body.matches[0].downloadedBy, 'carol');
    assert.equal(res.body.matches[0].exactCopy, true);
    assert.equal(res.body.matches[0].ip, undefined, 'owners do not see IP addresses');
  });

  test('a copy with its footer removed is still found by its trace ID', async () => {
    const id = await sharedTxt();
    const dl = await carol.get(`/api/documents/${id}/download`);
    const byId = await alice.post('/api/trace', { traceId: dl.headers.get('x-trustvault-trace').toLowerCase() });
    assert.equal(byId.body.matches[0].downloadedBy, 'carol');
  });

  test('another owner learns nothing about documents they do not own', async () => {
    const id = await sharedTxt();
    const dl = await carol.get(`/api/documents/${id}/download`);
    const res = await bob.post('/api/trace', { traceId: dl.headers.get('x-trustvault-trace') });
    assert.equal(res.status, 200);
    assert.equal(res.body.matches.length, 0);
    assert.equal((await traceByFile(bob, dl.raw)).body.matches.length, 0);
  });

  test('administrators can trace everything, including the IP address', async () => {
    const id = await sharedTxt();
    const dl = await carol.get(`/api/documents/${id}/download`);
    const res = await admin.post('/api/trace', { traceId: dl.headers.get('x-trustvault-trace') });
    assert.equal(res.body.matches.length, 1);
    assert.ok('ip' in res.body.matches[0]);
  });

  test('viewers cannot use the tracer; bad input is refused; every lookup is audited', async () => {
    assert.equal((await carol.post('/api/trace', { traceId: 'TV-AAAAA-BBBBB' })).status, 403);
    assert.equal((await alice.post('/api/trace', { traceId: 'not-a-trace' })).status, 400);
    const before = h.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'trace.lookup'").get().n;
    await alice.post('/api/trace', { traceId: 'TV-ZZZZZ-ZZZZZ' });
    const last = h.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'trace.lookup' ORDER BY seq DESC LIMIT 1").get();
    assert.equal(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'trace.lookup'").get().n, before + 1);
    assert.equal(last.actor_username, 'alice');
    assert.equal(last.outcome, 'failure');
  });

  test('a file dropped into the tracer is never stored', async () => {
    const files = () => require('node:fs').readdirSync(require('node:path').join(h.ctx.config.dataDir, 'files')).length;
    const n = files();
    await traceByFile(alice, Buffer.from('random leaked bytes TV-QQQQQ-QQQQQ'));
    assert.equal(files(), n);
  });
});

describe('access reviews (T-73)', () => {
  test('old grants are flagged as due; the owner can confirm them', async () => {
    const id = await sharedTxt('Old grant');
    h.ctx.db.prepare('UPDATE permissions SET granted_at = ? WHERE document_id = ?').run(Date.now() - 45 * 86400000, id);
    const list = await alice.get('/api/reviews');
    const g = list.body.grants.find((x) => x.documentId === id);
    assert.equal(g.due, true);
    assert.ok(g.ageDays >= 45);
    assert.equal((await alice.post(`/api/documents/${id}/permissions/${users.carol.id}/confirm`)).status, 200);
    const after = (await alice.get('/api/reviews')).body.grants.find((x) => x.documentId === id);
    assert.equal(after.due, false);
    const log = h.ctx.db.prepare("SELECT actor_username FROM audit_log WHERE action = 'permission.review' AND document_id = ?").get(id);
    assert.equal(log.actor_username, 'alice');
  });

  test('only the owner can confirm, and the review list only shows their own grants', async () => {
    const id = await sharedTxt();
    assert.equal((await bob.post(`/api/documents/${id}/permissions/${users.carol.id}/confirm`)).status, 404);
    assert.equal((await carol.post(`/api/documents/${id}/permissions/${users.carol.id}/confirm`)).status, 403);
    assert.equal((await carol.get('/api/reviews')).status, 403);
    assert.ok(!(await bob.get('/api/reviews')).body.grants.some((x) => x.documentId === id));
  });
});

describe('why can I see this', () => {
  test('a grantee is told who granted their access and when', async () => {
    const id = await sharedTxt();
    const doc = (await carol.get(`/api/documents/${id}`)).body.document;
    assert.equal(doc.myGrant.grantedBy, 'alice');
    assert.ok(doc.myGrant.grantedAt > 0);
    assert.equal((await alice.get(`/api/documents/${id}`)).body.document.myGrant, null);
  });
});
