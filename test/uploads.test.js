'use strict';
// What is uploaded is validated, stored encrypted, and served safely.
const fs = require('node:fs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, samplePdf } = require('./helpers');

let h; let alice;

before(async () => {
  h = await startServer({ maxUploadBytes: 64 * 1024 });
  await h.user('alice', 'owner');
  alice = await h.client('alice');
});
after(() => h.close());

const file = (name, buffer) => ({ name, buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) });

test('rejects an executable renamed to .pdf (T-30)', async () => {
  const res = await alice.upload(file('invoice.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])));
  assert.equal(res.status, 415);
});

test('rejects types that could run in a browser: html, svg, js (T-31)', async () => {
  for (const name of ['page.html', 'logo.svg', 'app.js', 'run.exe', 'noextension']) {
    const res = await alice.upload(file(name, '<script>alert(1)</script>'));
    assert.equal(res.status, 415, name);
  }
});

test('rejects double extensions and content that does not match the extension', async () => {
  assert.equal((await alice.upload(file('report.pdf.exe', samplePdf().buffer))).status, 415);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal((await alice.upload(file('image.pdf', png))).status, 415);
  assert.equal((await alice.upload(file('notes.txt', Buffer.from([0x41, 0x00, 0x42])))).status, 415);
});

test('rejects empty and oversized files (T-32)', async () => {
  assert.equal((await alice.upload(file('empty.txt', ''))).status, 400);
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(70 * 1024, 0x20)]);
  assert.equal((await alice.upload(file('big.pdf', big))).status, 413);
});

test('rejects a request with no file, and an unknown category', async () => {
  const form = new FormData();
  form.append('title', 'x');
  form.append('category', 'General');
  assert.equal((await alice.request('POST', '/api/documents', { form })).status, 400);
  assert.equal((await alice.upload(samplePdf(), { category: 'Secret' })).status, 400);
});

test('rejected uploads are audited', () => {
  const n = h.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'document.upload_rejected'").get().n;
  assert.ok(n >= 5);
});

test('path traversal in the filename never reaches the filesystem (T-33)', async () => {
  const res = await alice.upload(file('../../../etc/passwd.txt', 'harmless'));
  assert.equal(res.status, 201);
  const v = h.ctx.db.prepare('SELECT original_name, storage_key FROM document_versions WHERE document_id = ?').get(res.body.id);
  assert.equal(v.original_name, 'passwd.txt');
  assert.match(v.storage_key, /^[0-9a-f]{64}$/);
});

test('files are encrypted at rest (T-34)', async () => {
  const marker = 'PLAINTEXT-MARKER-12345';
  const res = await alice.upload(file('secret.txt', marker));
  const { storage_key: key } = h.ctx.db.prepare('SELECT storage_key FROM document_versions WHERE document_id = ?').get(res.body.id);
  const onDisk = fs.readFileSync(h.ctx.storage.locate(key));
  assert.ok(!onDisk.includes(marker));
  const dl = await alice.get(`/api/documents/${res.body.id}/download`);
  assert.equal(dl.raw.toString(), marker);
});

test('downloads are served as attachments that cannot execute (T-35)', async () => {
  const res = await alice.upload(file('a"b<c>.txt', 'hello'));
  const dl = await alice.get(`/api/documents/${res.body.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.match(dl.headers.get('cache-control'), /no-store/);
  assert.ok(!dl.headers.get('content-disposition').includes('<'));
});

test('a tampered or swapped file is refused, not served (T-36)', async () => {
  const one = (await alice.upload(file('one.txt', 'first file'))).body.id;
  const two = (await alice.upload(file('two.txt', 'second file'))).body.id;
  const k = (id) => h.ctx.db.prepare('SELECT storage_key FROM document_versions WHERE document_id = ?').get(id).storage_key;
  // Swap: put file two's ciphertext where file one should be.
  fs.copyFileSync(h.ctx.storage.locate(k(two)), h.ctx.storage.locate(k(one)));
  const res = await alice.get(`/api/documents/${one}/download`);
  assert.equal(res.status, 500);
  assert.ok(!res.raw.toString().includes('second file'));
  // Flip a byte in file two.
  const p = h.ctx.storage.locate(k(two));
  const blob = fs.readFileSync(p);
  blob[blob.length - 1] ^= 0xff;
  fs.writeFileSync(p, blob);
  assert.equal((await alice.get(`/api/documents/${two}/download`)).status, 500);
});
