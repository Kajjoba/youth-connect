import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * RECOGNITION
 *
 * A certificate is only worth something if three things hold:
 *
 *   It cannot be obtained without earning it.
 *   It cannot be forged or altered after issue.
 *   Someone with no account can check it.
 *
 * Each is tested below. The third is the one most platforms get wrong
 * by putting verification behind a login, which makes the credential
 * useless to the employer it exists to convince.
 * =====================================================================
 */

let ids, amina, joseph, admin;
let certificateId, verificationCode;

before(async () => {
  await startServer();
  ids = await fixtures();
  [amina, joseph, admin] = await Promise.all([
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.joseph),
    signIn(ACCOUNTS.admin)
  ]);
});

after(stopServer);

describe('Eligibility', () => {

  test('an unfinished activity earns nothing', async () => {
    await query(
      `UPDATE enrolments SET status = 'in_progress', completed_at = NULL
        WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );

    const result = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: joseph.token
    });

    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /section/i,
      'the refusal must say what is missing');
  });

  test('completion without passing the assessment earns nothing', async () => {
    // requires_pass defaults true, and the seeded activity has a quiz.
    //
    // The recognitions delete matters: issue_certificate_if_earned is
    // idempotent and returns an EXISTING credential rather than
    // minting a second one, so a leftover certificate from another
    // file would make this return 201 and the test would be asserting
    // nothing. Arrange the precondition, do not assume it.
    await query(
      `DELETE FROM recognitions WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );
    await query(
      `UPDATE activities SET requires_pass = TRUE WHERE id = $1`, [ids.activityId]
    );
    await query(
      `DELETE FROM submissions WHERE user_id = $1 AND assessment_id = $2`,
      [joseph.user.id, ids.assessmentId]
    );
    await query(
      `UPDATE enrolments SET status = 'completed', completed_at = now()
        WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );

    const result = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: joseph.token
    });

    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /assessment/i);

    const none = await query(
      `SELECT count(*)::int AS n FROM recognitions WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );
    assert.equal(none.rows[0].n, 0, 'nothing may be issued');
  });

  test('a completed and passed activity earns a certificate', async () => {
    // Amina has a graded submission at 67 against a pass mark of 60.
    await query(
      `UPDATE enrolments SET status = 'completed', completed_at = now()
        WHERE user_id = $1 AND activity_id = $2`,
      [amina.user.id, ids.activityId]
    );

    const result = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: amina.token
    });

    assert.equal(result.status, 201);
    assert.ok(result.body.certificate.verification_code);
    assert.equal(result.body.certificate.recipient_name, 'Amina Uwase');

    certificateId = result.body.certificate.id;
    verificationCode = result.body.certificate.verification_code;
  });

  test('claiming twice returns the same credential, not a second one', async () => {
    const again = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: amina.token
    });
    assert.equal(again.body.certificate.verification_code, verificationCode);

    const count = await query(
      `SELECT count(*)::int AS n FROM recognitions
        WHERE user_id = $1 AND activity_id = $2 AND revoked_at IS NULL`,
      [amina.user.id, ids.activityId]
    );
    assert.equal(count.rows[0].n, 1, 'one achievement, one credential');
  });

  test('the verification code avoids ambiguous characters', async () => {
    // Someone will read this off printed paper and type it. 0/O and
    // 1/I/L are where transcription errors come from.
    assert.match(verificationCode, /^YCP(-[A-Z2-9]{4}){3}$/);
    assert.ok(!/[01OIL]/.test(verificationCode.replace('YCP', '')),
      'ambiguous characters must not appear');
  });
});

describe('The certificate is a snapshot', () => {

  test('renaming the course does not rewrite issued certificates', async () => {
    // ADR-017. A credential whose text changes retroactively is not
    // evidence of anything.
    const original = await query(
      `SELECT activity_title FROM recognitions WHERE id = $1`, [certificateId]
    );

    await query(
      `UPDATE activities SET title = 'Renamed After Issue' WHERE id = $1`,
      [ids.activityId]
    );

    const after = await query(
      `SELECT activity_title FROM recognitions WHERE id = $1`, [certificateId]
    );
    assert.equal(after.rows[0].activity_title, original.rows[0].activity_title,
      'the certificate keeps the title it was awarded under');

    await query(
      `UPDATE activities SET title = 'AI Literacy Foundations' WHERE id = $1`,
      [ids.activityId]
    );
  });

  test('renaming the participant does not rewrite issued certificates', async () => {
    await query(`UPDATE profiles SET full_name = 'Changed Name' WHERE user_id = $1`,
      [amina.user.id]);

    const after = await query(
      `SELECT recipient_name FROM recognitions WHERE id = $1`, [certificateId]
    );
    assert.equal(after.rows[0].recipient_name, 'Amina Uwase',
      'a registrar would not retroactively alter an award either');

    await query(`UPDATE profiles SET full_name = 'Amina Uwase' WHERE user_id = $1`,
      [amina.user.id]);
  });
});

