import { isProduction } from '../config.js';

/**
 * DESIGN DECISION (ADR-011): structured JSON logs in production,
 * human-readable lines in development.
 *
 * `console.log('user logged in', id)` is unqueryable. When something
 * goes wrong at 2am you need to ask "show me every 5xx for this request
 * id" or "which endpoint is slowest", and free text cannot answer that.
 * One JSON object per line can, in any log platform, with no parsing
 * rules to maintain.
 *
 * In development the same events print as readable lines, because JSON
 * blobs in a terminal slow you down.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (isProduction ? LEVELS.info : LEVELS.debug);

/**
 * Field names that must never reach a log, at any depth.
 *
 * Logging a request body is enormously useful for debugging and is also
 * how passwords and tokens end up in a third-party log service with a
 * different retention policy and a wider audience than the database.
 * Redaction belongs in the logger, not in each call site, because a
 * call site will eventually forget.
 */
const REDACT = new Set([
  'password', 'passwordhash', 'password_hash', 'token', 'accesstoken',
  'accessToken', 'refreshtoken', 'refresh_token', 'authorization',
  'cookie', 'secret', 'answers', 'correct_key', 'correctkey'
]);

function scrub(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrub(item, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, inner] of Object.entries(value)) {
    output[key] = REDACT.has(key.toLowerCase()) ? '[redacted]' : scrub(inner, depth + 1);
  }
  return output;
}

function emit(level, message, fields = {}) {
  if (LEVELS[level] < threshold) return;

  const record = { level, msg: message, ...scrub(fields) };

  if (isProduction) {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...record }));
    return;
  }

  const detail = Object.entries(fields)
    .filter(([key]) => !['msg', 'level'].includes(key))
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(scrub(value)) : value}`)
    .join(' ');

  console.log(`[${level}] ${message}${detail ? '  ' + detail : ''}`);
}

export const log = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields)
};

/**
 * Request logging with timing.
 *
 * Every response records its duration. Without this, "the app feels
 * slow" is an opinion; with it, it is a query. The slow threshold logs
 * at warn so a log platform can alert on it.
 *
 * Health checks are skipped: Render polls them every few seconds and
 * they would drown everything else.
 */
export function requestLogger() {
  return function logRequest(req, res, next) {
    if (req.path === '/api/health') return next();

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;

      const fields = {
        requestId: req.id,
        method: req.method,
        path: req.route?.path ? req.baseUrl + req.route.path : req.path,
        status: res.statusCode,
        ms: Number(ms.toFixed(1)),
        userId: req.user?.id,
        role: req.user?.role,
        bytes: Number(res.get('content-length') ?? 0)
      };

      if (res.statusCode >= 500) log.error('request failed', fields);
      else if (res.statusCode === 401 || res.statusCode === 403) log.warn('request refused', fields);
      else if (ms > 500) log.warn('slow request', fields);
      else log.info('request', fields);
    });

    next();
  };
}
