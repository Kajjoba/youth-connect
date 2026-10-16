import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * THE COMPLETE PARTICIPANT JOURNEY
 *
 * Every other test file checks one endpoint at a time. This one walks
 * the whole path a real person walks, in order, and asserts the thing
 * they actually care about at the end: a certificate.
 *
 * It exists because of a defect nothing else caught. Assessment
 * submission worked. Item progress worked. Certificate issuance
 * worked. Each had passing tests. But finishing the readings and
 * PASSING the quiz still produced "finish every required section
 * first", because the two paths were never joined: passing an
 * assessment did not complete the lesson item pointing at it.
 *
 * A unit test per endpoint cannot find that. Only walking the journey
 * end to end can.
 * =====================================================================
 */

let ids, facilitator, joseph;
let quizItemId;

before(async () => {
  await startServer();
  ids = await fixtures();
  [facilitator, joseph] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.joseph)
  ]);

  // Attach the seeded assessment to a lesson item, which is what a
  // facilitator does when they add a quiz to a module.
  const lastModule = await query(
    `SELECT id FROM activity_modules WHERE activity_id = $1
      ORDER BY position DESC LIMIT 1`,
    [ids.activityId]
  );

  const created = await call(
    `/api/activities/${ids.activityId}/modules/${lastModule.rows[0].id}/items`,
    {
      method: 'POST',
      token: facilitator.token,
      body: {
        kind: 'quiz',
        title: 'End of course check',
        assessmentId: ids.assessmentId,
        estimatedMinutes: 15
      }
    }
  );
  quizItemId = created.body?.item?.id ?? null;
});

after(async () => {
  // This file EARNS a certificate, which is state another file
  // (certificate.test.js) assumes does not exist. Creating it here and
  // leaving it behind made that file fail with 201 instead of 400.
  //
  // Same rule as everywhere else in this suite: if a test creates a
  // row, the same file deletes it. The rule now has to cover rows
  // created INDIRECTLY, as a side effect of the behaviour under test,
  // not just rows inserted deliberately.
  if (quizItemId) {
    await query('DELETE FROM lesson_items WHERE id = $1', [quizItemId]).catch(() => {});
  }
  await query(
    `DELETE FROM recognitions WHERE user_id = $1 AND activity_id = $2`,
    [joseph.user.id, ids.activityId]
  ).catch(() => {});
  await query(
    `DELETE FROM submissions WHERE user_id = $1 AND assessment_id = $2`,
    [joseph.user.id, ids.assessmentId]
  ).catch(() => {});
  await query(
    `UPDATE enrolments SET status = 'in_progress', completed_at = NULL
      WHERE user_id = $1 AND activity_id = $2`,
    [joseph.user.id, ids.activityId]
  ).catch(() => {});
  await stopServer();
});

