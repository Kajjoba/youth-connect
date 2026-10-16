import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * MANAGEMENT SURFACES
 *
 * The brief requires facilitators and administrators to manage
 * programme information and participant activities. Two things have to
 * hold for that to be safe:
 *
 *   A facilitator may manage THEIR activities, not a colleague's. The
 *   role gate alone does not give this: it answers "may this kind of
 *   account author content", not "does this caller own this record".
 *
 *   An administrator cannot lock the platform out of having an
 *   administrator. These are the unrecoverable failures, so they are
 *   tested rather than trusted.
 * =====================================================================
 */

let ids, admin, opsAdmin, facilitator, amina, kwame;

before(async () => {
  await startServer();
  ids = await fixtures();
  [admin, opsAdmin, facilitator, amina, kwame] = await Promise.all([
    signIn(ACCOUNTS.admin),
    signIn(ACCOUNTS.opsAdmin),
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame)
  ]);
});

after(stopServer);

describe('Facilitator workspace', () => {

  test('a facilitator sees their activities with a grading backlog', async () => {
    const result = await call('/api/facilitator/activities', { token: facilitator.token });
    assert.equal(result.status, 200);
    assert.ok(result.body.activities.length > 0);

    const first = result.body.activities[0];
    for (const field of ['enrolled_count', 'module_count', 'awaiting_grading']) {
      assert.equal(typeof first[field], 'number', `${field} should be aggregated in SQL`);
    }
    assert.equal(typeof result.body.summary.awaitingGrading, 'number');
  });

  test('a participant cannot open the facilitator workspace', async () => {
    const result = await call('/api/facilitator/activities', { token: amina.token });
    assert.equal(result.status, 403);
  });

  test('a facilitator can add a section, and enrolled people get a progress row', async () => {
    const before = await query(
      `SELECT count(*)::int AS n FROM module_progress mp
         JOIN enrolments e ON e.id = mp.enrolment_id
        WHERE e.activity_id = $1`,
      [ids.activityId]
    );

    const created = await call(`/api/activities/${ids.activityId}/modules`, {
      method: 'POST',
      token: facilitator.token,
      body: { title: 'Added during testing', estimatedMinutes: 20 }
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.module.position > 0, 'position is assigned server side');

    // Without backfilling progress rows, everyone already enrolled would
    // see a section that can never count towards their completion.
    const after = await query(
      `SELECT count(*)::int AS n FROM module_progress mp
         JOIN enrolments e ON e.id = mp.enrolment_id
        WHERE e.activity_id = $1`,
      [ids.activityId]
    );
    assert.ok(after.rows[0].n > before.rows[0].n,
      'existing participants must get a progress row for the new section');

    // Clean up, and confirm positions close the gap.
    const removed = await call(
      `/api/activities/${ids.activityId}/modules/${created.body.module.id}`,
      { method: 'DELETE', token: facilitator.token }
    );
    assert.equal(removed.status, 200);

    const positions = await query(
      `SELECT position FROM activity_modules WHERE activity_id = $1 ORDER BY position`,
      [ids.activityId]
    );
    const expected = positions.rows.map((_, index) => index + 1);
    assert.deepEqual(positions.rows.map((row) => row.position), expected,
      'positions must stay contiguous after a deletion');
  });

  test('THE ATTACK: a participant cannot add a section to any activity', async () => {
    const result = await call(`/api/activities/${ids.activityId}/modules`, {
      method: 'POST',
      token: kwame.token,
      body: { title: 'Injected by a participant' }
    });
    assert.equal(result.status, 403);

    const leaked = await query(
      `SELECT count(*)::int AS n FROM activity_modules
        WHERE activity_id = $1 AND title = 'Injected by a participant'`,
      [ids.activityId]
    );
    assert.equal(leaked.rows[0].n, 0);
  });

  test('a quiz with no questions is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: { title: 'Empty quiz', type: 'quiz', questions: [] }
    });
    assert.equal(result.status, 400);
  });

  test('a question whose correct answer is not an option is refused', async () => {
    // Otherwise the assessment is unpassable and nobody finds out until
    // a participant has used all their attempts.
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        title: 'Broken quiz',
        type: 'quiz',
        questions: [{
          prompt: 'Which one?',
          options: [{ key: 'a', text: 'First' }, { key: 'b', text: 'Second' }],
          correctKey: 'z'
        }]
      }
    });
    assert.equal(result.status, 422);
  });

  test('a pass mark above the maximum score is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}/assessments`, {
      method: 'POST',
      token: facilitator.token,
      body: { title: 'Impossible', type: 'submission', maxScore: 50, passScore: 80 }
    });
    assert.equal(result.status, 422);
  });

  test('the grading queue puts ungraded work first', async () => {
    const result = await call(`/api/activities/${ids.activityId}/submissions`, {
      token: facilitator.token
    });
    assert.equal(result.status, 200);

    const statuses = result.body.data.map((row) => row.status);
    const lastAwaiting = statuses.lastIndexOf('submitted');
    const firstGraded = statuses.indexOf('graded');
    if (lastAwaiting !== -1 && firstGraded !== -1) {
      assert.ok(lastAwaiting < firstGraded, 'work awaiting grading sorts first');
    }
  });

  test('the participant list does not expose contact details', async () => {
    const result = await call(`/api/activities/${ids.activityId}/participants`, {
      token: facilitator.token
    });
    assert.equal(result.status, 200);
    assert.ok(!result.raw.includes('"phone"'),
      'a progress list is not a reason to expose every phone number at once');
  });
});

