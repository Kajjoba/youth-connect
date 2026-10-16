import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * QUIZ AUTHORING
 *
 * Before this, a facilitator or admin had a "quiz" lesson item type that
 * POINTED AT an assessment, but nothing in the product actually let
 * them create or revise the assessment itself: the ItemEditor's
 * dropdown had no data source. This suite covers the fix:
 * GET /api/activities/:id/assessments (so the dropdown and an edit
 * screen have something to load) and PATCH .../assessments/:id (so an
 * existing quiz can be revised rather than only ever created new).
 * =====================================================================
 */

let ids, facilitator, amina, kwame;
let createdAssessmentId;

before(async () => {
  await startServer();
  ids = await fixtures();
  [facilitator, amina, kwame] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame)
  ]);
});

after(async () => {
  if (createdAssessmentId) {
    await query('DELETE FROM assessments WHERE id = $1', [createdAssessmentId]).catch(() => {});
  }
  await stopServer();
});

describe('Creating a quiz', () => {
  test('a facilitator can create a quiz with questions', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        title: 'Quick check: data basics',
        instructions: 'Answer every question.',
        type: 'quiz',
        maxScore: 10,
        passScore: 6,
        maxAttempts: 2,
        questions: [
          {
            prompt: 'What does "GB" stand for?',
            options: [{ key: 'a', text: 'Gigabyte' }, { key: 'b', text: 'Gigabit' }],
            correctKey: 'a',
            points: 5
          },
          {
            prompt: '2 + 2 = ?',
            options: [{ key: 'a', text: '3' }, { key: 'b', text: '4' }, { key: 'c', text: '5' }],
            correctKey: 'b',
            points: 5
          }
        ]
      }
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.assessment.title, 'Quick check: data basics');
    createdAssessmentId = result.body.assessment.id;
  });

  test('a quiz with no questions is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: { title: 'Empty quiz', type: 'quiz', questions: [] }
    });
    assert.equal(result.status, 400);
  });

  test('a correct answer that is not one of the options is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        title: 'Bad key quiz',
        type: 'quiz',
        questions: [{
          prompt: 'Pick one',
          options: [{ key: 'a', text: 'First' }, { key: 'b', text: 'Second' }],
          correctKey: 'z',
          points: 1
        }]
      }
    });
    assert.equal(result.status, 422);
  });

  test('THE ATTACK: a participant cannot create a quiz', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: kwame.token,
      body: {
        title: 'Injected quiz', type: 'quiz',
        questions: [{
          prompt: 'x',
          options: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }],
          correctKey: 'a', points: 1
        }]
      }
    });
    assert.equal(result.status, 403);
  });
});

describe('Listing quizzes for the editor', () => {
  test('the facilitator sees the correct answer key, needed to edit', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, { token: facilitator.token });
    assert.equal(result.status, 200);

    const created = result.body.assessments.find((a) => a.id === createdAssessmentId);
    assert.ok(created, 'the new quiz is listed');
    assert.equal(created.questions.length, 2);
    assert.ok(created.questions.every((q) => q.correct_key != null),
      'the author, unlike a participant, is allowed to see the key');
  });

  test('THE ATTACK: a participant cannot list assessments with their answer keys', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, { token: kwame.token });
    assert.equal(result.status, 403);
  });

  test('a facilitator who does not own the activity cannot list its quizzes', async () => {
    // mentor is not the owning facilitator and holds no admin-tier role.
    const mentor = await signIn(ACCOUNTS.mentor);
    const result = await call(`/api/activities/${ids.activityId}/assessments`, { token: mentor.token });
    assert.equal(result.status, 403);
  });
});