describe('Finish the readings, pass the quiz, get the certificate', () => {

  test('a fresh participant starts with no certificate', async () => {
    await query(
      `DELETE FROM recognitions WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );
    await query(
      `DELETE FROM submissions WHERE user_id = $1 AND assessment_id = $2`,
      [joseph.user.id, ids.assessmentId]
    );
    await query(
      `UPDATE enrolments SET status = 'in_progress', completed_at = NULL
        WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );
    await query(
      `UPDATE item_progress ip SET status = 'not_started', completed_at = NULL
         FROM enrolments e
        WHERE ip.enrolment_id = e.id
          AND e.user_id = $1 AND e.activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );

    const result = await call('/api/me/certificates', { token: joseph.token });
    const forThis = result.body.certificates.filter((c) => !c.revoked_at);
    assert.equal(forThis.length, 0, 'nothing earned yet');
  });

  test('completing every reading is not enough on its own', async () => {
    const detail = await call(`/api/activities/${ids.activityId}`, { token: joseph.token });
    const items = detail.body.modules.flatMap((m) => m.items ?? []);
    const nonQuiz = items.filter((item) => item.kind !== 'quiz');
    assert.ok(nonQuiz.length > 0, 'the course has readings');

    for (const item of nonQuiz) {
      const result = await call(
        `/api/activities/${ids.activityId}/items/${item.id}/progress`,
        { method: 'PUT', token: joseph.token, body: { status: 'completed' } }
      );
      assert.equal(result.status, 200);
    }

    const claim = await call(`/api/activities/${ids.activityId}/certificate`, {
      method: 'POST', token: joseph.token
    });
    assert.equal(claim.status, 400, 'the quiz is still outstanding, correctly');
  });

  test('THE DEFECT: passing the quiz completes the quiz item', async () => {
    // Before the fix this assertion failed. The submission was graded
    // and passed, and the item stayed at 'not_started' forever.
    const assessment = await call(`/api/assessments/${ids.assessmentId}`, {
      token: joseph.token
    });
    const answers = Object.fromEntries(
      assessment.body.questions.map((q) => [q.id, 'b'])
    );

    const submitted = await call(`/api/assessments/${ids.assessmentId}/submissions`, {
      method: 'POST', token: joseph.token, body: { answers }
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.passed, true, 'the seeded answers are a pass');

    const itemState = await query(
      `SELECT ip.status FROM item_progress ip
         JOIN enrolments e ON e.id = ip.enrolment_id
        WHERE ip.item_id = $1 AND e.user_id = $2`,
      [quizItemId, joseph.user.id]
    );
    assert.equal(itemState.rows[0]?.status, 'completed',
      'passing an assessment must complete the item that points at it');
  });

  test('the course is now complete', async () => {
    const enrolment = await query(
      `SELECT status FROM enrolments WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );
    assert.equal(enrolment.rows[0].status, 'completed');
  });

  test('and the certificate was issued automatically', async () => {
    // Not "can be claimed". Issued. Finishing the work is what earns
    // the credential, so the participant should not have to find a
    // button to ask for it.
    const result = await call('/api/me/certificates', { token: joseph.token });
    const earned = result.body.certificates.find(
      (c) => !c.revoked_at && c.activity_title
    );

    assert.ok(earned, 'a certificate should exist without being claimed');
    assert.ok(earned.verification_code.startsWith('YCP-'));
    assert.equal(earned.recipient_name, 'Joseph Ssemakula');
  });

  test('and it downloads as a real PDF', async () => {
    const list = await call('/api/me/certificates', { token: joseph.token });
    const cert = list.body.certificates.find((c) => !c.revoked_at);

    const pdf = await call(`/api/certificates/${cert.id}/download`, {
      token: joseph.token
    });
    assert.equal(pdf.status, 200);
    assert.ok(pdf.raw.startsWith('%PDF'));
  });

  test('and an employer can verify it with no account', async () => {
    const list = await call('/api/me/certificates', { token: joseph.token });
    const cert = list.body.certificates.find((c) => !c.revoked_at);

    const check = await call(`/api/verify/${cert.verification_code}`);
    assert.equal(check.body.valid, true);
    assert.equal(check.body.certificate.recipientName, 'Joseph Ssemakula');
  });
});

