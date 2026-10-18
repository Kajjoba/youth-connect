import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can, requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson, readPagination, paginate } from '../lib/http.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

/**
 * =====================================================================
 * FACILITATOR WORKSPACE
 *
 * The brief requires that "facilitators and administrators should be
 * able to manage relevant programme information and participant
 * activities". This is that surface.
 *
 * Every route here is gated twice on purpose:
 *
 *   requireRole answers "is this the kind of account that may author
 *   content at all", which is a coarse question about the caller.
 *
 *   can() answers "does this caller own THIS activity", which is a
 *   question about the record.
 *
 * A facilitator who only passed the role gate could edit a colleague's
 * activity by changing the id in the URL, which is the same defect the
 * brief describes in section 5 wearing a different hat.
 * =====================================================================
 */

/**
 * GET /api/facilitator/activities
 *
 * The facilitator's own activities with the counts they actually need:
 * how many enrolled, how many finished, and crucially how many
 * submissions are sitting ungraded. That last number is the one that
 * makes this page worth opening.
 */
router.get(
  '/facilitator/activities',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT a.id, a.slug, a.title, a.summary, a.type, a.status,
              a.capacity, a.estimated_minutes, a.opens_at, a.closes_at,
              a.created_at, a.updated_at,
              (SELECT count(*)::int FROM activity_modules m WHERE m.activity_id = a.id)
                AS module_count,
              (SELECT count(*)::int FROM enrolments e WHERE e.activity_id = a.id
                 AND e.status <> 'withdrawn')
                AS enrolled_count,
              (SELECT count(*)::int FROM enrolments e WHERE e.activity_id = a.id
                 AND e.status = 'completed')
                AS completed_count,
              (SELECT count(*)::int FROM assessments asm WHERE asm.activity_id = a.id)
                AS assessment_count,
              (SELECT count(*)::int
                 FROM submissions s
                 JOIN assessments asm ON asm.id = s.assessment_id
                WHERE asm.activity_id = a.id AND s.status = 'submitted')
                AS awaiting_grading
         FROM activities a
        WHERE ($1 OR a.facilitator_id = $2)
        ORDER BY a.updated_at DESC`,
      [isAdminRole(req.user.role), req.user.id]
    );

    const activities = rows.rows;
    const summary = {
      total: activities.length,
      published: activities.filter((a) => a.status === 'published').length,
      drafts: activities.filter((a) => a.status === 'draft').length,
      participants: activities.reduce((sum, a) => sum + a.enrolled_count, 0),
      awaitingGrading: activities.reduce((sum, a) => sum + a.awaiting_grading, 0)
    };

    return sendJson(req, res, { summary, activities }, { private: true });
  })
);

/* ------------------------------------------------------------------ */
/* MODULES                                                            */
/* ------------------------------------------------------------------ */

const moduleSchema = z.object({
  title: z.string().min(3).max(200),
  body: z.string().max(20_000).optional(),
  resourceUrl: z.string().url().max(500).optional().or(z.literal('')),
  estimatedMinutes: z.number().int().positive().max(600).default(15)
});

/**
 * POST /api/activities/:id/modules
 *
 * Position is assigned by the database rather than supplied by the
 * client. Two facilitators adding a section at once would otherwise
 * both claim the same position and violate the unique constraint, and
 * the resulting error would be incomprehensible to the person who hit
 * it.
 */
router.post(
  '/activities/:id/modules',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: moduleSchema }),
  wrap(async (req, res) => {
    const { title, body, resourceUrl, estimatedMinutes } = req.body;

    const module = await withTransaction(async (client) => {
      // Lock the activity so concurrent inserts serialise on it.
      await client.query('SELECT id FROM activities WHERE id = $1 FOR UPDATE', [req.params.id]);

      const next = await client.query(
        `SELECT COALESCE(max(position), 0) + 1 AS position
           FROM activity_modules WHERE activity_id = $1`,
        [req.params.id]
      );

      const inserted = await client.query(
        `INSERT INTO activity_modules (activity_id, position, title, body, resource_url, estimated_minutes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, position, title, estimated_minutes`,
        [req.params.id, next.rows[0].position, title, body ?? null,
         resourceUrl || null, estimatedMinutes]
      );

      // Anyone already enrolled needs a progress row for the new
      // section, or their completion percentage silently stops adding
      // up to the number of sections they can see.
      await client.query(
        `INSERT INTO module_progress (enrolment_id, module_id, status)
         SELECT e.id, $2, 'not_started'
           FROM enrolments e
          WHERE e.activity_id = $1
         ON CONFLICT (enrolment_id, module_id) DO NOTHING`,
        [req.params.id, inserted.rows[0].id]
      );

      return inserted.rows[0];
    });

    return sendJson(req, res, { module }, { status: 201 });
  })
);

/** PATCH /api/activities/:id/modules/:moduleId */
router.patch(
  '/activities/:id/modules/:moduleId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: moduleSchema.partial() }),
  wrap(async (req, res) => {
    const columns = {
      title: 'title', body: 'body',
      resourceUrl: 'resource_url', estimatedMinutes: 'estimated_minutes'
    };

    const sets = [];
    const params = [req.params.moduleId, req.params.id];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key] === '' ? null : req.body[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('No changes supplied.');

    // activity_id is in the WHERE clause, not just the module id. A
    // module id from another facilitator's activity therefore matches
    // nothing, even though can() has already approved this activity.
    const module = await queryOne(
      `UPDATE activity_modules SET ${sets.join(', ')}
        WHERE id = $1 AND activity_id = $2
        RETURNING id, position, title, estimated_minutes`,
      params
    );
    if (!module) throw notFound('Section');

    return sendJson(req, res, { module });
  })
);

/** DELETE /api/activities/:id/modules/:moduleId */
router.delete(
  '/activities/:id/modules/:moduleId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const removed = await queryOne(
      `DELETE FROM activity_modules WHERE id = $1 AND activity_id = $2 RETURNING position`,
      [req.params.moduleId, req.params.id]
    );
    if (!removed) throw notFound('Section');

    // Close the gap so positions stay contiguous. Leaving holes means
    // the numbering a participant sees drifts from the stored order.
    await query(
      `UPDATE activity_modules SET position = position - 1
        WHERE activity_id = $1 AND position > $2`,
      [req.params.id, removed.position]
    );

    return sendJson(req, res, { ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* ASSESSMENTS                                                        */
/* ------------------------------------------------------------------ */

const assessmentSchema = z.object({
  title: z.string().min(3).max(200),
  instructions: z.string().max(5000).optional(),
  type: z.enum(['quiz', 'submission', 'reflection']).default('quiz'),
  maxScore: z.number().positive().max(1000).default(100),
  passScore: z.number().min(0).max(1000).default(50),
  maxAttempts: z.number().int().min(1).max(10).default(1),
  dueAt: z.string().datetime().optional(),
  // The capstone quiz for the course: passing it is what the
  // certificate is gated on (migration 015). At most one per
  // activity; the routes below unset any previous one rather than
  // relying on the database to reject a second.
  isFinal: z.boolean().default(false),
  questions: z.array(z.object({
    prompt: z.string().min(3).max(2000),
    options: z.array(z.object({
      key: z.string().min(1).max(8),
      text: z.string().min(1).max(500)
    })).min(2).max(6),
    correctKey: z.string().min(1).max(8),
    points: z.number().positive().max(100).default(1)
  })).max(50).default([])
}).refine((value) => value.passScore <= value.maxScore, {
  message: 'The pass mark cannot be higher than the maximum score.',
  path: ['passScore']
}).refine(
  (value) => value.questions.every((q) => q.options.some((o) => o.key === q.correctKey)),
  { message: 'Every question needs its correct answer to be one of its options.', path: ['questions'] }
);

/**
 * POST /api/activities/:id/assessments
 *
 * The assessment and its questions are created in one transaction. A
 * half-created assessment with no questions is a state participants can
 * open and be stuck in, so it is made unreachable rather than handled.
 */
router.post(
  '/activities/:id/assessments',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: assessmentSchema }),
  wrap(async (req, res) => {
    const b = req.body;

    if (b.type === 'quiz' && b.questions.length === 0) {
      throw badRequest('A quiz needs at least one question.');
    }

    const assessment = await withTransaction(async (client) => {
      // Only one capstone quiz per activity. Unsetting the previous
      // one here, inside the same transaction, means checking the box
      // on a new quiz is "make this the final one" rather than an
      // error telling the facilitator to go remove the old flag
      // themselves first.
      if (b.isFinal) {
        await client.query(
          `UPDATE assessments SET is_final = false WHERE activity_id = $1 AND is_final`,
          [req.params.id]
        );
      }

      const created = await client.query(
        `INSERT INTO assessments
           (activity_id, title, instructions, type, max_score, pass_score, max_attempts, due_at, is_final)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, title, type, max_score, pass_score, max_attempts, due_at, is_final`,
        [req.params.id, b.title, b.instructions ?? null, b.type,
         b.maxScore, b.passScore, b.maxAttempts, b.dueAt ?? null, b.isFinal]
      );

      for (const [index, question] of b.questions.entries()) {
        await client.query(
          `INSERT INTO assessment_questions
             (assessment_id, position, prompt, options, correct_key, points)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [created.rows[0].id, index + 1, question.prompt,
           JSON.stringify(question.options), question.correctKey, question.points]
        );
      }

      return created.rows[0];
    });

    return sendJson(req, res, { assessment }, { status: 201 });
  })
);