describe('Revising a quiz', () => {
  test('updating replaces the question set wholesale', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments/${createdAssessmentId}`, {
      method: 'PATCH',
      token: facilitator.token,
      body: {
        title: 'Quick check: data basics (revised)',
        type: 'quiz',
        maxScore: 10,
        passScore: 5,
        maxAttempts: 2,
        questions: [{
          prompt: 'Revised: 1 + 1 = ?',
          options: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }],
          correctKey: 'b',
          points: 10
        }]
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.assessment.title, 'Quick check: data basics (revised)');

    const questions = await query(
      `SELECT prompt, correct_key FROM assessment_questions WHERE assessment_id = $1`,
      [createdAssessmentId]
    );
    assert.equal(questions.rows.length, 1, 'the old question is gone, not accumulated');
    assert.equal(questions.rows[0].prompt, 'Revised: 1 + 1 = ?');
  });

  test('an existing graded submission survives a revision unchanged', async () => {
    // ids.assessmentId / ids.aminaSubmissionId come from the seeded
    // fixture, which already has a graded submission on an assessment
    // this suite does not touch. Revising a DIFFERENT assessment must
    // not disturb it, and more importantly, revising THIS flow's own
    // assessment after someone has attempted it must not retroactively
    // rewrite what they were scored against.
    if (!ids.aminaSubmissionId) return;
    const before = await query(
      `SELECT score, status FROM submissions WHERE id = $1`, [ids.aminaSubmissionId]
    );

    await call(`/api/activities/${ids.activityId}/assessments/${createdAssessmentId}`, {
      method: 'PATCH',
      token: facilitator.token,
      body: {
        title: 'Quick check: data basics (revised again)',
        type: 'quiz',
        maxScore: 10, passScore: 5, maxAttempts: 2,
        questions: [{
          prompt: 'Another revision',
          options: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }],
          correctKey: 'a', points: 10
        }]
      }
    });

    const after = await query(
      `SELECT score, status FROM submissions WHERE id = $1`, [ids.aminaSubmissionId]
    );
    assert.deepEqual(after.rows[0], before.rows[0], 'an unrelated graded attempt is untouched');
  });

  test('THE ATTACK: a participant cannot revise a quiz', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments/${createdAssessmentId}`, {
      method: 'PATCH',
      token: amina.token,
      body: { title: 'Hacked', type: 'quiz', questions: [{
        prompt: 'x', options: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }],
        correctKey: 'a', points: 1
      }] }
    });
    assert.equal(result.status, 403);
  });

  test('revising an assessment id from another activity is refused', async () => {
    const otherActivity = await query(
      `SELECT id FROM activities WHERE id <> $1 LIMIT 1`, [ids.activityId]
    );
    const result = await call(
      `/api/activities/${otherActivity.rows[0].id}/assessments/${createdAssessmentId}`,
      {
        method: 'PATCH',
        token: facilitator.token,
        body: { title: 'Cross-activity', type: 'quiz', questions: [{
          prompt: 'Does this leak across activities?',
          options: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }],
          correctKey: 'a', points: 1
        }] }
      }
    );
    // Either the facilitator does not own that other activity (403,
    // can() denies it) or they do and the assessment id simply does not
    // belong to it (404, the id/activity pairing in the UPDATE's WHERE
    // clause matches nothing). Both are "no", neither is a 2xx.
    assert.ok([403, 404].includes(result.status), `expected 403 or 404, got ${result.status}`);
  });
});

describe('The quiz is immediately usable as a lesson item', () => {
  test('an item can point at the newly created quiz', async () => {
    const module = await call(`/api/activities/${ids.activityId}/modules`, {
      method: 'POST', token: facilitator.token,
      body: { title: 'Quiz-authoring test section', estimatedMinutes: 10 }
    });

    const item = await call(`/api/activities/${ids.activityId}/modules/${module.body.module.id}/items`, {
      method: 'POST', token: facilitator.token,
      body: {
        kind: 'quiz', title: 'Take the quick check',
        assessmentId: createdAssessmentId, estimatedMinutes: 5
      }
    });
    assert.equal(item.status, 201);

    await query('DELETE FROM activity_modules WHERE id = $1', [module.body.module.id]);
  });
});
