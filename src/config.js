'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Keys may be 64 hex characters, or any random string of 32+ characters (e.g. Render's
// "generateValue"), which is stretched to 32 bytes with SHA-256.
function parseKey(name, value) {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (value.length < 32) throw new Error(`${name} is too short: use 64 hex chars or 32+ random characters`);
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

// In development we generate keys once and keep them in the data directory so restarts can
// still decrypt files. In production a missing key is a hard failure: we never run with a
// default key that would be the same on every deployment.
function readKey(env, name, production, dataDir) {
  if (env[name]) return parseKey(name, env[name]);
  if (production) throw new Error(`${name} must be set when NODE_ENV=production`);
  const file = path.join(dataDir, 'dev-keys.json');
  let keys = {};
  if (fs.existsSync(file)) keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!keys[name]) {
    keys[name] = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.warn(`[config] ${name} not set; generated a development key in ${file}`);
  }
  return Buffer.from(keys[name], 'hex');
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    production,
    port: Number(env.PORT) || 3000,
    dataDir,
    dbFile: path.join(dataDir, 'trustvault.db'),
    fileKey: readKey(env, 'FILE_ENCRYPTION_KEY', production, dataDir),
    auditKey: readKey(env, 'AUDIT_HMAC_KEY', production, dataDir),
    // __Host- cookies must be Secure, Path=/ and have no Domain: the browser enforces it.
    cookieSecure: production,
    cookieName: production ? '__Host-tv_session' : 'tv_session',
    trustProxy: production ? 1 : false,
    maxUploadBytes: 10 * 1024 * 1024,
    loginRateLimit: 20,   // attempts per IP per 15 minutes
    apiRateLimit: 600,    // requests per IP per minute
    auditStdout: env.AUDIT_STDOUT !== 'false',
    seedDemo: env.SEED_DEMO !== 'false',
  };
}

module.exports = { loadConfig, parseKey };