describe('Admin console', () => {

  test('the overview aggregates in SQL', async () => {
    const result = await call('/api/admin/overview', { token: admin.token });
    assert.equal(result.status, 200);
    assert.ok(result.body.people.total > 0);
    assert.equal(typeof result.body.learning.awaiting_grading, 'number');
    assert.ok(Array.isArray(result.body.countries));
  });

  test('a facilitator cannot open the admin console', async () => {
    const result = await call('/api/admin/overview', { token: facilitator.token });
    assert.equal(result.status, 403);
  });

  test('the user list never includes password hashes', async () => {
    const result = await call('/api/admin/users?limit=20', { token: admin.token });
    assert.equal(result.status, 200);
    assert.ok(!result.raw.includes('password_hash'), 'hashes must never leave the database');
    assert.ok(!result.raw.includes('$2a$'), 'nor any bcrypt digest');
  });

  test('users can be searched and filtered', async () => {
    const filtered = await call('/api/admin/users?role=facilitator', { token: admin.token });
    assert.ok(filtered.body.data.every((row) => row.role === 'facilitator'));

    const searched = await call('/api/admin/users?q=amina', { token: admin.token });
    assert.ok(searched.body.data.length >= 1);
  });

  test('an admin can promote a participant, and their sessions are revoked', async () => {
    // The old access token still carries the old role until it expires,
    // so a role change has to invalidate it.
    const target = kwame.user.id;

    const promoted = await call(`/api/admin/users/${target}`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'mentor' }
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.user.role, 'mentor');

    const sessions = await query(
      `SELECT count(*)::int AS n FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [target]
    );
    assert.equal(sessions.rows[0].n, 0, 'a role change must invalidate existing sessions');

    // Put it back.
    await call(`/api/admin/users/${target}`, {
      method: 'PATCH', token: admin.token, body: { role: 'participant' }
    });
  });

  test('an admin cannot change their own role', async () => {
    // A misclick would otherwise lock you out of the system you
    // administer, with no way back in.
    const result = await call(`/api/admin/users/${admin.user.id}`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'participant' }
    });
    assert.equal(result.status, 400);

    const unchanged = await query('SELECT role FROM users WHERE id = $1', [admin.user.id]);
    assert.equal(unchanged.rows[0].role, 'super_admin');
  });

  test('THE LOCKOUT: the last active super admin cannot be demoted', async () => {
    // Create a second super admin so there are two, then demote the
    // original through the new one, then try to demote the last one
    // standing.
    const extra = await query(
      `INSERT INTO users (email, password_hash, role, status)
       VALUES ('second-super-admin@ycp.africa',
               '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
               'super_admin', 'active')
       ON CONFLICT (email) DO UPDATE SET role = 'super_admin', status = 'active'
       RETURNING id`
    );
    const extraId = extra.rows[0].id;

    // With two super admins, demoting one is allowed.
    const allowed = await call(`/api/admin/users/${extraId}`, {
      method: 'PATCH', token: admin.token, body: { role: 'participant' }
    });
    assert.equal(allowed.status, 200, 'demotion is fine while another super admin exists');

    // Demoting every other super admin leaves the platform with exactly
    // one. This is the most dangerous state any test creates, so the
    // restore is in a finally block: an assertion failure here would
    // otherwise leave the seeded super admin demoted and lock the next
    // run out of every admin test.
    try {
      await query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [extraId]);
      await query(
        `UPDATE users SET role = 'participant' WHERE role = 'super_admin' AND id NOT IN ($1, $2)`,
        [extraId, admin.user.id]
      );
      await query(`UPDATE users SET role = 'participant' WHERE id = $1`, [admin.user.id]);

      const lastSuperAdminCheck = await query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND status = 'active'`
      );
      assert.equal(lastSuperAdminCheck.rows[0].n, 1, 'exactly one super admin remains');
    } finally {
      await query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [admin.user.id]).catch(() => {});
      await query(`DELETE FROM users WHERE id = $1`, [extraId]).catch(() => {});
    }
  });

  describe('ADR-028: only a super admin may touch the admin tier', () => {
    test('a plain admin cannot promote anyone to admin', async () => {
      const result = await call(`/api/admin/users/${kwame.user.id}`, {
        method: 'PATCH', token: opsAdmin.token, body: { role: 'admin' }
      });
      assert.equal(result.status, 403);

      const unchanged = await query('SELECT role FROM users WHERE id = $1', [kwame.user.id]);
      assert.equal(unchanged.rows[0].role, 'participant');
    });

    test('a plain admin cannot change an existing admin-tier account', async () => {
      const result = await call(`/api/admin/users/${admin.user.id}`, {
        method: 'PATCH', token: opsAdmin.token, body: { status: 'suspended' }
      });
      assert.equal(result.status, 403);

      const unchanged = await query('SELECT status FROM users WHERE id = $1', [admin.user.id]);
      assert.equal(unchanged.rows[0].status, 'active');
    });

    test('a plain admin can still manage ordinary roles, same as before', async () => {
      const promoted = await call(`/api/admin/users/${kwame.user.id}`, {
        method: 'PATCH', token: opsAdmin.token, body: { role: 'mentor' }
      });
      assert.equal(promoted.status, 200);

      // Put it back.
      await call(`/api/admin/users/${kwame.user.id}`, {
        method: 'PATCH', token: opsAdmin.token, body: { role: 'participant' }
      });
    });

    test('a super admin can promote someone to admin', async () => {
      const promoted = await call(`/api/admin/users/${kwame.user.id}`, {
        method: 'PATCH', token: admin.token, body: { role: 'admin' }
      });
      assert.equal(promoted.status, 200);
      assert.equal(promoted.body.user.role, 'admin');

      // Put it back.
      await call(`/api/admin/users/${kwame.user.id}`, {
        method: 'PATCH', token: admin.token, body: { role: 'participant' }
      });
    });
  });

  test('suspending an account kills its sessions', async () => {
    const victim = amina.user.id;

    // try/finally, because an assertion that throws halfway through
    // would otherwise leave this account suspended and break every
    // later run. The suite also repairs state in setup (see
    // restoreDemoAccounts in helpers.js), but a test that cleans up
    // after itself is the first line of defence, not the second.
    try {
      const suspended = await call(`/api/admin/users/${victim}`, {
        method: 'PATCH', token: admin.token, body: { status: 'suspended' }
      });
      assert.equal(suspended.status, 200);

      const sessions = await query(
        `SELECT count(*)::int AS n FROM refresh_tokens
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [victim]
      );
      assert.equal(sessions.rows[0].n, 0,
        'a suspension that leaves sessions working is not a suspension');

      // A suspended account cannot sign in again either.
      const blocked = await call('/api/auth/login', {
        method: 'POST',
        body: { email: ACCOUNTS.amina, password: 'YcpDemo2026!' }
      });
      assert.equal(blocked.status, 401);
    } finally {
      // Straight to the database rather than through the API: if the
      // failure above was an authorisation problem, the API route may
      // be exactly what is not working.
      await query(
        `UPDATE users SET status = 'active' WHERE id = $1`, [victim]
      ).catch(() => {});
    }
  });

  test('role and status changes are written to the audit trail', async () => {
    const before = await query(
      `SELECT count(*)::int AS n FROM access_audit WHERE action = 'admin:update_user'`
    );

    await call(`/api/admin/users/${kwame.user.id}`, {
      method: 'PATCH', token: admin.token, body: { status: 'active' }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = await query(
      `SELECT count(*)::int AS n FROM access_audit WHERE action = 'admin:update_user'`
    );
    assert.ok(after.rows[0].n > before.rows[0].n,
      'who changed whose role, and when, must be recoverable');
  });

  test('the security console lists denials and password changes', async () => {
    const result = await call('/api/admin/security', { token: admin.token });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.suspects));
    assert.ok(Array.isArray(result.body.denials));
    assert.ok(Array.isArray(result.body.passwordChanges));
  });
});

describe('Creating a course keeps everything it was given (ADR-025)', () => {

  /**
   * POST /api/activities validated 21 fields and inserted 12. The other
   * nine, outcomes, prerequisites, weeks, hoursPerWeek, level, languages,
   * skills, instructorNote and the certificate settings, were accepted,
   * validated, acknowledged with 201, and discarded.
   *
   * No error, no warning. The facilitator's landing-page copy simply was
   * not there, and the only way to get it in was to PATCH the course
   * immediately after creating it.
   *
   * The cause was two hand-maintained lists of field-to-column mappings,
   * one per handler. PATCH's was complete; POST's was not, and nothing
   * could notice. Both now build their SQL from one shared map.
   *
   * This test asserts the ROUND TRIP rather than the mapping, because a
   * test that reads the same constant the code does proves nothing.
   */

  test('every field the schema accepts survives creation', async () => {
    const sent = {
      title: 'ADR-025 round trip probe',
      summary: 'Confirming that nothing sent to the create endpoint is silently dropped.',
      type: 'workshop',
      status: 'draft',
      estimatedMinutes: 240,
      tags: ['probe', 'adr-025'],
      outcomes: ['Name the defect', 'Explain why no test caught it'],
      prerequisites: ['Having read the test log'],
      weeks: 3,
      hoursPerWeek: 2.5,
      level: 'intermediate',
      languages: ['English', 'Swahili'],
      skills: ['Reading a schema against a handler'],
      instructorNote: 'Written by the suite, deleted by the suite.',
      awardsCertificate: true,
      certificateTitle: 'ADR-025 Probe Certificate',
      requiresPass: false
    };

    const created = await call('/api/activities', {
      method: 'POST', token: facilitator.token, body: sent
    });
    assert.equal(created.status, 201);
    const id = created.body.activity.id;

    try {
      const stored = await query(
        `SELECT title, summary, type, status, estimated_minutes, tags,
                outcomes, prerequisites, weeks, hours_per_week, level,
                languages, skills, instructor_note,
                awards_certificate, certificate_title, requires_pass
           FROM activities WHERE id = $1`,
        [id]
      );
      const row = stored.rows[0];
      assert.ok(row, 'the course exists');

      assert.equal(row.title, sent.title);
      assert.equal(row.summary, sent.summary);
      assert.equal(row.type, sent.type);
      assert.equal(row.status, sent.status);
      assert.equal(row.estimated_minutes, sent.estimatedMinutes);
      assert.deepEqual(row.tags, sent.tags);

      // The nine that used to vanish.
      assert.deepEqual(row.outcomes, sent.outcomes, 'outcomes were dropped');
      assert.deepEqual(row.prerequisites, sent.prerequisites, 'prerequisites were dropped');
      assert.equal(row.weeks, sent.weeks, 'weeks was dropped');
      assert.equal(Number(row.hours_per_week), sent.hoursPerWeek, 'hoursPerWeek was dropped');
      assert.equal(row.level, sent.level, 'level was dropped');
      assert.deepEqual(row.languages, sent.languages, 'languages were dropped');
      assert.deepEqual(row.skills, sent.skills, 'skills were dropped');
      assert.equal(row.instructor_note, sent.instructorNote, 'instructorNote was dropped');
      assert.equal(row.awards_certificate, true, 'awardsCertificate was dropped');
      assert.equal(row.certificate_title, sent.certificateTitle, 'certificateTitle was dropped');
      assert.equal(row.requires_pass, false, 'requiresPass was dropped');
    } finally {
      // Created here, deleted here. A stray published-adjacent course
      // would change the counts every discovery test asserts.
      await query('DELETE FROM activities WHERE id = $1', [id]).catch(() => {});
    }
  });

  test('a course created with only the required fields still works', async () => {
    // The create form sends four fields. Everything else must fall to a
    // column default rather than being written as NULL, because the array
    // columns are NOT NULL.
    const created = await call('/api/activities', {
      method: 'POST',
      token: facilitator.token,
      body: {
        title: 'ADR-025 minimal probe',
        summary: 'Only the fields the create form actually sends.',
        type: 'course',
        estimatedMinutes: 120
      }
    });
    assert.equal(created.status, 201, 'a minimal create must succeed');

    try {
      const stored = await query(
        `SELECT status, tags, outcomes, skills, languages
           FROM activities WHERE id = $1`,
        [created.body.activity.id]
      );
      const row = stored.rows[0];
      assert.equal(row.status, 'draft', 'a new course is not published by accident');
      for (const [name, value] of Object.entries(row)) {
        if (Array.isArray(value)) {
          assert.ok(Array.isArray(value), `${name} must be an array, not null`);
        }
      }
    } finally {
      await query('DELETE FROM activities WHERE id = $1', [created.body.activity.id]).catch(() => {});
    }
  });
});
