import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * MIGRATION 015: a designated final quiz gates the certificate
 *
 * Feature request from the field (CAT 1, 18 Oct 2026): every course
 * should allow a quiz per week, plus one final quiz at the end, and
 * passing THAT final quiz should be what earns the certificate rather
 * than needing every weekly quiz passed.
 *
 * Everything here runs against activities this file creates itself and
 * deletes in its own `after`, never against the shared seeded "AI
 * Literacy" fixture other test files mutate — two suites fighting over
 * requires_pass on the same row is exactly the kind of order-dependent
 * flakiness this project's test log already warns about.
 * =====================================================================
 */

let facilitator, amina;
const createdActivityIds = [];

before(async () => {
  await startServer();
  [facilitator, amina] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina)
  ]);
});

after(async () => {
  for (const id of createdActivityIds) {
    await query('DELETE FROM activities WHERE id = $1', [id]).catch(() => {});
  }
  await stopServer();
});

/** Creates a published, certificate-awarding course owned by the facilitator. */
async function createCourse(title) {
  const created = await call('/api/activities', {
    method: 'POST',
    token: facilitator.token,
    body: {
      title,
      summary: 'A throwaway course created and torn down by the test suite.',
      type: 'course',
      estimatedMinutes: 60,
      awardsCertificate: true,
      requiresPass: true
    }
  });
  assert.equal(created.status, 201, 'the course must be created');
  const id = created.body.activity.id;
  createdActivityIds.push(id);

  const published = await call(`/api/activities/${id}`, {
    method: 'PATCH', token: facilitator.token, body: { status: 'published' }
  });
  assert.equal(published.status, 200, 'the course must publish');

  return id;
}

/** Creates a single-question quiz on the given activity. */
async function createQuiz(activityId, { title, isFinal }) {
  const result = await call(`/api/activities/${activityId}/assessments`, {
    method: 'POST',
    token: facilitator.token,
    body: {
      title,
      isFinal,
      questions: [{
        prompt: `${title} - only question`,
        options: [{ key: 'a', text: 'Correct' }, { key: 'b', text: 'Wrong' }],
        correctKey: 'a',
        points: 1
      }]
    }
  });
  assert.equal(result.status, 201, `the "${title}" quiz must be created`);
  return result.body.assessment;
}

/** Fetches the (single) question id of a quiz, as the signed-in participant. */
async function questionIdFor(assessmentId, token) {
  const result = await call(`/api/assessments/${assessmentId}`, { token });
  assert.equal(result.status, 200);
  return result.body.questions[0].id;
}

async function submit(assessmentId, token, selected) {
  const questionId = await questionIdFor(assessmentId, token);
  return call(`/api/assessments/${assessmentId}/submissions`, {
    method: 'POST', token, body: { answers: { [questionId]: selected } }
  });
}

async function markCompleted(userId, activityId) {
  await query(
    `UPDATE enrolments SET status = 'completed', completed_at = now()
      WHERE user_id = $1 AND activity_id = $2`,
    [userId, activityId]
  );
}

describe('Authoring a final quiz', () => {

  test('a quiz created plain is not final', async () => {
    const activityId = await createCourse('Plain quiz probe');
    const quiz = await createQuiz(activityId, { title: 'Week 1', isFinal: false });
    assert.equal(quiz.is_final, false);
  });

  test('checking "final" on a second quiz unsets it on the first', async () => {
    const activityId = await createCourse('Single-final probe');
    const first = await createQuiz(activityId, { title: 'First final', isFinal: true });
    assert.equal(first.is_final, true);

    const second = await createQuiz(activityId, { title: 'Second final', isFinal: true });
    assert.equal(second.is_final, true);

    const list = await call(`/api/activities/${activityId}/assessments`, { token: facilitator.token });
    const finals = list.body.assessments.filter((a) => a.is_final);
    assert.equal(finals.length, 1, 'only one assessment on a course may be final');
    assert.equal(finals[0].id, second.id, 'the most recently checked quiz is the one that stays final');
  });

  test('editing a quiz to toggle "final" off is respected', async () => {
    const activityId = await createCourse('Un-final probe');
    const quiz = await createQuiz(activityId, { title: 'Was final', isFinal: true });

    const edited = await call(`/api/activities/${activityId}/assessments/${quiz.id}`, {
      method: 'PATCH',
      token: facilitator.token,
      body: {
        title: quiz.title,
        isFinal: false,
        questions: [{
          prompt: 'Still the only question',
          options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }],
          correctKey: 'a',
          points: 1
        }]
      }
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.assessment.is_final, false);
  });
});

