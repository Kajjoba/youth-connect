import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, query } from './helpers.js';

/**
 * =====================================================================
 * SIGN IN WITH GOOGLE (ADR-029)
 *
 * No test here presents a genuine Google ID token: that would require a
 * live Google account and a real client id, neither of which belongs in
 * an automated suite. What IS tested is everything this suite's own
 * test database and config control: input validation, the graceful
 * refusal when Google sign-in is not configured (true in test, same as
 * a fresh clone that has not set GOOGLE_CLIENT_ID yet), and the two
 * places a Google-only account's NULL password_hash could previously
 * have crashed a request instead of failing it cleanly.
 * =====================================================================
 */

before(startServer);
after(stopServer);

describe('POST /api/auth/google', () => {
  test('an obviously-too-short credential is rejected by validation, not forwarded to Google', async () => {
    const result = await call('/api/auth/google', {
      method: 'POST',
      body: { credential: 'not-a-real-token' }
    });
    assert.equal(result.status, 422);
  });

  test('a plausible-length but fake credential fails verification cleanly, never a 500', async () => {
    // Long enough to pass the schema's length floor, nowhere near a
    // real signed JWT. Without GOOGLE_CLIENT_ID configured (true for
    // this test run, same as an unconfigured deployment), the server
    // refuses before it would even reach Google.
    const result = await call('/api/auth/google', {
      method: 'POST',
      body: { credential: 'x'.repeat(200) }
    });
    assert.equal(result.status, 401);
    assert.ok(!result.raw.includes('Error:'), 'a refusal, not a stack trace');
  });
});

describe('A Google-only account (NULL password_hash) never crashes a password-based request', () => {
  let googleOnlyId;

  before(async () => {
    // Built directly in the database, bypassing the endpoint under
    // test on purpose: this isolates "does the rest of the system
    // handle a NULL password_hash safely" from "does Google
    // verification work", which the tests above already cover
    // separately.
    const created = await query(
      `INSERT INTO users (email, google_sub, role, status, email_verified)
       VALUES ('google-only@ycp.africa', 'fake-sub-for-tests', 'participant', 'active', TRUE)
       ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub, status = 'active'
       RETURNING id`
    );
    googleOnlyId = created.rows[0].id;
    await query(
      `INSERT INTO profiles (user_id, full_name, country, completeness)
       VALUES ($1, 'Google Only', 'UG', 20)
       ON CONFLICT (user_id) DO NOTHING`,
      [googleOnlyId]
    );
  });

  after(async () => {
    await query('DELETE FROM users WHERE email = $1', ['google-only@ycp.africa']);
  });

  test('signing in with a password gets the ordinary wrong-credentials message, not a 500', async () => {
    const result = await call('/api/auth/login', {
      method: 'POST',
      body: { email: 'google-only@ycp.africa', password: 'WhateverSomeone12Tries' }
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error.message, 'Email or password is incorrect.');
  });
});

describe('The schema allows an account with no password at all', () => {
  test('google_sub alone satisfies the has-a-credential constraint', async () => {
    const result = await query(
      `INSERT INTO users (email, google_sub, role, status)
       VALUES ('constraint-check@ycp.africa', 'another-fake-sub', 'participant', 'active')
       ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub
       RETURNING id`
    );
    assert.ok(result.rows[0].id, 'insert with password_hash NULL and google_sub set succeeds');
    await query('DELETE FROM users WHERE email = $1', ['constraint-check@ycp.africa']);
  });

  test('neither a password nor a Google identity is rejected by the database itself', async () => {
    await assert.rejects(
      query(
        `INSERT INTO users (email, role, status)
         VALUES ('neither-credential@ycp.africa', 'participant', 'active')`
      ),
      /users_has_credential/,
      'the CHECK constraint is the backstop if application code ever forgets to require one'
    );
  });
});
