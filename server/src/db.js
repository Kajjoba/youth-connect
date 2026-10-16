import pg from 'pg';
import { config, isProduction } from './config.js';

const { Pool } = pg;

/**
 * DESIGN DECISION (ADR-004): a single shared connection pool, sized for
 * a managed Postgres tier rather than for a dedicated server.
 *
 * Neon and similar serverless Postgres providers cap concurrent
 * connections well below what a naive per-request connection model would
 * open. The pool caps us at 10 and queues beyond that, which turns a
 * traffic spike into slightly slower responses instead of connection
 * refusals. This is the mechanism behind the scalability claim: the
 * application tier scales horizontally, and the database tier is
 * protected by bounded pooling.
 */
/**
 * TLS.
 *
 * DESIGN DECISION (ADR-012): certificates are verified, not bypassed.
 *
 * The common shortcut is `ssl: { rejectUnauthorized: false }`, which
 * encrypts the connection but accepts any certificate presented. That
 * defeats the point: an attacker who can redirect the connection can
 * present their own certificate and read every query in clear text. It
 * is encryption without authentication.
 *
 * Neon, Supabase and Render all serve certificates from public
 * authorities that Node already trusts, so verification simply works
 * and there is no reason to disable it. `ssl: true` verifies the chain
 * and the hostname.
 *
 * Local development over a loopback socket needs no TLS at all.
 */
function sslSettings(url) {
  const isLocal = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(url);
  if (isLocal && !isProduction) return false;
  return true;
}

/**
 * Pool sizing and timeouts.
 *
 * DESIGN DECISION (ADR-004): bounded pooling, tuned per environment.
 *
 * A managed serverless Postgres behaves differently from a local one in
 * two ways that matter here:
 *
 *   COLD START. Free-tier Neon suspends the compute after a few minutes
 *   idle. The first connection has to wake it, which can take several
 *   seconds before any query runs. A 10 second connect timeout is
 *   generous locally and marginal against a sleeping compute on a slow
 *   link, so remote connections get 30.
 *
 *   PARALLEL TEST PROCESSES. Node's test runner runs each test file in
 *   its own process. Two files at pool max 10 is up to 20 connections
 *   opening at once against a compute that may still be waking. The
 *   test environment therefore uses a small pool: the suite is not
 *   throughput bound, and a smaller pool is far more likely to connect
 *   successfully.
 *
 * Both are overridable so a deployed instance can be tuned without a
 * code change.
 */
function poolSettings(url) {
  const isLocal = /@(localhost|127\.0\.0\.1|::1)[:/]/.test(url);
  const isTest = config.env === 'test';

  return {
    max: Number(process.env.DB_POOL_MAX) || (isTest ? 3 : 10),
    connectionTimeoutMillis:
      Number(process.env.DB_CONNECT_TIMEOUT_MS) || (isLocal ? 10_000 : 30_000),
    idleTimeoutMillis: 30_000
  };
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ...poolSettings(config.databaseUrl),
  ssl: sslSettings(config.databaseUrl)
});

/**
 * Wake a suspended compute before the work starts.
 *
 * Without this, the first real query absorbs the cold start and can
 * time out, which looks like a broken application rather than a
 * sleeping database.
 *
 * Retrying is only correct for TRANSIENT failures. A hostname that does
 * not resolve, or a refused connection, will fail identically five
 * times: retrying wastes ten seconds and then buries the actual cause
 * under a stack trace. Those are diagnosed and reported immediately.
 */
const PERMANENT = {
  ENOTFOUND:
    'The database hostname does not resolve. Either the connection string is\n'
    + '  wrong, the database endpoint has changed, or this machine has no DNS.\n'
    + '  Check DATABASE_URL against the connection string in your provider console,\n'
    + '  and prefer the DIRECT connection over the pooled one: pooled connections\n'
    + '  run in transaction mode, where session state such as advisory locks is\n'
    + '  not guaranteed to survive between statements.',
  ECONNREFUSED:
    'The host resolved but refused the connection. The database is not\n'
    + '  listening on that port, or a firewall is blocking it.',
  EAI_AGAIN:
    'DNS lookup timed out. This is usually a local network problem rather\n'
    + '  than a database one.',
  '28P01': 'Authentication failed. The username or password in DATABASE_URL is wrong.',
  '3D000': 'That database does not exist on the server.'
};

export async function waitForDatabase({ attempts = 5, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (error) {
      const diagnosis = PERMANENT[error.code];

      if (diagnosis) {
        const host = error.hostname ?? new URL(config.databaseUrl).hostname;
        throw new Error(
          `Cannot reach the database (${error.code}).\n\n`
          + `  Host: ${host}\n\n`
          + `  ${diagnosis}\n`
        );
      }

      if (attempt === attempts) throw error;
      if (attempt === 1) {
        console.log('[db] waking the database, this can take a few seconds');
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

pool.on('error', (error) => {
  console.error('[db] idle client error', error);
});

/**
 * All queries go through here. Parameters are ALWAYS bound, never
 * interpolated, which is the structural defence against SQL injection
 * (REQ-SEC-004). There is no code path in this application that
 * concatenates user input into SQL.
 */
export async function query(text, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    return await pool.query(text, params);
  } finally {
    if (!isProduction) {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (ms > 200) {
        console.warn(`[db] slow query ${ms.toFixed(0)}ms: ${text.slice(0, 90)}`);
      }
    }
  }
}

export async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] ?? null;
}

/**
 * Multi-statement operations that must not half-apply, for example
 * enrolling a participant and creating their progress rows.
 */
export async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck() {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

export async function closePool() {
  await pool.end();
}
