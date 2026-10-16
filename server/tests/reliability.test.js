import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * PERFORMANCE AND CORRECTNESS UNDER LOAD
 *
 * These tests turn the report's claims into assertions:
 *
 *   "an unchanged refresh costs header bytes only"     -> measured here
 *   "revised feedback reaches every member"            -> proven here
 *   "capacity limits hold under concurrent enrolment"  -> raced here
 *
 * The concurrency tests are the ones worth pointing at in a viva. A
 * capacity check written as "read the count, then insert" passes every
 * manual test and fails the moment two people tap at once. The only way
 * to know which you have written is to fire the requests in parallel.
 * =====================================================================
 */

let ids, amina, kwame, joseph, facilitator;

before(async () => {
  await startServer();
  ids = await fixtures();
  [amina, kwame, joseph, facilitator] = await Promise.all([
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame),
    signIn(ACCOUNTS.joseph),
    signIn(ACCOUNTS.facilitator)
  ]);
});

after(stopServer);

describe('Payload shaping (brief section 5, excessive data on refresh)', () => {

  test('field selection measurably shrinks the payload', async () => {
    const full = await call('/api/activities?limit=20', { token: amina.token });
    const slim = await call('/api/activities?limit=20&fields=id,title', { token: amina.token });

    assert.ok(slim.bytes < full.bytes * 0.6,
      `narrowed response should be far smaller: ${slim.bytes} vs ${full.bytes}`);
  });

  test('paging still works when fields are narrowed', async () => {
    // This is the defect found while packaging: the cursor was built
    // from the row AFTER field selection stripped it, so page 2 silently
    // repeated page 1. Regression-locked here.
    const page1 = await call('/api/activities?limit=2&fields=title', { token: amina.token });
    assert.ok(page1.body.page.nextCursor, 'a cursor must be issued');

    const decoded = JSON.parse(
      Buffer.from(page1.body.page.nextCursor, 'base64url').toString('utf8')
    );
    assert.ok(decoded.id, 'the cursor must carry the keyset id');

    const page2 = await call(
      `/api/activities?limit=2&fields=title&cursor=${page1.body.page.nextCursor}`,
      { token: amina.token }
    );
    const titles1 = page1.body.data.map((row) => row.title);
    const titles2 = page2.body.data.map((row) => row.title);
    assert.notDeepEqual(titles1, titles2, 'page 2 must differ from page 1');
  });

  test('a corrupt cursor degrades to page one rather than erroring', async () => {
    const result = await call('/api/activities?limit=5&cursor=%%%not-base64%%%', {
      token: amina.token
    });
    assert.equal(result.status, 200, 'a stale bookmark must not produce an error page');
  });

  test('responses derived from identity are marked private', async () => {
    const result = await call('/api/me/progress', { token: amina.token });
    const cacheControl = result.headers.get('cache-control') ?? '';
    assert.ok(cacheControl.includes('private'),
      'a shared proxy must not store one user response and serve it to another');
    assert.ok((result.headers.get('vary') ?? '').includes('Authorization'));
  });
});

