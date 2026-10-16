import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * THE PUBLIC COURSE LANDING PAGE
 *
 * This is the only surface a stranger can reach, so it gets the
 * hardest test in the suite: not "does it render" but "what can be
 * extracted from it".
 *
 * A landing page has two jobs that pull against each other. It must
 * show enough of the course that someone can decide to enrol, and it
 * must not be a way to take the course without enrolling. Most of
 * these tests are about the second job.
 * =====================================================================
 */

let ids, facilitator, amina, kwame;
let readingBody, canaryItemId;

before(async () => {
  await startServer();
  ids = await fixtures();
  [facilitator, amina, kwame] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame)
  ]);

  // Put a reading with a distinctive body into the course, so the
  // "content does not leak" tests are checking for a real string
  // rather than an absence that might be an absence of content.
  readingBody = `CANARY-${Date.now()}-this-text-must-never-appear-publicly`;

  const module = await query(
    `SELECT id FROM activity_modules WHERE activity_id = $1 ORDER BY position LIMIT 1`,
    [ids.activityId]
  );

  const canary = await call(
    `/api/activities/${ids.activityId}/modules/${module.rows[0].id}/items`,
    {
      method: 'POST',
      token: facilitator.token,
      body: {
        kind: 'reading',
        title: 'A reading with secret contents',
        body: readingBody,
        estimatedMinutes: 15
      }
    }
  );
  canaryItemId = canary.body?.item?.id ?? null;

  // ARRANGE THE PRECONDITIONS RATHER THAN INHERITING THEM.
  //
  // The first version of this file asserted against the landing-page
  // content that migration 005 seeds. That passed on a fresh database
  // and failed on every run afterwards, because a later test in this
  // same file edits those fields.
  //
  // Restoring in a finally block was not enough: by then the damage
  // from the earlier broken run was already the "original" state that
  // the restore captured and faithfully put back. A cleanup can only
  // return you to where the test started, and where the test started
  // was already wrong.
  //
  // So the setup now ESTABLISHES the state these tests assert on. The
  // file no longer depends on what the seed happens to contain, which
  // also means it keeps working if the seed content is reworded.
  await query(
    `UPDATE activities
        SET outcomes = $2, prerequisites = $3, weeks = $4,
            hours_per_week = $5, level = $6, instructor_note = $7
      WHERE id = $1`,
    [
      ids.activityId,
      ['Explain how a model differs from rules-based software',
       'Recognise confident but incorrect output',
       'Identify whose data is missing and what that costs',
       'Use AI tools without outsourcing your judgement'],
      ['No prior technical background needed'],
      3,
      2.5,
      'beginner',
      'Daniel teaches this the way he wishes it had been taught to him.'
    ]
  );
});

after(async () => {
  // Remove the canary reading this file creates. Without it, every run
  // adds another copy to the seeded course, the syllabus fills with
  // duplicates, and the derived minute count climbs forever.
  //
  // Third instance of leftover test data in this project today. The
  // pattern is now explicit: if a test CREATES a row, the same file
  // deletes it; if a test CHANGES a row, the file restores it; and
  // anything the file depends on, the file arranges itself.
  if (canaryItemId) {
    await query('DELETE FROM lesson_items WHERE id = $1', [canaryItemId]).catch(() => {});
  }
  await stopServer();
});

describe('The catalogue is reachable without an account', () => {

  test('a stranger can list published courses', async () => {
    // A catalogue that requires a login cannot be shared in a WhatsApp
    // group, which is how this programme actually reaches people.
    const result = await call('/api/courses');
    assert.equal(result.status, 200);
    assert.ok(result.body.courses.length > 0);
  });

  test('the catalogue is publicly cacheable', async () => {
    const result = await call('/api/courses');
    assert.ok((result.headers.get('cache-control') ?? '').includes('public'),
      'identical for everyone, so a shared cache should serve it');
  });

  test('a stranger can open a course landing page by slug', async () => {
    // Addressed by slug so the link is repeatable over the phone.
    const result = await call('/api/courses/ai-literacy-foundations');
    assert.equal(result.status, 200);
    assert.equal(result.body.course.slug, 'ai-literacy-foundations');
  });

  test('the page answers the questions someone asks before enrolling', async () => {
    const result = await call('/api/courses/ai-literacy-foundations');
    const course = result.body.course;

    assert.ok(course.outcomes.length >= 3, 'what you will learn');
    assert.ok(course.weeks > 0, 'how many weeks');
    assert.ok(course.hours_per_week > 0, 'how many hours a week');
    assert.ok(course.level, 'what level');
    assert.ok(course.instructor_name, 'who teaches it');
    assert.equal(typeof course.enrolled_count, 'number', 'how many others');
    assert.ok(course.totalMinutes > 0, 'total time, derived from content');
    assert.ok(course.breakdown, 'what it is made of');
  });

  test('the syllabus shows structure', async () => {
    const result = await call('/api/courses/ai-literacy-foundations');
    const syllabus = result.body.syllabus;

    assert.ok(syllabus.length > 0, 'modules are listed');
    const withItems = syllabus.find((m) => m.items.length > 0);
    assert.ok(withItems, 'items are listed under their module');

    const item = withItems.items[0];
    for (const field of ['title', 'kind', 'estimatedMinutes', 'isRequired']) {
      assert.ok(field in item, `item should advertise ${field}`);
    }
  });
});

