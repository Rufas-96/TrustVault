'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(config) {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key in out) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function sessionLoader(ctx) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[ctx.config.cookieName];
    const resolved = token ? ctx.sessions.resolve(token) : null;
    if (resolved) {
      req.user = resolved.user;
      req.session = resolved.session;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  next();
}

// Role gate for whole features (uploading, administration). Document-level decisions are
// made by authz.authorize(), not here.
function requireRole(audit, ...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in required'));
    if (!roles.includes(req.user.role)) {
      audit.record({
        req, action: 'access.role_denied', outcome: 'denied',
        details: { required: roles, role: req.user.role, method: req.method, path: req.originalUrl.slice(0, 200) },
      });
      return next(new HttpError(403, 'Your role does not allow this'));
    }
    next();
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Every state-changing request must (1) not come from another origin and (2) when signed in,
// carry the session's CSRF token in a header, which another site cannot read or set.
// SameSite=Strict on the cookie is a third layer.
function csrfProtection(audit) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      audit.record({ req, action: 'security.cross_origin_rejected', outcome: 'denied', details: { origin: origin.slice(0, 200), path: req.originalUrl.slice(0, 200) } });
      return next(new HttpError(403, 'Cross-origin request rejected'));
    }
    if (!req.session) return next(); // unauthenticated: only login accepts this, and only as JSON
    if (!safeEqual(req.get('x-csrf-token') || '', req.session.csrfToken)) {
      audit.record({ req, action: 'security.csrf_rejected', outcome: 'denied', details: { method: req.method, path: req.originalUrl.slice(0, 200) } });
      return next(new HttpError(403, 'Invalid or missing CSRF token. Reload the page and try again.'));
    }
    next();
  };
}

// Fixed-window, in-memory limiter. Good enough for a single instance (see THREATS.md).
function rateLimit({ windowMs, max, message = 'Too many requests. Slow down and try again shortly.', key = (req) => req.ip }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [hk, hv] of hits) if (hv.reset <= now) hits.delete(hk);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return next(new HttpError(429, message));
    }
    next();
  };
}

module.exports = { securityHeaders, sessionLoader, requireAuth, requireRole, csrfProtection, rateLimit, parseCookies };
