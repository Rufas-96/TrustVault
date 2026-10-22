'use strict';
// Sessions, sign-in protection, CSRF and security headers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, Client, PASSWORD } = require('./helpers');

let h;

before(async () => {
  h = await startServer();
  await h.user('alice', 'owner');
  await h.user('mallory', 'viewer');
  await h.user('locky', 'viewer');
});
after(() => h.close());

test('wrong password and unknown user give the same answer (T-40)', async () => {
  const c = new Client(h.base);
  const a = await c.post('/api/auth/login', { username: 'alice', password: 'not-the-password1' });
  const b = await c.post('/api/auth/login', { username: 'nobody-here', password: 'not-the-password1' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('five failed sign-ins lock the account, even with the right password after (T-41)', async () => {
  const c = new Client(h.base);
  for (let i = 0; i < 5; i += 1) await c.post('/api/auth/login', { username: 'locky', password: 'wrong-password-1' });
  const res = await c.post('/api/auth/login', { username: 'locky', password: PASSWORD });
  assert.equal(res.status, 401);
});

test('the per-IP sign-in rate limit applies', async () => {
  const h2 = await startServer({ loginRateLimit: 3 });
  try {
    const c = new Client(h2.base);
    for (let i = 0; i < 3; i += 1) await c.post('/api/auth/login', { username: 'x', password: 'y' });
    assert.equal((await c.post('/api/auth/login', { username: 'x', password: 'y' })).status, 429);
  } finally {
    await h2.close();
  }
});

test('login only accepts JSON (blocks cross-site form posts)', async () => {
  const res = await fetch(`${h.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=alice&password=${PASSWORD}`,
  });
  assert.equal(res.status, 415);
});

test('session cookie is HttpOnly and SameSite=Strict (T-42)', async () => {
  const res = await fetch(`${h.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes('password_hash'));
});

test('logout kills the session on the server, not just in the browser (T-43)', async () => {
  const c = await h.client('alice');
  const stolenCookie = c.cookie;
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  const replay = new Client(h.base);
  replay.cookie = stolenCookie;
  assert.equal((await replay.get('/api/auth/me')).status, 401);
});

test('a forged or random session token is rejected', async () => {
  const c = new Client(h.base);
  c.cookie = 'tv_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('changing password ends all other sessions (T-44)', async () => {
  const laptop = await h.client('mallory');
  const phone = await h.client('mallory');
  const res = await laptop.post('/api/auth/password', { currentPassword: PASSWORD, newPassword: 'BrandNewPass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.otherSessionsEnded, 1);
  assert.equal((await phone.get('/api/auth/me')).status, 401);
  assert.equal((await laptop.get('/api/auth/me')).status, 200);
});

test('state-changing requests without the CSRF token are refused (T-45)', async () => {
  const c = await h.client('alice');
  assert.equal((await c.post('/api/auth/logout', undefined, { csrf: false })).status, 403);
  assert.equal((await c.request('POST', '/api/auth/logout', { headers: { 'X-CSRF-Token': 'wrong' }, csrf: false })).status, 403);
  assert.equal((await c.get('/api/auth/me')).status, 200, 'still signed in');
});

test('requests from another origin are refused (T-45)', async () => {
  const c = await h.client('alice');
  const res = await c.request('POST', '/api/auth/logout', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('an idle session expires on the server (T-46)', async () => {
  const c = await h.client('alice');
  h.ctx.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 31 * 60 * 1000);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('security headers are set on pages and API (T-47)', async () => {
  for (const url of ['/', '/login', '/api/health']) {
    const res = await fetch(h.base + url);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  }
});

test('the data directory and server code are not reachable over HTTP', async () => {
  for (const url of ['/data/trustvault.db', '/../data/trustvault.db', '/db/schema.sql', '/src/authz.js', '/package.json', '/.env']) {
    const res = await fetch(h.base + url);
    assert.equal(res.status, 404, url);
  }
});

test('unknown API routes return JSON 404 and errors do not leak stack traces', async () => {
  const c = await h.client('alice');
  const res = await c.get('/api/nope');
  assert.equal(res.status, 404);
  const bad = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('at '));
});