/**
 * GET /api/activities/:id/assessments
 *
 * Every quiz/assignment belonging to this activity, questions included.
 * This is what lets the content editor offer a real dropdown of quizzes
 * when a facilitator adds a "quiz" item, and what an edit screen loads
 * before letting someone revise one. correct_key IS included here,
 * unlike the participant-facing GET /api/assessments/:id: this route is
 * gated to the activity's own facilitator or an admin, the people who
 * are allowed to know the answer key because they are the ones setting it.
 */
router.get(
  '/activities/:id/assessments',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const assessments = await query(
      `SELECT id, title, instructions, type, max_score, pass_score, max_attempts, due_at, is_final
         FROM assessments WHERE activity_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    const questionRows = await query(
      `SELECT assessment_id, id, position, prompt, options, correct_key, points
         FROM assessment_questions
        WHERE assessment_id = ANY($1)
        ORDER BY assessment_id, position`,
      [assessments.rows.map((row) => row.id)]
    );

    const result = assessments.rows.map((assessment) => ({
      ...assessment,
      questions: questionRows.rows
        .filter((question) => question.assessment_id === assessment.id)
        .map(({ assessment_id, ...question }) => question)
    }));

    return sendJson(req, res, { assessments: result }, { private: true });
  })
);

/**
 * PATCH /api/activities/:id/assessments/:assessmentId
 *
 * Updating a quiz replaces its questions wholesale rather than trying to
 * diff and patch individual rows: a facilitator revising a quiz thinks
 * of it as "here is the new set of questions", not as a sequence of
 * inserts, moves and deletes, and matching that mental model is what
 * keeps this simple enough to be reliable.
 *
 * Existing submissions are untouched. A participant who already
 * attempted the old version keeps that scored attempt; only future
 * attempts see the revised questions. Rewriting history that someone
 * has already been graded against would be the real mistake here.
 */
router.patch(
  '/activities/:id/assessments/:assessmentId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: assessmentSchema }),
  wrap(async (req, res) => {
    const b = req.body;

    if (b.type === 'quiz' && b.questions.length === 0) {
      throw badRequest('A quiz needs at least one question.');
    }

    const assessment = await withTransaction(async (client) => {
      if (b.isFinal) {
        await client.query(
          `UPDATE assessments SET is_final = false
            WHERE activity_id = $1 AND is_final AND id <> $2`,
          [req.params.id, req.params.assessmentId]
        );
      }

      const updated = await client.query(
        `UPDATE assessments
            SET title = $3, instructions = $4, type = $5,
                max_score = $6, pass_score = $7, max_attempts = $8, due_at = $9,
                is_final = $10
          WHERE id = $1 AND activity_id = $2
         RETURNING id, title, type, max_score, pass_score, max_attempts, due_at, is_final`,
        [req.params.assessmentId, req.params.id, b.title, b.instructions ?? null,
         b.type, b.maxScore, b.passScore, b.maxAttempts, b.dueAt ?? null, b.isFinal]
      );
      if (!updated.rows[0]) throw notFound('Assessment');

      await client.query('DELETE FROM assessment_questions WHERE assessment_id = $1', [req.params.assessmentId]);

      for (const [index, question] of b.questions.entries()) {
        await client.query(
          `INSERT INTO assessment_questions
             (assessment_id, position, prompt, options, correct_key, points)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [req.params.assessmentId, index + 1, question.prompt,
           JSON.stringify(question.options), question.correctKey, question.points]
        );
      }

      return updated.rows[0];
    });

    return sendJson(req, res, { assessment });
  })
);