describe('The certificate follows the final quiz, not every quiz', () => {

  test('passing the final quiz earns the certificate even after failing the weekly one', async () => {
    const activityId = await createCourse('Final-gates-it probe');
    const weekly = await createQuiz(activityId, { title: 'Week 1 check-in', isFinal: false });
    const finalQuiz = await createQuiz(activityId, { title: 'Final capstone', isFinal: true });

    const enrolled = await call(`/api/activities/${activityId}/enrolments`, {
      method: 'POST', token: amina.token
    });
    assert.equal(enrolled.status, 201);

    // Amina fails the weekly quiz on purpose...
    const weeklyAttempt = await submit(weekly.id, amina.token, 'b');
    assert.equal(weeklyAttempt.status, 201);
    assert.equal(weeklyAttempt.body.passed, false, 'the weekly attempt must actually fail');

    // ...but passes the final.
    const finalAttempt = await submit(finalQuiz.id, amina.token, 'a');
    assert.equal(finalAttempt.status, 201);
    assert.equal(finalAttempt.body.passed, true, 'the final attempt must actually pass');

    await markCompleted(amina.user.id, activityId);

    const certificate = await call(`/api/activities/${activityId}/certificate`, {
      method: 'POST', token: amina.token
    });
    assert.equal(certificate.status, 201,
      'the final quiz alone should be enough once a course designates one');
  });

  test('failing the final quiz withholds the certificate even after passing the weekly one', async () => {
    const activityId = await createCourse('Final-still-required probe');
    const weekly = await createQuiz(activityId, { title: 'Week 1 check-in', isFinal: false });
    const finalQuiz = await createQuiz(activityId, { title: 'Final capstone', isFinal: true });

    await call(`/api/activities/${activityId}/enrolments`, { method: 'POST', token: amina.token });

    const weeklyAttempt = await submit(weekly.id, amina.token, 'a');
    assert.equal(weeklyAttempt.body.passed, true, 'the weekly attempt must actually pass');

    const finalAttempt = await submit(finalQuiz.id, amina.token, 'b');
    assert.equal(finalAttempt.body.passed, false, 'the final attempt must actually fail');

    await markCompleted(amina.user.id, activityId);

    const certificate = await call(`/api/activities/${activityId}/certificate`, {
      method: 'POST', token: amina.token
    });
    assert.equal(certificate.status, 400,
      'passing every OTHER quiz must not substitute for the final one');

    const none = await query(
      `SELECT count(*)::int AS n FROM recognitions WHERE user_id = $1 AND activity_id = $2`,
      [amina.user.id, activityId]
    );
    assert.equal(none.rows[0].n, 0, 'nothing may be issued');
  });

  test('with no final quiz designated, the old all-assessments rule still applies', async () => {
    const activityId = await createCourse('No-final-fallback probe');
    const only = await createQuiz(activityId, { title: 'Only quiz, never marked final', isFinal: false });

    await call(`/api/activities/${activityId}/enrolments`, { method: 'POST', token: amina.token });

    const attempt = await submit(only.id, amina.token, 'a');
    assert.equal(attempt.body.passed, true);

    await markCompleted(amina.user.id, activityId);

    const certificate = await call(`/api/activities/${activityId}/certificate`, {
      method: 'POST', token: amina.token
    });
    assert.equal(certificate.status, 201,
      'a course with no designated final quiz must behave exactly as it did before migration 015');
  });
});