describe('THE REAL TEST: what a stranger cannot extract', () => {

  test('a reading body never appears in the public page', async () => {
    // The single most important assertion in this file. If this fails,
    // the landing page is a way to take the course for free.
    const result = await call('/api/courses/ai-literacy-foundations');
    assert.ok(!result.raw.includes(readingBody),
      'reading content must not be served to an unauthenticated caller');
  });

  test('the page carries no body, transcript or external_url fields at all', async () => {
    // Stronger than checking one canary: assert the SHAPE is safe, so a
    // future item with different content is safe too. These fields do
    // not exist in course_preview_items, which is the control.
    const result = await call('/api/courses/ai-literacy-foundations');
    const raw = result.raw;

    for (const leak of ['"body"', '"transcript"', '"external_url"', '"externalUrl"']) {
      assert.ok(!raw.includes(leak), `${leak} must not be in a public response`);
    }
  });

  test('attachment sizes are disclosed but their contents are not', async () => {
    // Size is structural: someone on a metered connection needs it to
    // decide. The bytes are substance.
    const result = await call('/api/courses/ai-literacy-foundations');
    const items = result.body.syllabus.flatMap((m) => m.items);

    for (const item of items) {
      assert.equal(typeof item.materialCount, 'number');
      assert.equal(typeof item.materialBytes, 'number');
      assert.equal(item.materials, undefined, 'no material list, no ids, no bytes');
    }
  });

  test('a signed-out visitor sees no enrolment state', async () => {
    const result = await call('/api/courses/ai-literacy-foundations');
    assert.equal(result.body.viewer.enrolled, false);
  });

  test('a signed-in visitor sees only their own state', async () => {
    const mine = await call('/api/courses/ai-literacy-foundations', { token: amina.token });
    assert.equal(mine.status, 200);
    assert.equal(typeof mine.body.viewer.enrolled, 'boolean');

    // Progress detail is not part of a course page. A screenshot of one
    // should not reveal how far behind the viewer is.
    assert.equal(mine.body.viewer.modulesDone, undefined);
    assert.equal(mine.body.viewer.percent, undefined);
  });

  test('a page personalised for a viewer is never publicly cached', async () => {
    const anonymous = await call('/api/courses/ai-literacy-foundations');
    const signedIn = await call('/api/courses/ai-literacy-foundations', { token: amina.token });

    assert.ok((anonymous.headers.get('cache-control') ?? '').includes('public'));
    assert.ok((signedIn.headers.get('cache-control') ?? '').includes('private'),
      'a shared cache must not hand one viewer enrolment state to another');
  });

  test('an unpublished course is indistinguishable from one that does not exist', async () => {
    // Otherwise the landing page becomes a way to watch what a
    // facilitator is drafting before they publish it.
    await query(`UPDATE activities SET status = 'draft' WHERE id = $1`, [ids.activityId]);

    try {
      const draft = await call('/api/courses/ai-literacy-foundations');
      const missing = await call('/api/courses/no-such-course-at-all');

      assert.equal(draft.status, 404);
      assert.equal(draft.status, missing.status);
      assert.deepEqual(draft.body.error?.code, missing.body.error?.code);
    } finally {
      await query(`UPDATE activities SET status = 'published' WHERE id = $1`, [ids.activityId])
        .catch(() => {});
    }
  });

  test('the preview view itself cannot expose content', async () => {
    // The strongest form of this guarantee is structural. Assert the
    // view has no content columns, so no handler can select one by
    // mistake.
    const columns = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'course_preview_items'`
    );
    const names = columns.rows.map((row) => row.column_name);

    for (const forbidden of ['body', 'transcript', 'external_url']) {
      assert.ok(!names.includes(forbidden),
        `course_preview_items must not contain ${forbidden}`);
    }
    assert.ok(names.includes('title'), 'but it does carry structure');
  });
});

describe('Facilitators maintain the landing page', () => {

  test('a facilitator can edit the landing page fields', async () => {
    // CAPTURE, MUTATE, RESTORE.
    //
    // The first version of this test mutated the seeded course and
    // never put it back, so it passed on a fresh database and failed on
    // every run after. That is the same defect as the suspended-account
    // one written up in docs/test-log.md, committed again in the file
    // written to test a new feature.
    //
    // The lesson generalises past accounts: ANY test that changes
    // shared fixture data has to restore it, and the only reliable way
    // is to read the original first rather than hardcoding what you
    // think it was.
    const original = await query(
      `SELECT outcomes, weeks, hours_per_week, level, instructor_note
         FROM activities WHERE id = $1`,
      [ids.activityId]
    );
    const before = original.rows[0];

    try {
      const result = await call(`/api/activities/${ids.activityId}`, {
        method: 'PATCH',
        token: facilitator.token,
        body: {
          outcomes: ['Do the first thing', 'Do the second thing'],
          weeks: 5,
          hoursPerWeek: 2,
          level: 'intermediate',
          instructorNote: 'Written for people who have never done this before.'
        }
      });
      assert.equal(result.status, 200);

      const page = await call('/api/courses/ai-literacy-foundations');
      assert.equal(page.body.course.weeks, 5);
      assert.equal(page.body.course.level, 'intermediate');
      assert.equal(page.body.course.outcomes.length, 2);
    } finally {
      await query(
        `UPDATE activities
            SET outcomes = $2, weeks = $3, hours_per_week = $4,
                level = $5, instructor_note = $6
          WHERE id = $1`,
        [ids.activityId, before.outcomes, before.weeks,
         before.hours_per_week, before.level, before.instructor_note]
      ).catch(() => {});
    }
  });

  test('an unknown level is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}`, {
      method: 'PATCH',
      token: facilitator.token,
      body: { level: 'expert' }
    });
    assert.equal(result.status, 422);
  });

  test('an implausible course length is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}`, {
      method: 'PATCH',
      token: facilitator.token,
      body: { weeks: 500 }
    });
    assert.equal(result.status, 422);
  });

  test('THE ATTACK: a participant cannot edit the landing page', async () => {
    const result = await call(`/api/activities/${ids.activityId}`, {
      method: 'PATCH',
      token: kwame.token,
      body: { outcomes: ['Edited by someone who should not be able to'] }
    });
    assert.ok([403, 404].includes(result.status));

    const page = await call('/api/courses/ai-literacy-foundations');
    assert.ok(!page.raw.includes('someone who should not be able to'));
  });
});

