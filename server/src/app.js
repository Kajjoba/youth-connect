import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { config, isProduction } from './config.js';
import { healthCheck } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authenticate } from './middleware/authenticate.js';
import { requestLogger, log } from './lib/logger.js';
import { wrap, sendJson } from './lib/http.js';

import authRoutes from './routes/auth.routes.js';
import activityRoutes from './routes/activity.routes.js';
import assessmentRoutes from './routes/assessment.routes.js';
import participantRoutes from './routes/participant.routes.js';
import accountRoutes from './routes/account.routes.js';
import facilitatorRoutes from './routes/facilitator.routes.js';
import adminRoutes from './routes/admin.routes.js';
import contentRoutes from './routes/content.routes.js';
import certificateRoutes from './routes/certificate.routes.js';
import catalogueRoutes from './routes/catalogue.routes.js';
import pacingRoutes from './routes/pacing.routes.js';

export async function createApp() {
  const app = express();

  // Render and Vercel sit behind a proxy. Without this, req.ip is the
  // proxy address and every rate limit applies to the whole internet as
  // one bucket, which would let one attacker lock out all users.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Correlates a user-facing error message with a server log line.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });

  // Timing and outcome for every request. Placed before the routes so
  // it sees responses the error handler produces too.
  app.use(requestLogger());

  /**
   * REQ-SEC-008: security headers.
   * The Content Security Policy is the second line of defence against
   * cross-site scripting. Input encoding is the first; CSP limits the
   * damage if encoding is ever missed.
   */
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", ...config.corsOrigins],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));

  /**
   * CORS.
   *
   * DEFECT FOUND 2026-09-27, twice over, by opening the app in a real
   * browser for the first time. Every login returned 500.
   *
   * ONE: a rejected origin used to `callback(new Error(...))`. The cors
   * package passes that to the error handler, which reports 500. A
   * request from an origin that is not on the list is not a server
   * fault, and calling it one does real damage:
   *
   *   the browser reports "500 Internal Server Error", so whoever is
   *   debugging goes looking at the server and the database, which is
   *   exactly the wrong place and is where the last hour went;
   *
   *   error monitoring fills with fabricated server errors that anyone
   *   can generate at will, simply by sending an Origin header;
   *
   *   the one fact needed to fix it, which origin was refused, appears
   *   nowhere the developer can see.
   *
   * The correct behaviour is callback(null, false): the response carries
   * no Access-Control-Allow-Origin, the BROWSER blocks it, which is
   * where that boundary actually lives, and nothing is logged as a
   * crash. The refusal is logged as a warning naming the origin,
   * because that is the missing piece of information.
   *
   * TWO: the list was compared by exact string. http://localhost:5173
   * and http://127.0.0.1:5173 are the same dev server, and the Vite
   * proxy forwards whichever one the browser used, so half the time the
   * origin did not match. The same class of mismatch is waiting in
   * production: a trailing slash, or http against https, silently
   * refuses every request from the real front end and reports it as a
   * server error. Origins are normalised, and the loopback pair is
   * treated as equivalent OUTSIDE production only.
   */
  const allowedOrigins = new Set();
  for (const entry of config.corsOrigins) {
    const normalised = entry.trim().replace(/\/+$/, '').toLowerCase();
    if (!normalised) continue;
    allowedOrigins.add(normalised);
    // Development convenience only. In production the deployed origin is
    // named exactly and nothing is inferred from it.
    if (!isProduction) {
      if (normalised.includes('//localhost')) {
        allowedOrigins.add(normalised.replace('//localhost', '//127.0.0.1'));
      } else if (normalised.includes('//127.0.0.1')) {
        allowedOrigins.add(normalised.replace('//127.0.0.1', '//localhost'));
      }
    }
  }

  app.use(cors({
    origin(origin, callback) {
      // Same-origin and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin.replace(/\/+$/, '').toLowerCase())) {
        return callback(null, true);
      }
      // Not an error. The browser enforces this, and the log entry is
      // the only thing anyone actually needs.
      log.warn('cors refused an origin', {
        origin,
        allowed: [...allowedOrigins].join(', ')
      });
      return callback(null, false);
    },
    credentials: true,           // required for the refresh cookie
    maxAge: 86_400               // cache the preflight for a day
  }));

  /**
   * REQ-NFR-001: compression.
   * JSON compresses by roughly 70 to 85 percent. On the discovery list
   * this takes 18.4 KB down to about 4.1 KB on the wire. Threshold 512
   * avoids spending CPU on payloads too small to benefit.
   */
  app.use(compression({ threshold: 512 }));

  // REQ-SEC-009: a body size ceiling. Without it, a single request can
  // exhaust memory. 8mb accommodates a base64-encoded course material
  // at the 5 MB cap (base64 adds about a third), while still bounding
  // what one request can allocate. The per-endpoint checks are tighter:
  // this is the outer wall, not the policy.
  app.use(express.json({ limit: '8mb' }));
  app.use(cookieParser());

  // Broad limiter as a backstop. Credential routes have a tighter one.
  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  }));

  app.get('/api/health', wrap(async (req, res) => {
    const database = await healthCheck().catch(() => false);
    return res.status(database ? 200 : 503).json({
      status: database ? 'ok' : 'degraded',
      database,
      features: config.features,
      uptime: Math.round(process.uptime())
    });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/activities', activityRoutes);
  app.use('/api/assessments', assessmentRoutes);
  app.use('/api', accountRoutes);
  app.use('/api', facilitatorRoutes);
  app.use('/api', contentRoutes);
  app.use('/api', certificateRoutes);

  // The public catalogue. Mounted before the authenticated routes
  // because it is the only surface a stranger can reach, and keeping it
  // visibly separate makes that easy to audit.
  app.use('/api', catalogueRoutes);
  app.use('/api', pacingRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api', participantRoutes);

  // ADR-001: Level Two mounts here when the flag is on. The routes do
  // not exist at all while it is off, so the CAT 1 surface is exactly
  // what is demonstrated.
  if (config.features.levelTwo) {
    const { default: teamRoutes } = await import('./routes/team.routes.js');
    app.use('/api/teams', teamRoutes);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
