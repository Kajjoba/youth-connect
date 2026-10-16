import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * ACCESS CONTROL TESTS
 *
 * This file is the answer to the question "how do you know?"
 *
 * The brief's section 5 incident describes a participant changing an
 * identifier in the browser and reading another team's data. Claiming
 * that is fixed is worth little. What is worth something is a test that
 * performs the attack on every run and fails the build if anyone ever
 * breaks the control.
 *
 * Every test here is written from the attacker's point of view.
 * =====================================================================
 */

let ids;
let amina, kwame, facilitator, admin;

before(async () => {
  await startServer();
  ids = await fixtures();
  [amina, kwame, facilitator, admin] = await Promise.all([
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame),
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.admin)
  ]);
});

after(stopServer);

describe('Insecure Direct Object Reference (OWASP A01)', () => {

  test('the owner can read their own submission feedback', async () => {
    const result = await call(
      `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`,
      { token: amina.token }
    );
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.feedback));
  });

  test('THE ATTACK: another participant pasting that id is refused', async () => {
    const result = await call(
      `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`,
      { token: kwame.token }
    );

    assert.equal(result.status, 404, 'a non-owner must not receive the record');
    assert.equal(result.body.feedback, undefined, 'no feedback may leak in the body');
    assert.ok(
      !result.raw.includes('Solid grasp'),
      'the feedback text must not appear anywhere in the response'
    );
  });

  test('the refusal is 404 not 403, so it is not an existence oracle', async () => {
    // A real-but-forbidden id and a completely fake id must be
    // indistinguishable. If they differ, an attacker can enumerate valid
    // identifiers by watching status codes, even though every request
    // is blocked.
    const real = await call(
      `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`,
      { token: kwame.token }
    );
    const fake = await call(
      '/api/assessments/submissions/00000000-0000-4000-8000-000000000000/feedback',
      { token: kwame.token }
    );

    assert.equal(real.status, fake.status);
    assert.equal(real.body.error.code, fake.body.error.code);
  });

  test('a malformed identifier is refused, not a 500', async () => {
    // A non-UUID makes Postgres throw. If that surfaces as a 500 with a
    // stack trace, the error page itself becomes reconnaissance.
    const result = await call(
      '/api/assessments/submissions/not-a-uuid/feedback',
      { token: kwame.token }
    );
    assert.equal(result.status, 404);
    assert.ok(!result.raw.toLowerCase().includes('syntax'), 'no database detail may leak');
  });

  test('an unauthenticated caller gets 401, never data', async () => {
    const result = await call(
      `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`
    );
    assert.equal(result.status, 401);
  });

  test('a forged token is rejected', async () => {
    // Same shape as a real JWT, signed with the wrong key.
    const forged = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
      + '.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsInN0YXR1cyI6ImFjdGl2ZSJ9'
      + '.not_a_valid_signature';
    const result = await call('/api/me/progress', { token: forged });
    assert.equal(result.status, 401);
  });

  test('a participant cannot grade their own submission', async () => {
    const result = await call(
      `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`,
      { method: 'POST', token: amina.token, body: { body: 'Giving myself full marks.' } }
    );
    assert.ok([403, 404].includes(result.status), `expected refusal, got ${result.status}`);
  });

  test('a participant cannot edit an activity they do not own', async () => {
    const result = await call(`/api/activities/${ids.activityId}`, {
      method: 'PATCH',
      token: kwame.token,
      body: { title: 'Owned by an attacker' }
    });
    assert.ok([403, 404].includes(result.status));

    const check = await query('SELECT title FROM activities WHERE id = $1', [ids.activityId]);
    assert.equal(check.rows[0].title, 'AI Literacy Foundations', 'the title must be unchanged');
  });

  test('a participant cannot reach the admin security console', async () => {
    const result = await call('/api/admin/security', { token: kwame.token });
    assert.equal(result.status, 403);
  });

  test('an admin can reach it', async () => {
    const result = await call('/api/admin/security', { token: admin.token });
    assert.equal(result.status, 200);
  });
});

