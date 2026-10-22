'use strict';
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('./db');
const { createAudit } = require('./audit');
const { createStorage } = require('./storage');
const { createSessions } = require('./sessions');
const { createAuthz } = require('./authz');
const { HttpError } = require('./http');
const { securityHeaders, sessionLoader, csrfProtection, rateLimit } = require('./middleware');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(config) {
  const db = openDatabase(config.dbFile);
  const audit = createAudit(db, config.auditKey, { stdout: config.auditStdout });
  const storage = createStorage(path.join(config.dataDir, 'files'), config.fileKey);
  const sessions = createSessions(db);
  const authz = createAuthz(db, audit);
  const ctx = { config, db, audit, storage, sessions, authz };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.ctx = ctx;

  app.use(securityHeaders(config));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, max: config.apiRateLimit }));
  app.use('/api', express.json({ limit: '100kb' }));
  app.use(sessionLoader(ctx));
  app.use('/api', csrfProtection(audit));

  app.use('/api', require('./routes/auth')(ctx));
  app.use('/api', require('./routes/documents')(ctx));
  app.use('/api', require('./routes/sharing')(ctx));
  app.use('/api/admin', require('./routes/admin')(ctx));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'No such API endpoint')));

  // Static pages contain no data; every page fetches what it shows from the API above.
  // no-cache = the browser must re-check with the server before reusing a page, script or stylesheet,
  // so a new deployment is picked up immediately.
  app.use(express.static(PUBLIC_DIR, {
    extensions: ['html'], index: 'index.html', dotfiles: 'ignore',
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = Number.isInteger(err.status) && err.expose ? err.status : 500;
    let message = status >= 500 ? 'Something went wrong on our side. The error has been logged.' : err.message;
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Request body is not valid JSON'; }
    if (err.type === 'entity.too.large') { status = 413; message = 'Request body is too large'; }
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message });
    res.status(status).type('text/plain').send(message);
  });

  return app;
}

module.exports = { createApp };