/**
 * GET /api/activities/:id/submissions
 *
 * The grading queue. Ungraded work first, because that is the entire
 * reason a facilitator opens this page.
 */
router.get(
  '/activities/:id/submissions',
  authenticate,
  requireRole('facilitator', 'mentor', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const { limit, cursor } = readPagination(req);
    const params = [req.params.id, limit + 1];

    const rows = await query(
      `SELECT s.id, s.attempt, s.status, s.score, s.submitted_at, s.graded_at,
              s.artifact_url,
              asm.id AS assessment_id, asm.title AS assessment_title,
              asm.max_score, asm.pass_score, asm.type AS assessment_type,
              u.id AS participant_id,
              p.full_name AS participant_name,
              p.country,
              (SELECT count(*)::int FROM feedback f WHERE f.submission_id = s.id)
                AS feedback_count
         FROM submissions s
         JOIN assessments asm ON asm.id = s.assessment_id
         JOIN users u         ON u.id = s.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
        WHERE asm.activity_id = $1 AND s.status <> 'draft'
        ORDER BY (s.status = 'submitted') DESC, s.submitted_at ASC
        LIMIT $2`,
      params
    );

    const page = paginate(rows.rows, limit, (row) => ({ id: row.id }));
    page.counts = {
      awaiting: rows.rows.filter((row) => row.status === 'submitted').length,
      graded: rows.rows.filter((row) => row.status === 'graded').length
    };

    return sendJson(req, res, page, { private: true });
  })
);

