import 'dotenv/config';

/**
 * Configuration is validated once at boot and then frozen.
 *
 * DESIGN DECISION (ADR-003): the process refuses to start if a required
 * secret is missing, rather than falling back to a development default.
 * A silent fallback is how a deployed system ends up signing tokens with
 * a well-known string.
 */

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '' || value === 'replace_me') {
    throw new Error(
      `Configuration error: ${name} is not set. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = Object.freeze({
  env: optional('NODE_ENV', 'development'),
  port: toInt(optional('PORT', '4000'), 4000),

  databaseUrl: required('DATABASE_URL'),

  jwt: Object.freeze({
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtlSeconds: toInt(optional('ACCESS_TOKEN_TTL', '900'), 900),
    refreshTtlDays: toInt(optional('REFRESH_TOKEN_TTL_DAYS', '30'), 30)
  }),

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // ADR-029: Sign in with Google. Deliberately OPTIONAL, unlike the JWT
  // secrets above: a deployment that has not set up a Google OAuth
  // client yet must still be able to start and run with email and
  // password sign-in. The route that needs this checks for an empty
  // string itself and refuses cleanly rather than crashing the process.
  google: Object.freeze({
    clientId: optional('GOOGLE_CLIENT_ID', '')
  }),

  features: Object.freeze({
    // ADR-001: Level Two code ships disabled until the CAT 2 brief is
    // confirmed, so the CAT 1 demonstration surface stays focused.
    levelTwo: optional('FEATURE_LEVEL_TWO', 'false') === 'true'
  }),

  // REQ-NFR-003: a hard ceiling on page size. An unbounded list endpoint
  // is both a denial-of-service vector and a data-cost problem for users
  // on metered mobile connections.
  pagination: Object.freeze({
    defaultLimit: 20,
    maxLimit: 50
  })
});

export const isProduction = config.env === 'production';
