import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * PACING AND GRADES
 *
 * Two features studied from Coursera and adapted rather than copied.
 *
 * The adaptation that matters is ADR-020: deadlines are personalised
 * and soft. A fixed cohort date punishes a participant for their
 * electricity supply. These tests assert that the schedule follows the
 * person, that being behind carries no penalty, and that someone who
 * has fallen behind can start again.
 * =====================================================================
 */

let ids, facilitator, amina, joseph;

before(async () => {
  await startServer();
  ids = await fixtures();
  [facilitator, amina, joseph] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.joseph)
  ]);
});

after(async () => {
  // This file moves enrolment dates around to exercise the schedule.
  // Those dates drive every derived deadline, so leaving them shifted
  // would quietly change what other files see.
  await query(
    `UPDATE enrolments SET enrolled_at = now() - interval '1 day'
      WHERE activity_id = $1 AND user_id = ANY($2)`,
    [ids.activityId, [amina.user.id, joseph.user.id]]
  ).catch(() => {});
  await stopServer();
});

describe('The schedule follows the person, not a calendar', () => {

  test('a participant gets a dated timeline for their course', async () => {
    const result = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: amina.token
    });

    assert.equal(result.status, 200);
    assert.ok(result.body.schedule.length > 0);

    const first = result.body.schedule[0];
    for (const field of ['module_id', 'title', 'due_at', 'status', 'is_overdue']) {
      assert.ok(field in first, `schedule row should carry ${field}`);
    }
  });

  test('two people who enrolled on different days get different deadlines', async () => {
    // The whole point of ADR-020. A cohort calendar would give these
    // two the same date regardless of when they started.
    await query(
      `UPDATE enrolments SET enrolled_at = now() - interval '30 days'
        WHERE user_id = $1 AND activity_id = $2`,
      [amina.user.id, ids.activityId]
    );
    await query(
      `UPDATE enrolments SET enrolled_at = now()
        WHERE user_id = $1 AND activity_id = $2`,
      [joseph.user.id, ids.activityId]
    );

    const hers = await call(`/api/activities/${ids.activityId}/schedule`, { token: amina.token });
    const his = await call(`/api/activities/${ids.activityId}/schedule`, { token: joseph.token });

    const herFirst = new Date(hers.body.schedule[0].due_at);
    const hisFirst = new Date(his.body.schedule[0].due_at);

    assert.ok(herFirst < hisFirst,
      'someone who enrolled a month earlier must have an earlier deadline');
  });

  test('someone who enrolled long ago is flagged behind', async () => {
    const result = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: amina.token
    });
    assert.ok(result.body.summary.behind > 0,
      'a 30-day-old enrolment with incomplete modules is behind schedule');
  });

  test('being behind carries NO penalty', async () => {
    // The most important assertion in this file. Coursera's deadlines
    // are suggestions, and copying that is deliberate: a participant
    // who lost a fortnight to a power cut must not be locked out.
    const detail = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    assert.equal(detail.status, 200, 'the course is still open');

    const items = detail.body.modules.flatMap((m) => m.items ?? []);
    if (items.length) {
      const progress = await call(
        `/api/activities/${ids.activityId}/items/${items[0].id}/progress`,
        { method: 'PUT', token: amina.token, body: { status: 'completed' } }
      );
      assert.equal(progress.status, 200,
        'work can still be completed after a suggested date has passed');
    }
  });

  test('a completed module is never marked behind', async () => {
    const result = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: amina.token
    });
    for (const row of result.body.schedule) {
      if (row.status === 'completed') {
        assert.equal(row.is_overdue, false,
          'finished work cannot be late, whenever it was finished');
      }
    }
  });

  test('resetting moves every deadline at once', async () => {
    // The payoff of deriving deadlines rather than storing them: one
    // UPDATE to one column moves the whole schedule.
    //
    // Arrange the precondition. The previous test completes an item,
    // which can complete the course, and reset correctly refuses on a
    // finished enrolment. Depending on the order tests happen to run
    // in is how a suite becomes fragile.
    await query(
      `UPDATE enrolments
          SET status = 'in_progress', completed_at = NULL,
              enrolled_at = now() - interval '30 days'
        WHERE user_id = $1 AND activity_id = $2`,
      [amina.user.id, ids.activityId]
    );

    const before = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: amina.token
    });
    const wasBehind = before.body.summary.behind;
    assert.ok(wasBehind > 0, 'behind before the reset');

    const reset = await call(`/api/activities/${ids.activityId}/schedule/reset`, {
      method: 'POST', token: amina.token
    });
    assert.equal(reset.status, 200);

    const after = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: amina.token
    });
    assert.equal(after.body.summary.behind, 0,
      'a fresh start means nothing is overdue');
  });

  test('nothing per-participant is stored, so nothing can drift', async () => {
    // Structural assertion. If deadlines were ever moved into a table,
    // this fails and whoever did it has to justify it.
    const stored = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'enrolments' AND column_name LIKE '%due%'`
    );
    assert.equal(stored.rows.length, 0,
      'a per-participant due date would be a stored copy of a derived fact');

    const view = await query(
      `SELECT table_name FROM information_schema.views WHERE table_name = 'module_schedule'`
    );
    assert.equal(view.rows.length, 1, 'the schedule is a view');
  });

  test('a participant cannot see another participant schedule', async () => {
    const result = await call(`/api/activities/${ids.activityId}/schedule`, {
      token: joseph.token
    });
    const ids_seen = result.body.schedule.map((r) => r.module_id);
    assert.ok(ids_seen.length > 0);
    // The view filters by user_id, so this returns Joseph's rows. The
    // test that matters is that there is no parameter to ask for
    // somebody else's.
    assert.ok(!JSON.stringify(result.body).includes(amina.user.id));
  });
});

describe('Grades', () => {

  test('every assessment is listed, attempted or not', async () => {
    // The unattempted rows are the point. A grades page that lists only
    // what you have done cannot tell you what you still owe.
    const result = await call(`/api/activities/${ids.activityId}/grades`, {
      token: joseph.token
    });

    assert.equal(result.status, 200);
    assert.ok(result.body.grades.length > 0);

    const row = result.body.grades[0];
    for (const field of ['title', 'max_score', 'pass_score', 'best_score', 'passed']) {
      assert.ok(field in row, `grade row should carry ${field}`);
    }
    assert.equal(typeof result.body.summary.outstanding, 'number');
  });

  test('the best attempt is shown, not the latest', async () => {
    // Every assessment here allows retries precisely so a dropped
    // connection mid-quiz is recoverable. Showing the latest would
    // punish someone for trying again.
    await query(
      `DELETE FROM submissions WHERE user_id = $1 AND assessment_id = $2`,
      [joseph.user.id, ids.assessmentId]
    );
    await query(
      `INSERT INTO submissions (assessment_id, user_id, attempt, answers, status, score, submitted_at, graded_at)
       VALUES ($1, $2, 1, '{}'::jsonb, 'graded', 90, now(), now()),
              ($1, $2, 2, '{}'::jsonb, 'graded', 40, now(), now())`,
      [ids.assessmentId, joseph.user.id]
    );

    const result = await call(`/api/activities/${ids.activityId}/grades`, {
      token: joseph.token
    });
    const row = result.body.grades.find((g) => g.assessment_id === ids.assessmentId);

    assert.equal(Number(row.best_score), 90, 'the higher mark stands');
    assert.equal(row.submission_count, 2, 'both attempts are counted');
  });

  test('the overall figure averages percentages, not raw marks', async () => {
    // Averaging raw marks across assessments with different maximums
    // over-weights the long ones, which would quietly misreport
    // someone's standing.
    const result = await call(`/api/activities/${ids.activityId}/grades`, {
      token: joseph.token
    });
    const graded = result.body.grades.filter((g) => g.best_score !== null);

    if (graded.length) {
      const expected = Math.round(
        graded.reduce((sum, g) =>
          sum + (Number(g.best_score) / Number(g.max_score)) * 100, 0) / graded.length
      );
      assert.equal(result.body.summary.overall, expected);
    }
  });

  test('grades are private to the participant', async () => {
    const mine = await call(`/api/activities/${ids.activityId}/grades`, {
      token: amina.token
    });
    assert.ok((mine.headers.get('cache-control') ?? '').includes('private'));
    assert.ok(!mine.raw.includes(joseph.user.id));
  });

  test('someone not enrolled cannot read grades for the course', async () => {
    await query(
      `DELETE FROM enrolments WHERE activity_id = $1 AND user_id = $2`,
      [ids.activityId, joseph.user.id]
    );
    try {
      const result = await call(`/api/activities/${ids.activityId}/grades`, {
        token: joseph.token
      });
      assert.ok([403, 404].includes(result.status));
    } finally {
      // Deleting an enrolment cascades to module_progress and
      // item_progress. Re-inserting a bare enrolment leaves it with
      // neither, which is exactly the state that exposed the rollup
      // defect fixed in migration 008.
      //
      // recalculate_progress now repairs missing rows itself, so the
      // restore calls it rather than trying to rebuild them by hand.
      const restored = await query(
        `INSERT INTO enrolments (user_id, activity_id, status)
         VALUES ($2, $1, 'in_progress')
         ON CONFLICT (user_id, activity_id) DO UPDATE SET status = 'in_progress'
         RETURNING id`,
        [ids.activityId, joseph.user.id]
      ).catch(() => null);

      if (restored?.rows?.[0]) {
        await query('SELECT recalculate_progress($1)', [restored.rows[0].id]).catch(() => {});
      }
    }
  });
});

describe('Skills and objectives', () => {

  test('skills appear on the public landing page', async () => {
    // Skills serve two jobs in this brief: employability, and Level
    // Two team matching, which has to find people whose skills
    // complement each other.
    const result = await call('/api/courses/ai-literacy-foundations');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.course.skills));
    assert.ok(result.body.course.skills.length > 0, 'the seed provides skills');
  });

  test('skills are distinct from tags', async () => {
    const result = await call('/api/courses/ai-literacy-foundations');
    const { skills, tags } = result.body.course;
    // Tags are topical and used for browsing; skills are what someone
    // can claim afterwards. Conflating them makes both useless.
    assert.notDeepEqual(skills, tags);
  });

  test('a facilitator can set module objectives and a week', async () => {
    const module = await query(
      `SELECT id FROM activity_modules WHERE activity_id = $1 ORDER BY position LIMIT 1`,
      [ids.activityId]
    );
    const moduleId = module.rows[0].id;

    const original = await query(
      `SELECT objectives, week_offset FROM activity_modules WHERE id = $1`, [moduleId]
    );

    try {
      const result = await call(
        `/api/activities/${ids.activityId}/modules/${moduleId}/meta`,
        {
          method: 'PATCH',
          token: facilitator.token,
          body: {
            objectives: ['Name the three failure modes', 'Spot one in the wild'],
            weekOffset: 2
          }
        }
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.module.objectives.length, 2);
      assert.equal(result.body.module.week_offset, 2);
    } finally {
      await query(
        `UPDATE activity_modules SET objectives = $2, week_offset = $3 WHERE id = $1`,
        [moduleId, original.rows[0].objectives, original.rows[0].week_offset]
      ).catch(() => {});
    }
  });

  test('THE ATTACK: a participant cannot edit module objectives', async () => {
    const module = await query(
      `SELECT id FROM activity_modules WHERE activity_id = $1 ORDER BY position LIMIT 1`,
      [ids.activityId]
    );

    const result = await call(
      `/api/activities/${ids.activityId}/modules/${module.rows[0].id}/meta`,
      {
        method: 'PATCH',
        token: amina.token,
        body: { objectives: ['Edited by a participant'] }
      }
    );
    assert.ok([403, 404].includes(result.status));
  });

  test('too many objectives are refused', async () => {
    // The failure mode is a facilitator pasting a syllabus into a field
    // meant for a short list, which nobody reads.
    const module = await query(
      `SELECT id FROM activity_modules WHERE activity_id = $1 ORDER BY position LIMIT 1`,
      [ids.activityId]
    );

    const result = await call(
      `/api/activities/${ids.activityId}/modules/${module.rows[0].id}/meta`,
      {
        method: 'PATCH',
        token: facilitator.token,
        body: { objectives: Array.from({ length: 10 }, (_, i) => `Objective number ${i}`) }
      }
    );
    assert.equal(result.status, 422);
  });
});