/**
 * GET /api/activities/:id/participants
 *
 * Who is enrolled and how far they have got. Contact details are not
 * selected: a facilitator needs to see progress, not harvest phone
 * numbers, and the narrower query is the one that cannot leak.
 */
router.get(
  '/activities/:id/participants',
  authenticate,
  requireRole('facilitator', 'mentor', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT u.id, p.full_name, p.country, p.digital_literacy,
              e.status AS enrolment_status, e.enrolled_at, e.completed_at,
              count(mp.id)::int AS modules_total,
              count(mp.id) FILTER (WHERE mp.status = 'completed')::int AS modules_done
         FROM enrolments e
         JOIN users u              ON u.id = e.user_id
         LEFT JOIN profiles p      ON p.user_id = u.id
         LEFT JOIN module_progress mp ON mp.enrolment_id = e.id
        WHERE e.activity_id = $1
        GROUP BY u.id, p.full_name, p.country, p.digital_literacy,
                 e.status, e.enrolled_at, e.completed_at
        ORDER BY p.full_name`,
      [req.params.id]
    );

    const participants = rows.rows.map((row) => ({
      ...row,
      percent: row.modules_total
        ? Math.round((row.modules_done / row.modules_total) * 100)
        : 0
    }));

    return sendJson(req, res, { participants }, { private: true });
  })
);

export default router;