describe('Derived figures stay true', () => {

  test('total time is computed from content, not typed in', async () => {
    // A number a facilitator enters drifts the moment content changes,
    // and someone budgeting their week is relying on it.
    const before = await call('/api/courses/ai-literacy-foundations');
    const beforeMinutes = before.body.course.totalMinutes;

    const module = await query(
      `SELECT id FROM activity_modules WHERE activity_id = $1 ORDER BY position LIMIT 1`,
      [ids.activityId]
    );

    const added = await call(
      `/api/activities/${ids.activityId}/modules/${module.rows[0].id}/items`,
      {
        method: 'POST',
        token: facilitator.token,
        body: { kind: 'reading', title: 'Extra', body: 'More content.', estimatedMinutes: 25 }
      }
    );
    assert.equal(added.status, 201);

    try {
      const after = await call('/api/courses/ai-literacy-foundations');
      assert.equal(after.body.course.totalMinutes, beforeMinutes + 25,
        'the advertised length must follow the content');
    } finally {
      await call(`/api/activities/${ids.activityId}/items/${added.body.item.id}`, {
        method: 'DELETE', token: facilitator.token
      }).catch(() => {});
    }
  });

  test('the breakdown counts item kinds', async () => {
    const result = await call('/api/courses/ai-literacy-foundations');
    const breakdown = result.body.course.breakdown;
    const counted = Object.values(breakdown).reduce((sum, n) => sum + n, 0);
    assert.equal(counted, result.body.course.itemCount,
      '"6 readings, 2 quizzes" is more useful than "8 items"');
  });
});