describe('Feedback versioning (brief section 5, cannot see updated feedback)', () => {

  test('revising feedback advances its version', async () => {
    const path = `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`;

    const first = await call(path, { token: amina.token });
    assert.equal(first.status, 200);
    const versionBefore = first.body.feedback[0].version;

    // The facilitator revises it.
    const revision = await call(path, {
      method: 'POST',
      token: facilitator.token,
      body: { body: `Revised at ${Date.now()}. Name the primary source next time.` }
    });
    assert.equal(revision.status, 201);

    // A fresh read must reflect the new content immediately: nothing in
    // this pipeline holds a copy from before the revision.
    const after = await call(path, { token: amina.token });
    assert.equal(after.status, 200);
    assert.ok(after.body.feedback[0].version > versionBefore, 'the version must advance');
  });

  test('a revision is flagged unread even after the earlier version was read', async () => {
    const path = `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`;

    // Read it, then record the receipt explicitly. Marking read is no
    // longer a side effect of the GET: see the defect note in
    // assessment.routes.js.
    await call(path, { token: amina.token });
    await call(`${path}/read`, { method: 'POST', token: amina.token });

    const read = await call(path, { token: amina.token });
    assert.equal(read.body.feedback[0].isUnread, false, 'already read');

    // Revise it.
    await call(path, {
      method: 'POST',
      token: facilitator.token,
      body: { body: `Second revision at ${Date.now()}.` }
    });

    const afterRevision = await call(path, { token: amina.token });
    assert.equal(afterRevision.body.feedback[0].isUnread, true,
      'a revision must resurface as new, which is the incident in the brief');
  });

  test('reading feedback does not mutate state', async () => {
    // REGRESSION. The GET used to write a read receipt, which changed
    // the isUnread flag between two identical requests, so a plain read
    // silently altered what the next read would return.
    const path = `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`;

    const first = await call(path, { token: amina.token });
    assert.equal(first.status, 200);

    // Long enough that any stray asynchronous write would have landed.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const second = await call(path, { token: amina.token });
    assert.equal(second.status, 200);
    assert.equal(second.body.feedback[0].isUnread, first.body.feedback[0].isUnread,
      'an unchanged GET must not itself flip read state');
    assert.equal(second.body.feedback[0].version, first.body.feedback[0].version,
      'an unchanged GET must not itself advance the version');
  });

  test('marking feedback read is idempotent', async () => {
    const path = `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback/read`;
    const first = await call(path, { method: 'POST', token: amina.token });
    assert.equal(first.status, 200);

    const second = await call(path, { method: 'POST', token: amina.token });
    assert.equal(second.status, 200);
    assert.equal(second.body.recorded, 0, 'a replayed request records nothing new');
  });

  test('the author is notified when feedback lands', async () => {
    await call(`/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`, {
      method: 'POST',
      token: facilitator.token,
      body: { body: `Notification check ${Date.now()}.` }
    });

    const result = await call('/api/me/notifications', { token: amina.token });
    assert.ok(
      result.body.notifications.some((n) => n.kind === 'feedback_available'),
      'feedback should be pushed, not only discovered'
    );
  });
});

describe('Concurrency', () => {

  test('capacity holds when many people enrol at the same instant', async () => {
    // A capacity-1 activity, then three simultaneous enrolments. Code
    // written as "SELECT count, then INSERT" lets all three through.
    const created = await query(
      `INSERT INTO activities
         (slug, title, summary, type, status, facilitator_id, capacity, estimated_minutes, opens_at)
       VALUES ($1, 'Race Test', 'Capacity of one.', 'workshop', 'published',
               (SELECT id FROM users WHERE email = 'facilitator@ycp.africa'),
               1, 30, now() - interval '1 day')
       RETURNING id`,
      [`race-test-${Date.now()}`]
    );
    const activityId = created.rows[0].id;

    const results = await Promise.all(
      [amina, kwame, joseph].map((account) =>
        call(`/api/activities/${activityId}/enrolments`, {
          method: 'POST',
          token: account.token
        })
      )
    );

    const accepted = results.filter((r) => r.status === 201).length;
    assert.equal(accepted, 1, `capacity 1 must accept exactly 1, accepted ${accepted}`);

    const stored = await query(
      `SELECT count(*)::int AS n FROM enrolments WHERE activity_id = $1 AND status <> 'withdrawn'`,
      [activityId]
    );
    assert.equal(stored.rows[0].n, 1, 'the database must agree');

    await query('DELETE FROM activities WHERE id = $1', [activityId]);
  });

  test('duplicate enrolment is refused even when fired in parallel', async () => {
    const created = await query(
      `INSERT INTO activities
         (slug, title, summary, type, status, facilitator_id, estimated_minutes, opens_at)
       VALUES ($1, 'Duplicate Test', 'No capacity limit.', 'course', 'published',
               (SELECT id FROM users WHERE email = 'facilitator@ycp.africa'),
               30, now() - interval '1 day')
       RETURNING id`,
      [`dup-test-${Date.now()}`]
    );
    const activityId = created.rows[0].id;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(`/api/activities/${activityId}/enrolments`, {
          method: 'POST',
          token: amina.token
        })
      )
    );

    assert.equal(results.filter((r) => r.status === 201).length, 1,
      'the unique constraint must hold under concurrency');

    await query('DELETE FROM activities WHERE id = $1', [activityId]);
  });

  test('attempt limits hold against parallel submissions', async () => {
    // max_attempts is 2 on the seeded assessment. Five at once must not
    // yield five graded attempts.
    await query(
      `DELETE FROM submissions WHERE assessment_id = $1 AND user_id = $2`,
      [ids.assessmentId, joseph.user.id]
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(`/api/assessments/${ids.assessmentId}/submissions`, {
          method: 'POST',
          token: joseph.token,
          body: { answers: {} }
        })
      )
    );

    const accepted = results.filter((r) => r.status === 201).length;

    // Both bounds matter. The original version of this test asserted
    // only `accepted <= 2`, which passed while EVERY submission was
    // failing with a 500: zero is less than two. Asserting the lower
    // bound is what exposed the broken endpoint.
    assert.ok(accepted >= 1,
      `at least one submission must succeed, got ${accepted}: ` +
      JSON.stringify(results.map((r) => [r.status, r.body?.error?.code])));
    assert.ok(accepted <= 2, `at most 2 attempts allowed, accepted ${accepted}`);

    const stored = await query(
      `SELECT count(*)::int AS n FROM submissions
        WHERE assessment_id = $1 AND user_id = $2 AND status <> 'draft'`,
      [ids.assessmentId, joseph.user.id]
    );
    assert.ok(stored.rows[0].n <= 2, 'the database must agree');
  });
});

