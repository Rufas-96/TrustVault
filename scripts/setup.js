'use strict';
// Creates the database schema and, unless SEED_DEMO=false, the demo users and documents.
// Safe to run more than once: the schema is idempotent and seeding only runs on an empty database.
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { seedDemoData } = require('../src/seed');

(async () => {
  const config = loadConfig();
  const { ctx } = createApp({ ...config, auditStdout: false }).locals;
  console.log(`Database ready at ${config.dbFile}`);
  if (config.seedDemo) {
    console.log((await seedDemoData(ctx)) ? 'Demo data created.' : 'Database already has users; seeding skipped.');
  }
  const chain = ctx.audit.verify();
  console.log(`Audit trail: ${chain.count} entries, integrity ${chain.ok ? 'OK' : `BROKEN (${chain.reason})`}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