describe('Download', () => {

  test('the owner can download a real PDF', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`, {
      token: amina.token
    });

    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'application/pdf');
    assert.match(result.headers.get('content-disposition') ?? '', /^attachment/);
    assert.ok(result.raw.startsWith('%PDF'), 'the bytes are actually a PDF');
    assert.ok(result.bytes > 1000, `expected a real document, got ${result.bytes} bytes`);
  });

  test('the filename carries the verification code', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`, {
      token: amina.token
    });
    assert.ok((result.headers.get('content-disposition') ?? '').includes(verificationCode),
      'so a saved file can be traced back without opening it');
  });

  test('THE ATTACK: another participant cannot download it', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`, {
      token: joseph.token
    });
    assert.equal(result.status, 404);
  });

  test('an unauthenticated caller cannot download it', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`);
    assert.equal(result.status, 401);
  });

  test('the PDF is not cached by any intermediary', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`, {
      token: amina.token
    });
    const cacheControl = result.headers.get('cache-control') ?? '';
    assert.ok(cacheControl.includes('private') && cacheControl.includes('no-store'));
  });
});

describe('Public verification', () => {

  test('a valid code verifies with NO account', async () => {
    // The whole point. A credential only checkable by someone with a
    // login is not a credential.
    const result = await call(`/api/verify/${verificationCode}`);

    assert.equal(result.status, 200);
    assert.equal(result.body.valid, true);
    assert.equal(result.body.certificate.recipientName, 'Amina Uwase');
    assert.ok(result.body.certificate.courseTitle);
  });

  test('verification discloses the achievement and nothing else', async () => {
    // Someone holding one code learns about one achievement. They must
    // not learn the person's email, country, user id or other awards.
    const result = await call(`/api/verify/${verificationCode}`);
    const body = result.raw.toLowerCase();

    assert.ok(!body.includes('@ycp.africa'), 'no email address');
    assert.ok(!body.includes('user_id'), 'no internal identifier');
    assert.ok(!body.includes('"country"'), 'no location');
    assert.ok(!body.includes('phone'), 'no contact details');
  });

  test('the code is case insensitive', async () => {
    // It will be typed off paper, often in lower case.
    const result = await call(`/api/verify/${verificationCode.toLowerCase()}`);
    assert.equal(result.body.valid, true);
  });

  test('an unknown code reports invalid rather than erroring', async () => {
    const result = await call('/api/verify/YCP-ZZZZ-ZZZZ-ZZZZ');
    assert.equal(result.status, 404);
    assert.equal(result.body.valid, false);
  });

  test('a malformed code does not produce a 500', async () => {
    const result = await call("/api/verify/'; DROP TABLE recognitions; --");
    assert.ok(result.status === 404 || result.status === 400);

    const survived = await query(`SELECT count(*)::int AS n FROM recognitions`);
    assert.ok(survived.rows[0].n >= 0, 'the table still exists');
  });
});

describe('Revocation', () => {

  test('a revoked certificate reports as revoked, not as missing', async () => {
    // Deleting it would leave an employer holding the PDF with a code
    // that says "no such certificate", which is indistinguishable from
    // a forgery. Revocation tells them the truth.
    const revoked = await call(`/api/admin/certificates/${certificateId}/revoke`, {
      method: 'POST',
      token: admin.token,
      body: { reason: 'Issued in error during testing.' }
    });
    assert.equal(revoked.status, 200);

    const check = await call(`/api/verify/${verificationCode}`);
    assert.equal(check.body.valid, false);
    assert.match(check.body.reason, /revoked/i);
    assert.ok(check.body.revokedAt, 'and when');
  });

  test('a revoked certificate cannot be downloaded', async () => {
    const result = await call(`/api/certificates/${certificateId}/download`, {
      token: amina.token
    });
    assert.equal(result.status, 403);
  });

  test('revocation requires a reason', async () => {
    const result = await call(`/api/admin/certificates/${certificateId}/revoke`, {
      method: 'POST', token: admin.token, body: { reason: 'x' }
    });
    assert.equal(result.status, 400);
  });

  test('a participant cannot revoke a certificate', async () => {
    const result = await call(`/api/admin/certificates/${certificateId}/revoke`, {
      method: 'POST', token: amina.token, body: { reason: 'Trying my luck here.' }
    });
    assert.equal(result.status, 403);
  });

  test('a revoked award does not block re-issue', async () => {
    // The unique index excludes revoked rows on purpose: an award
    // withdrawn in error must be re-issuable.
    const reissued = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: amina.token
    });
    assert.equal(reissued.status, 201);
    assert.notEqual(reissued.body.certificate.verification_code, verificationCode,
      'a new award gets a new code');
  });
});

describe('The participant view', () => {

  test('a participant can list their certificates', async () => {
    const result = await call('/api/me/certificates', { token: amina.token });
    assert.equal(result.status, 200);
    assert.ok(result.body.certificates.length >= 1);

    const live = result.body.certificates.filter((c) => !c.revoked_at);
    assert.ok(live.length >= 1, 'the active credential is listed');
  });

  test('certificates are private to their owner', async () => {
    const result = await call('/api/me/certificates', { token: joseph.token });
    const codes = result.body.certificates.map((c) => c.verification_code);
    assert.ok(!codes.includes(verificationCode), 'no cross-account leakage');
  });
});