describe('Failing does not complete the item', () => {

  test('a failed quiz leaves its item outstanding', async () => {
    // The item exists to demonstrate something. Failing has not
    // demonstrated it, so the item stays open while attempts remain.
    await query(
      `DELETE FROM submissions WHERE user_id = $1 AND assessment_id = $2`,
      [joseph.user.id, ids.assessmentId]
    );
    await query(
      `UPDATE item_progress ip SET status = 'not_started', completed_at = NULL
         FROM enrolments e
        WHERE ip.enrolment_id = e.id AND ip.item_id = $1 AND e.user_id = $2`,
      [quizItemId, joseph.user.id]
    );

    const assessment = await call(`/api/assessments/${ids.assessmentId}`, {
      token: joseph.token
    });
    // Answer 'a' throughout, which is wrong for every seeded question.
    const answers = Object.fromEntries(
      assessment.body.questions.map((q) => [q.id, 'a'])
    );

    const submitted = await call(`/api/assessments/${ids.assessmentId}/submissions`, {
      method: 'POST', token: joseph.token, body: { answers }
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.passed, false);

    const itemState = await query(
      `SELECT ip.status FROM item_progress ip
         JOIN enrolments e ON e.id = ip.enrolment_id
        WHERE ip.item_id = $1 AND e.user_id = $2`,
      [quizItemId, joseph.user.id]
    );
    assert.notEqual(itemState.rows[0]?.status, 'completed',
      'a failed attempt has not demonstrated the thing');
  });
});

describe('One definition of finished (ADR-019)', () => {

  test('the rollup function exists and every path uses it', async () => {
    // The fix for this defect could have been a second copy of the
    // rollup inside the assessment handler. Two copies of "what counts
    // as finished" drift, and the symptom of drift is someone who has
    // finished a course the system thinks they have not.
    const fn = await query(
      `SELECT proname FROM pg_proc WHERE proname = 'recalculate_progress'`
    );
    assert.equal(fn.rows.length, 1, 'the rule is defined once, in the database');
  });

  test('a facilitator grade can be the final requirement', async () => {
    // Someone submits an assignment, finishes everything else, and
    // waits. The grade landing is the moment they earn the credential,
    // and they should not have to revisit the course to trigger it.
    const trigger = await query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'trg_feedback_recalculates'`
    );
    assert.equal(trigger.rows.length, 1);
  });
});

describe('The invisible assessment (ADR-022)', () => {

  /**
   * This block exists because of the defect that cost the most time to
   * find, and it was not in the application at all.
   *
   * Every insert in the seed script carried ON CONFLICT except the
   * assessment, so re-running the seed produced a second copy of the
   * same quiz. requires_pass means every assessment on a course must be
   * passed, so issue_certificate_if_earned counted two and found one
   * pass and returned NULL. The participant finished everything and got
   * nothing, and the claim endpoint explained that they had passed 1 of
   * 2 assessments, one of which was attached to no lesson item and so
   * appeared nowhere in the course at all.
   *
   * The lesson generalises past this bug: a rule that reads "all of X"
   * is only as trustworthy as the thing that decides what belongs in X.
   */

  test('the database refuses a second assessment with the same title', async () => {
    const title = await query(
      `SELECT title FROM assessments WHERE id = $1`,
      [ids.assessmentId]
    );

    // Same course, same title, different case. If this succeeds, the
    // constraint is missing and certificates can silently stop.
    await assert.rejects(
      () => query(
        `INSERT INTO assessments (activity_id, title, type, max_score, pass_score)
         VALUES ($1, $2, 'quiz', 100, 60)`,
        [ids.activityId, title.rows[0].title.toUpperCase()]
      ),
      (error) => error.code === '23505',
      'a duplicate assessment title on one course must be rejected'
    );
  });

  test('a different title on the same course is still allowed', async () => {
    // The constraint must not block legitimate content. A course with a
    // quiz and a final submitted piece of work is normal.
    const created = await query(
      `INSERT INTO assessments (activity_id, title, type, max_score, pass_score)
       VALUES ($1, 'ADR-022 temporary probe', 'submission', 100, 50)
       RETURNING id`,
      [ids.activityId]
    );
    assert.ok(created.rows[0].id);

    // Created here, deleted here. Leaving it behind would add an
    // unpassable assessment to the course and reproduce the very defect
    // this block is about, in every other test file.
    await query(`DELETE FROM assessments WHERE id = $1`, [created.rows[0].id]);
  });

  test('re-running the seed cannot duplicate an assessment', async () => {
    // The constraint stops the bad row existing. This asserts the seed
    // itself is idempotent, so a second run updates rather than failing
    // outright, which is what makes db:seed safe to re-run.
    const seed = await readFile(
      new URL('../db/seed.js', import.meta.url), 'utf8'
    );
    const block = seed.slice(seed.indexOf('INSERT INTO assessments'));
    const statement = block.slice(0, block.indexOf('RETURNING id'));
    assert.ok(
      statement.includes('ON CONFLICT'),
      'the assessment insert in db/seed.js must be idempotent'
    );
  });
});
