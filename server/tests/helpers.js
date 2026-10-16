import { createApp } from '../src/app.js';
import { pool, waitForDatabase } from '../src/db.js';

/**
 * Test harness.
 *
 * Deliberately no test framework and no HTTP mocking library. Node 22
 * ships a test runner and a fetch implementation, so the suite adds zero
 * dependencies and exercises the real Express app over a real socket
 * against a real PostgreSQL database.
 *
 * Mocking the database here would be actively misleading: most of what
 * this suite verifies (row locks, unique constraints, the authorisation
 * resolvers' joins, trigger-driven versioning) lives IN the database.
 * A mock would pass while the system was broken.
 */

let server;
let origin;

/**
 * Restore the demo accounts to a known state.
 *
 * DEFECT FOUND 2026-09-26. Several tests deliberately suspend an
 * account or change a role, and restore it at the end. That works only
 * when the test finishes. A run CANCELLED partway through, which is
 * what a database outage or a Ctrl-C produces, never reaches the
 * restore, and the account stays suspended. Every later run then dies
 * in its setup hook on "This account is not active", and the report
 * shows dozens of failures in code nobody touched.
 *
 * The underlying mistake is relying on cleanup to establish
 * preconditions. Cleanup is best-effort by nature; SETUP is the only
 * place a precondition can be guaranteed. So the suite now asserts the
 * state it needs before it runs rather than hoping the previous run
 * tidied up.
 *
 * This runs before every suite, is idempotent, and makes the suite
 * self-healing: an interrupted run can no longer poison the next one.
 */
async function restoreDemoAccounts() {
  await pool.query(`
    UPDATE users SET status = 'active', failed_logins = 0, locked_until = NULL
     WHERE email LIKE '%@ycp.africa'
  `);

  // Roles too: the admin lockout test demotes accounts on its way
  // through, and an interrupted run leaves the platform with no admin.
  //
  // v.role is cast to user_role explicitly. A VALUES list yields text,
  // and assigning text to an enum column fails with "column role is of
  // type user_role but expression is of type text". This is the FOURTH
  // occurrence of that mistake in this project, and the first three are
  // already written up in docs/test-log.md as a named pattern. Writing
  // the rule down did not stop me repeating it; the test suite caught
  // it, which is the argument for having one.
  await pool.query(`
    UPDATE users u SET role = v.role::user_role
      FROM (VALUES
        ('admin@ycp.africa',       'super_admin'),
        ('judith@ycp.africa',      'admin'),
        ('richard@ycp.africa',     'admin'),
        ('eric@ycp.africa',        'admin'),
        ('facilitator@ycp.africa', 'facilitator'),
        ('mentor@ycp.africa',      'mentor'),
        ('amina@ycp.africa',       'participant'),
        ('kwame@ycp.africa',       'participant'),
        ('joseph@ycp.africa',      'participant')
      ) AS v(email, role)
     WHERE u.email = v.email AND u.role::text <> v.role
  `);

  // Accounts invented by individual tests. Left behind, the extra
  // admin-tier rows make the "last super admin" test meaningless on the
  // next run.
  await pool.query(
    `DELETE FROM users WHERE email IN
      ('second-admin@ycp.africa', 'second-super-admin@ycp.africa', 'lockout-probe@ycp.africa')`
  );
}

export async function startServer() {
  if (origin) return origin;

  // A hosted database may be suspended. Wake it before any test runs,
  // otherwise the first test absorbs the cold start and the whole suite
  // is cancelled on a connect timeout, which reads as 35 failures when
  // nothing is actually broken.
  await waitForDatabase();
  await restoreDemoAccounts();

  const app = await createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return origin;
}

export async function stopServer() {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end().catch(() => {});
  server = undefined;
  origin = undefined;
}

/** Thin fetch wrapper returning status, body and headers together. */
export async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }

  return {
    status: response.status,
    body: parsed,
    raw: text,
    bytes: Buffer.byteLength(text),
    headers: response.headers,
    etag: response.headers.get('etag')
  };
}

export async function signIn(email, password = 'YcpDemo2026!') {
  const result = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password }
  });
  if (result.status !== 200) {
    throw new Error(`sign in failed for ${email}: ${result.status} ${result.raw}`);
  }
  return { token: result.body.accessToken, user: result.body.user };
}

/** Seeded accounts, all sharing the demo password. */
export const ACCOUNTS = {
  admin: 'admin@ycp.africa',
  opsAdmin: 'judith@ycp.africa',
  facilitator: 'facilitator@ycp.africa',
  mentor: 'mentor@ycp.africa',
  amina: 'amina@ycp.africa',
  kwame: 'kwame@ycp.africa',
  joseph: 'joseph@ycp.africa'
};

export async function query(text, params = []) {
  return pool.query(text, params);
}

/** The AI Literacy activity, its assessment and Amina's graded submission. */
export async function fixtures() {
  const activity = await pool.query(
    `SELECT id FROM activities WHERE slug = 'ai-literacy-foundations'`
  );
  // ORDER BY matters. With LIMIT 1 and no ordering this returned an
  // arbitrary row, so on a database that had been seeded twice the tests
  // picked one of two identical assessments at random and the other one,
  // unpassable and invisible, blocked the certificate. Migration 009
  // stops the duplicate existing; ordering here stops the test being
  // nondeterministic regardless.
  const assessment = await pool.query(
    `SELECT id FROM assessments WHERE activity_id = $1
      ORDER BY created_at ASC, id ASC LIMIT 1`,
    [activity.rows[0].id]
  );
  const submission = await pool.query(
    `SELECT s.id FROM submissions s
       JOIN users u ON u.id = s.user_id
      WHERE u.email = 'amina@ycp.africa' AND s.assessment_id = $1
      LIMIT 1`,
    [assessment.rows[0].id]
  );

  return {
    activityId: activity.rows[0].id,
    assessmentId: assessment.rows[0].id,
    aminaSubmissionId: submission.rows[0]?.id ?? null
  };
}
