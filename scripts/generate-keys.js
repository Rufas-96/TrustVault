'use strict';
// Prints fresh random keys for the two secrets TrustVault needs in production.
const crypto = require('node:crypto');

console.log(`FILE_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`AUDIT_HMAC_KEY=${crypto.randomBytes(32).toString('hex')}`);
