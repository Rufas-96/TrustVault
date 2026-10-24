'use strict';
// Replaces the local database with fresh demo data. The old database is MOVED into
// data/backup-<timestamp>/ (never deleted), and encrypted files stay where they are, so
// nothing is lost. Stop the server first: the database file is locked while it runs.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');

(async () => {
  const config = loadConfig();
  if (config.production) throw new Error('Refusing to reset a production database');
  const files = ['', '-wal', '-shm'].map((s) => config.dbFile + s).filter((f) => fs.existsSync(f));
  if (files.length) {
    const backup = path.join(config.dataDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of files) fs.renameSync(f, path.join(backup, path.basename(f)));
    console.log(`Old database moved to ${backup}`);
  }
  const { createApp } = require('../src/app');
  const { seedDemoData } = require('../src/seed');
  const { ctx } = createApp({ ...config, auditStdout: false }).locals;
  await seedDemoData(ctx);
  const chain = ctx.audit.verify();
  console.log(`Fresh demo data created. Audit trail: ${chain.count} entries, integrity ${chain.ok ? 'OK' : 'BROKEN'}`);
  ctx.db.close();
})().catch((err) => {
  console.error(err.code === 'EBUSY' || err.code === 'EPERM' ? 'The database is in use: stop the server (Ctrl+C) and try again.' : err.message);
  process.exit(1);
});
