import { timingSafeEqual, createHash } from 'node:crypto';

import { AppError } from '../utils/errors.js';
import { InvalidTransitionError } from '../state-machine/StateMachine.js';

/** Security headers for every response. No inline script or style, nothing third-party. */
export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
      "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

/** One structured line per API request: method, route, status, duration. Never bodies. */
export function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('http.request', {
        method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms), ip: req.ip,
      });
    });
    next();
  };
}

/**
 * Cross-site request protection for the JSON API.
 *
 * Browsers attach `Sec-Fetch-Site` and `Origin` to cross-site requests; a
 * state-changing request from another site is refused. Requiring a JSON
 * content type for bodies also rules out plain HTML form posts.
 */
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) {
    return next(new AppError(403, 'Cross-site requests are not allowed.', 'forbidden_origin'));
  }
  const origin = req.get('origin');
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.get('host')) return next(new AppError(403, 'Cross-site requests are not allowed.', 'forbidden_origin'));
  }
  const length = Number(req.get('content-length') ?? 0);
  if ((length > 0 || req.get('transfer-encoding')) && !req.is('application/json')) {
    return next(new AppError(415, 'Send the request body as application/json.', 'unsupported_media_type'));
  }
  return next();
}

/**
 * Authentication hook. Without APP_AUTH_TOKEN the app is single-user and open
 * (bind it to a trusted network). With it, every API call needs
 * `Authorization: Bearer <token>`. A user system would replace this function
 * and set `req.user`.
 */
export function authenticate(token) {
  const expected = token ? createHash('sha256').update(token).digest() : null;
  return (req, res, next) => {
    if (!expected) {
      req.user = { id: 'local' };
      return next();
    }
    const header = req.get('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    const digest = createHash('sha256').update(given).digest();
    if (!given || !timingSafeEqual(digest, expected)) {
      return next(new AppError(401, 'Authentication required.', 'unauthorized'));
    }
    req.user = { id: 'local' };
    return next();
  };
}

/** A fixed-window limit per client for endpoints that call DeepSeek. */
export function rateLimit({ perMinute }) {
  const windows = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, w] of windows) if (now - w.start >= 60_000) windows.delete(ip);
  }, 60_000);
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    if (w.count > perMinute) {
      const retry = Math.ceil((w.start + 60_000 - now) / 1000);
      res.set('Retry-After', String(retry));
      return next(new AppError(429, `Too many requests. Try again in ${retry}s.`, 'rate_limited'));
    }
    return next();
  };
}

/** Filesystem failures, described without revealing paths. */
const STORAGE_ERRORS = {
  EACCES: 'the data directory is not writable by the service user.',
  EPERM: 'the data directory is not writable by the service user.',
  EROFS: 'the data directory is on a read-only filesystem.',
  ENOSPC: 'the disk is full.',
  EDQUOT: 'the disk quota is exceeded.',
  EIO: 'the disk reported an I/O error.',
  EMFILE: 'too many open files.',
};

/** Wrap an async handler so its rejection reaches the error handler. */
export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Turns every error into a JSON answer. Expected errors keep their message;
 * anything else is logged in full and answered with one generic sentence, so
 * stack traces, paths and configuration never reach the browser.
 *
 * If the agent attached a partial result (a saved user message, the task now in
 * the error state), it is included so the UI can still show it.
 */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return req.socket.destroy();

    let status = 500;
    let body = { error: 'Something went wrong on the server. Please try again.', code: 'internal' };

    if (err instanceof AppError || (err?.name === 'DeepSeekError')) {
      status = err.status;
      body = { error: err.message, code: err.code, ...(err.details ?? {}) };
      if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      if (status >= 500) logger.error('http.error', { path: req.path, code: err.code, error: err });
    } else if (err instanceof InvalidTransitionError) {
      status = 409;
      body = { error: `${err.message}.`, code: 'invalid_transition' };
    } else if (err?.type === 'entity.parse.failed') {
      status = 400;
      body = { error: 'The request body is not valid JSON.', code: 'invalid_json' };
    } else if (err?.type === 'entity.too.large') {
      status = 413;
      body = { error: 'The request body is too large.', code: 'body_too_large' };
    } else if (err?.type === 'charset.unsupported' || err?.type === 'encoding.unsupported') {
      status = 415;
      body = { error: 'Unsupported request encoding.', code: 'unsupported_media_type' };
    } else if (STORAGE_ERRORS[err?.code]) {
      status = 500;
      body = {
        error: `Storage failure: ${STORAGE_ERRORS[err.code]} The change was not saved; see the server log.`,
        code: 'storage_error',
      };
      logger.error('storage.failure', { method: req.method, path: req.path, error: err });
    } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && err.expose) {
      status = err.status;
      body = { error: 'The request could not be processed.', code: 'bad_request' };
    } else {
      logger.error('http.unexpected_error', { method: req.method, path: req.path, error: err });
    }

    if (err?.result) body.result = err.result;
    res.status(status).json(body);
  };
}