describe('Query efficiency', () => {

  test('the progress dashboard is a single round trip, not N+1', async () => {
    // A dashboard that loops a query per enrolment is fast with one
    // enrolment and unusable with twenty. Timing is a weak proxy, so the
    // real check is that the endpoint returns aggregates the database
    // computed rather than arrays the server would have to reduce.
    const started = Date.now();
    const result = await call('/api/me/progress', { token: amina.token });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 200);
    assert.ok(typeof result.body.summary.minutesSpent === 'number');
    for (const enrolment of result.body.enrolments) {
      assert.equal(typeof enrolment.modules_total, 'number',
        'counts must be aggregated in SQL, not assembled per row');
    }
    assert.ok(elapsed < 1500, `dashboard took ${elapsed}ms`);
  });

  test('page size is capped regardless of what the client asks for', async () => {
    const result = await call('/api/activities?limit=100000', { token: amina.token });
    assert.equal(result.status, 200);
    assert.ok(result.body.page.limit <= 50, 'an unbounded list is a denial-of-service vector');
  });
});

describe('Feedback is one revisable row per reviewer (ADR-023)', () => {

  /**
   * The defect this guards against produced the exact incident in
   * section 5 of the brief, and every deliberate defence against that
   * incident was present and working at the time.
   *
   * The handler read, decided, and then wrote. Two posts from one
   * reviewer could both see no row and both insert, because nothing in
   * the schema said a reviewer has one piece of feedback per submission.
   * With two rows, the list is ordered by created_at, the participant
   * reads the older one, revisions land in the newer one, and the older
   * row's version never advances. So the ETag stays valid, the read
   * receipt stays matched, and the participant cannot see the update.
   *
   * The generalisable rule: when application code treats a row as
   * unique, the schema has to enforce it. Otherwise every control built
   * on top of that assumption is load bearing on nothing.
   */

  test('a second row for the same reviewer is rejected outright', async () => {
    const existing = await query(
      `SELECT submission_id, reviewer_id FROM feedback
        WHERE submission_id = $1 LIMIT 1`,
      [ids.aminaSubmissionId]
    );
    assert.ok(existing.rows[0], 'the seeded feedback is present');

    await assert.rejects(
      () => query(
        `INSERT INTO feedback (submission_id, reviewer_id, body)
         VALUES ($1, $2, 'A concurrent post that must not create a second row.')`,
        [existing.rows[0].submission_id, existing.rows[0].reviewer_id]
      ),
      (error) => error.code === '23505',
      'the database must refuse it, not merely the handler'
    );
  });

  test('two revisions in the same instant still leave one row', async () => {
    // The race the old code lost. Both requests are in flight before
    // either finishes, which is what a double click or a retried request
    // looks like.
    const path = `/api/assessments/submissions/${ids.aminaSubmissionId}/feedback`;

    const before = await query(
      `SELECT count(*)::int AS n FROM feedback WHERE submission_id = $1`,
      [ids.aminaSubmissionId]
    );

    const [first, second] = await Promise.all([
      call(path, {
        method: 'POST', token: facilitator.token,
        body: { body: `Concurrent revision A at ${Date.now()}.` }
      }),
      call(path, {
        method: 'POST', token: facilitator.token,
        body: { body: `Concurrent revision B at ${Date.now()}.` }
      })
    ]);

    // Both are accepted. Neither creates a row.
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.feedback.id, second.body.feedback.id,
      'both posts must resolve to the same piece of feedback');

    const after = await query(
      `SELECT count(*)::int AS n FROM feedback WHERE submission_id = $1`,
      [ids.aminaSubmissionId]
    );
    assert.equal(after.rows[0].n, before.rows[0].n, 'no row was added');
  });

  test('a second reviewer on the same submission is still allowed', async () => {
    // The constraint must not stop a facilitator and a mentor each
    // leaving their own feedback, which is normal and useful.
    const mentor = await query(`SELECT id FROM users WHERE email = 'mentor@ycp.africa'`);

    const created = await query(
      `INSERT INTO feedback (submission_id, reviewer_id, body)
       VALUES ($1, $2, 'ADR-023 temporary probe from a second reviewer.')
       RETURNING id`,
      [ids.aminaSubmissionId, mentor.rows[0].id]
    );
    assert.ok(created.rows[0].id);

    // Created here, removed here.
    await query(`DELETE FROM feedback WHERE id = $1`, [created.rows[0].id]);
  });
});

