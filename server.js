'use strict';
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');
const { seedDemoData } = require('./src/seed');

async function main() {
  const config = loadConfig();
  const app = createApp(config);
  if (config.seedDemo && (await seedDemoData(app.locals.ctx))) {
    console.log('[seed] Demo users and documents created (see README for credentials)');
  }
  app.listen(config.port, () => {
    console.log(`TrustVault listening on http://localhost:${config.port} (${config.production ? 'production' : 'development'})`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