describe('Detection, not just prevention', () => {

  test('every denied attempt is written to the audit trail', async () => {
    const before = await query(
      `SELECT count(*)::int AS n FROM access_audit WHERE allowed = FALSE`
    );

    await call(`/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`, {
      token: kwame.token
    });

    // The audit write is fire-and-forget so the request is not blocked
    // on it. Give it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await query(
      `SELECT count(*)::int AS n FROM access_audit WHERE allowed = FALSE`
    );
    assert.ok(after.rows[0].n > before.rows[0].n, 'the denial must be recorded');
  });

  test('repeated probing surfaces as an enumeration pattern', async () => {
    // Four distinct targets, all refused.
    const targets = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444'
    ];
    for (const target of targets) {
      await call(`/api/assessments/submissions/${target}/feedback`, { token: kwame.token });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    const result = await call('/api/admin/security?window=60&threshold=3', {
      token: admin.token
    });

    assert.equal(result.status, 200);
    const flagged = result.body.suspects.find((row) => row.actor_id === kwame.user.id);
    assert.ok(flagged, 'the probing account must be flagged');
    assert.ok(Number(flagged.distinct_targets) >= 3);
  });
});

describe('Mass assignment and privilege escalation', () => {

  test('a participant cannot promote themselves via the profile endpoint', async () => {
    await call(`/api/profiles/${kwame.user.id}`, {
      method: 'PATCH',
      token: kwame.token,
      body: { headline: 'Trying my luck', role: 'admin', status: 'active' }
    });

    const check = await query('SELECT role FROM users WHERE id = $1', [kwame.user.id]);
    assert.equal(check.rows[0].role, 'participant', 'role must be unchanged');
  });

  test('a participant cannot edit another participant profile', async () => {
    const result = await call(`/api/profiles/${amina.user.id}`, {
      method: 'PATCH',
      token: kwame.token,
      body: { headline: 'Defaced' }
    });
    assert.ok([403, 404].includes(result.status));
  });

  test('quiz answer keys are never sent to a participant', async () => {
    // If correct_key reaches the browser, the assessment is decorative.
    const result = await call(`/api/assessments/${ids.assessmentId}`, { token: amina.token });
    assert.equal(result.status, 200);
    assert.ok(!result.raw.includes('correct_key'), 'the answer key must not be serialised');
    for (const question of result.body.questions) {
      assert.equal(question.correct_key, undefined);
    }
  });

  test('phone numbers are hidden from other participants', async () => {
    const mine = await call(`/api/profiles/${kwame.user.id}`, { token: kwame.token });
    assert.ok('phone' in mine.body.profile, 'the owner sees their own contact details');

    const theirs = await call(`/api/profiles/${amina.user.id}`, { token: kwame.token });
    if (theirs.status === 200) {
      assert.equal(theirs.body.profile.phone, undefined, 'contact details must not leak');
    }
  });
});

describe('Injection and input handling', () => {

  test('SQL injection in a search parameter does not execute', async () => {
    const result = await call(
      `/api/activities?q=${encodeURIComponent("'; DROP TABLE users; --")}`,
      { token: amina.token }
    );
    assert.equal(result.status, 200);

    const survived = await query(`SELECT count(*)::int AS n FROM users`);
    assert.ok(survived.rows[0].n > 0, 'the users table must still exist');
  });

  test('an oversized body is rejected rather than buffered', async () => {
    const result = await call('/api/activities', {
      method: 'POST',
      token: facilitator.token,
      body: { title: 'x'.repeat(400_000), summary: 'too big' }
    });
    assert.ok(result.status >= 400, 'a 256kb ceiling applies');
  });

  test('validation errors name the offending fields', async () => {
    const result = await call('/api/auth/register', {
      method: 'POST',
      body: { email: 'not-an-email', password: 'short', fullName: '', country: 'XXX' }
    });
    assert.equal(result.status, 422);
    assert.ok(result.body.error.details, 'field-level detail helps the user fix it');
  });

  test('errors carry a request id but never a stack trace', async () => {
    const result = await call('/api/activities/00000000-0000-4000-8000-000000000000', {
      token: amina.token
    });
    assert.ok(result.body.error.requestId, 'support needs a correlation id');
    assert.ok(!result.raw.includes('at Object.'), 'no stack frames may reach the client');
  });
});

describe('Security headers', () => {
  test('the API sets the headers a reviewer will check for', async () => {
    const result = await call('/api/health');
    assert.ok(result.headers.get('content-security-policy'), 'CSP present');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-powered-by'), null, 'server technology not advertised');
    assert.ok(result.headers.get('x-request-id'), 'requests are traceable');
  });
});