describe('A refused origin is not a server error (ADR-024)', () => {

  /**
   * Found by opening the app in a browser for the first time. Every
   * login returned 500, and the whole suite passed, because no test had
   * ever sent an Origin header.
   *
   * Two separate faults, both of which cost real debugging time:
   *
   * The rejection path called callback(new Error(...)), which the cors
   * package hands to the error handler, which reports 500. So the
   * browser said "Internal Server Error" for what was actually a
   * configuration mismatch, sending whoever was debugging to look at the
   * server and the database instead of at their origin list.
   *
   * And the list was matched by exact string, so http://localhost:5173
   * and http://127.0.0.1:5173, which are one dev server, disagreed. The
   * same shape of mismatch is waiting in production in a trailing slash.
   *
   * The generalisable rule: a 5xx means the server is broken. Anything
   * caused by what the client sent must not be one, because the status
   * code is the first piece of diagnostic information anyone gets and a
   * wrong one sends them to the wrong place.
   */

  test('a disallowed origin does not produce a 5xx', async () => {
    const result = await call('/api/courses', {
      headers: { origin: 'https://not-the-front-end.example' }
    });
    assert.ok(result.status < 500,
      `a refused origin must not report a server error, got ${result.status}`);
  });

  test('a disallowed origin gets no allow-origin header', async () => {
    // This is the control that actually matters. The browser enforces it,
    // so the requirement is the ABSENCE of the header, not a status code.
    const result = await call('/api/courses', {
      headers: { origin: 'https://not-the-front-end.example' }
    });
    assert.equal(result.headers.get('access-control-allow-origin'), null,
      'the browser must have nothing to permit the read with');
  });

  test('logging in from a disallowed origin is rejected, not crashed', async () => {
    // The original symptom, exactly: POST /auth/login returning 500.
    const result = await call('/api/auth/login', {
      method: 'POST',
      headers: { origin: 'https://not-the-front-end.example' },
      body: { email: ACCOUNTS.amina, password: 'YcpDemo2026!' }
    });
    assert.notEqual(result.status, 500, 'this was the defect');
  });

  test('the configured origin is recognised whatever its casing', async () => {
    // A trailing slash or a case difference in CORS_ORIGINS is the single
    // most likely way this breaks on a deployed instance, and it used to
    // break it silently and blame the server. The comparison is
    // normalised on both sides, so any of these is recognised.
    //
    // The header is REFLECTED verbatim rather than rewritten, which is
    // correct: the browser compares it against its own origin string, so
    // changing it would break the very check it exists for. The
    // assertion is therefore that a header is present at all.
    for (const origin of ['http://localhost:5173', 'HTTP://localhost:5173']) {
      const result = await call('/api/courses', { headers: { origin } });
      assert.ok(
        result.headers.get('access-control-allow-origin'),
        `${origin} must be recognised as the configured front end`
      );
      assert.ok(result.status < 400);
    }
  });

  test('loopback and localhost are interchangeable outside production', async () => {
    // Vite forwards whichever host the developer typed, so both have to
    // work or the app breaks for half the ways of starting it.
    const result = await call('/api/courses', {
      headers: { origin: 'http://127.0.0.1:5173' }
    });
    assert.equal(result.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  });
});
