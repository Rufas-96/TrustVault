'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAGIC = Buffer.from('TVF1');
const KEY_RE = /^[0-9a-f]{64}$/;

// Encrypted blob store. Files live outside the web root under random names, so there is no
// URL that reaches them; the only way out is the download route, which authorises first.
// Each file gets its own AES-256-GCM key (HKDF of the master key and the random storage key),
// and the ciphertext is bound to the document_versions row id through GCM associated data.
function createStorage(dir, masterKey) {
  fs.mkdirSync(dir, { recursive: true });

  function fileKey(storageKey) {
    return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.from(storageKey, 'hex'), 'trustvault/file/v1', 32));
  }

  function locate(storageKey) {
    if (!KEY_RE.test(storageKey)) throw new Error('Invalid storage key');
    return path.join(dir, `${storageKey}.bin`);
  }

  function save(plaintext, binding) {
    const storageKey = crypto.randomBytes(32).toString('hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(storageKey), iv);
    cipher.setAAD(Buffer.from(binding, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    fs.writeFileSync(locate(storageKey), Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]), { flag: 'wx', mode: 0o600 });
    return storageKey;
  }

  // Throws if the file was modified, truncated, or belongs to a different record.
  function read(storageKey, binding) {
    const blob = fs.readFileSync(locate(storageKey));
    if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('Stored file is corrupt');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(storageKey), blob.subarray(4, 16));
    decipher.setAAD(Buffer.from(binding, 'utf8'));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }

  function remove(storageKey) {
    fs.rmSync(locate(storageKey), { force: true });
  }

  return { save, read, remove, locate };
}

module.exports = { createStorage };
