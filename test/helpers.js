'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { createUser } = require('../src/users');
const { simplePdf } = require('../src/seed');

const PASSWORD = 'TestPassw0rd!';

// Starts an isolated TrustVault on a random port with its own temp data dir and in-memory DB.
async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustvault-test-'));
  const config = {
    production: false,
    dataDir,
    dbFile: ':memory:',
    fileKey: crypto.randomBytes(32),
    auditKey: crypto.randomBytes(32),
    cookieSecure: false,
    cookieName: 'tv_session',
    trustProxy: false,
    maxUploadBytes: 1024 * 1024,
    loginRateLimit: 1000,
    apiRateLimit: 100000,
    auditStdout: false,
    seedDemo: false,
    ...overrides,
  };
  const app = createApp(config);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = app.locals.ctx;
  return {
    base,
    ctx,
    async user(username, role) {
      return createUser(ctx.db, { username, displayName: username, email: `${username}@test.example`, role, password: PASSWORD });
    },
    async client(username) {
      const c = new Client(base);
      if (username) await c.login(username, PASSWORD);
      return c;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      ctx.db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A minimal browser stand-in: keeps the session cookie and sends the CSRF header.
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
    this.csrf = null;
  }

  async login(username, password) {
    const res = await this.request('POST', '/api/auth/login', { json: { username, password } });
    if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    this.csrf = res.body.csrfToken;
    return res;
  }

  async request(method, url, { json, form, csrf = true, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (csrf && this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) body = form;
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    const type = res.headers.get('content-type') || '';
    const raw = Buffer.from(await res.arrayBuffer());
    let parsed = raw;
    if (type.includes('application/json')) parsed = JSON.parse(raw.toString('utf8'));
    return { status: res.status, headers: res.headers, body: parsed, raw };
  }

  get(url, opts) { return this.request('GET', url, opts); }
  post(url, json, opts = {}) { return this.request('POST', url, { ...opts, json }); }
  put(url, json, opts = {}) { return this.request('PUT', url, { ...opts, json }); }
  patch(url, json, opts = {}) { return this.request('PATCH', url, { ...opts, json }); }
  del(url, opts) { return this.request('DELETE', url, opts); }

  // Uploads a new document; returns the response (body.id on success).
  upload(file, fields = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries({ title: 'Test document', category: 'General', ...fields })) form.append(k, v);
    form.append('file', new Blob([file.buffer]), file.name);
    return this.request('POST', '/api/documents', { form });
  }

  uploadVersion(documentId, file) {
    const form = new FormData();
    form.append('file', new Blob([file.buffer]), file.name);
    return this.request('POST', `/api/documents/${documentId}/versions`, { form });
  }
}

const samplePdf = (text = 'hello') => ({ buffer: simplePdf([text]), name: 'sample.pdf' });
const sampleTxt = (text = 'plain text') => ({ buffer: Buffer.from(text), name: 'notes.txt' });

module.exports = { startServer, Client, PASSWORD, samplePdf, sampleTxt };
