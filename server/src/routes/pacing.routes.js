import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can, requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';

const router = Router();

/* ================================================================== */
/* THE PERSONAL SCHEDULE                                              */
/* ================================================================== */

/**
 * GET /api/activities/:id/schedule
 *
 * A participant's own timeline for one course: what is due when, what
 * is behind, and what is next.
 *
 * Every date here is derived from their enrolment date and the module's
 * week offset (ADR-020). Nothing is stored per participant, so there is
 * no possibility of a saved deadline drifting from the schedule it came
 * from.
 */
router.get(
  '/activities/:id/schedule',
  authenticate,
  can('activity:participate'),
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT module_id, position, title, week_offset, due_at,
              status, completed_at, is_overdue, enrolled_at
         FROM module_schedule
        WHERE activity_id = $1 AND user_id = $2
        ORDER BY position`,
      [req.params.id, req.user.id]
    );

    const schedule = rows.rows;
    const behind = schedule.filter((row) => row.is_overdue);

    // "What should I do next" is the question this page exists to
    // answer, so it is computed here rather than left to the client to
    // work out from the list.
    const next = schedule.find((row) => row.status !== 'completed') ?? null;

    return sendJson(req, res, {
      schedule,
      summary: {
        total: schedule.length,
        completed: schedule.filter((row) => row.status === 'completed').length,
        behind: behind.length,
        nextModule: next,
        // The honest framing. Not "you are late", which is a verdict on
        // the person, but "the suggested date has passed", which is a
        // fact about a suggestion.
        startedAt: schedule[0]?.enrolled_at ?? null
      }
    }, { private: true });
  })
);

/**
 * POST /api/activities/:id/schedule/reset
 *
 * Shift the whole schedule forward to start from today.
 *
 * Coursera offers this and it is the humane behaviour: someone who lost
 * a fortnight to a power cut should be able to carry on with a
 * realistic plan rather than stare at a wall of missed dates and
 * conclude the course is not for them.
 *
 * Because deadlines are derived, this is one UPDATE to one column. With
 * stored per-participant dates it would be a row per module and a hope
 * that none were missed.
 */
router.post(
  '/activities/:id/schedule/reset',
  authenticate,
  can('activity:participate'),
  wrap(async (req, res) => {
    const enrolment = await queryOne(
      `SELECT id, status FROM enrolments WHERE activity_id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!enrolment) throw notFound('Enrolment');
    if (enrolment.status === 'completed') {
      throw badRequest('You have already finished this course.');
    }

    const result = await queryOne(
      `SELECT reset_schedule($1) AS started_at`, [enrolment.id]
    );

    return sendJson(req, res, {
      startedAt: result.started_at,
      message: 'Your schedule now starts from today.'
    });
  })
);

/* ================================================================== */
/* GRADES                                                             */
/* ================================================================== */

/**
 * GET /api/activities/:id/grades
 *
 * Every assessment in this course, attempted or not, with the best
 * attempt. The unattempted rows are the point: a grades page that only
 * lists what you have done cannot tell you what you still owe.
 */
router.get(
  '/activities/:id/grades',
  authenticate,
  can('activity:participate'),
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT assessment_id, title, type, max_score, pass_score,
              max_attempts, due_at, best_score, status, attempts_used,
              submitted_at, graded_at, passed, submission_count
         FROM grade_book
        WHERE activity_id = $1 AND user_id = $2
        ORDER BY due_at NULLS LAST, title`,
      [req.params.id, req.user.id]
    );

    const grades = rows.rows;
    const graded = grades.filter((row) => row.best_score !== null);

    // A weighted average would be wrong here: assessments have
    // different max scores, so averaging raw marks over-weights the
    // long ones. Percentages of their own maximum are comparable.
    const overall = graded.length
      ? Math.round(
          graded.reduce((sum, row) =>
            sum + (Number(row.best_score) / Number(row.max_score)) * 100, 0
          ) / graded.length
        )
      : null;

    const activity = await queryOne(
      `SELECT title, requires_pass, awards_certificate FROM activities WHERE id = $1`,
      [req.params.id]
    );

    return sendJson(req, res, {
      activity,
      grades,
      summary: {
        total: grades.length,
        attempted: graded.length,
        passed: grades.filter((row) => row.passed === true).length,
        outstanding: grades.filter((row) => row.best_score === null).length,
        overall,
        // What the participant actually wants to know: am I on track
        // for the certificate.
        allPassed: grades.length > 0 && grades.every((row) => row.passed === true)
      }
    }, { private: true });
  })
);

/* ================================================================== */
/* AUTHORING: objectives, schedule and skills                         */
/* ================================================================== */

const moduleMetaSchema = z.object({
  objectives: z.array(z.string().min(3).max(200)).max(6).optional(),
  weekOffset: z.number().int().min(1).max(52).nullable().optional()
});

/**
 * PATCH /api/activities/:id/modules/:moduleId/meta
 *
 * Objectives are capped at six for the same reason course outcomes are
 * capped at eight: the failure mode is a facilitator pasting a syllabus
 * into a field meant for a short list, and nobody reads that.
 */
router.patch(
  '/activities/:id/modules/:moduleId/meta',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: moduleMetaSchema }),
  wrap(async (req, res) => {
    const sets = [];
    const params = [req.params.moduleId, req.params.id];

    if (req.body.objectives !== undefined) {
      params.push(req.body.objectives);
      sets.push(`objectives = $${params.length}`);
    }
    if (req.body.weekOffset !== undefined) {
      params.push(req.body.weekOffset);
      sets.push(`week_offset = $${params.length}`);
    }
    if (!sets.length) throw badRequest('No changes supplied.');

    // activity_id is in the WHERE clause, so a module belonging to
    // another facilitator's course matches nothing even though can()
    // has already approved this caller for this course.
    const module = await queryOne(
      `UPDATE activity_modules SET ${sets.join(', ')}
        WHERE id = $1 AND activity_id = $2
        RETURNING id, position, title, objectives, week_offset`,
      params
    );
    if (!module) throw notFound('Section');

    return sendJson(req, res, { module });
  })
);

export default router;
