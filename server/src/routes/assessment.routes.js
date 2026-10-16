import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can, requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const router = Router();

/**
 * GET /api/assessments/:id
 * REQ-FUN-007 Complete assessment.
 *
 * The correct_key column is NEVER selected here. A participant who opens
 * DevTools and inspects the network response must not find the answers
 * sitting in the payload. Marking is server side only, in
 * POST /submissions below. Any design that ships answers to the client
 * and marks in JavaScript is trivially defeated and would be a fair
 * target for the review committee.
 */
router.get(
  '/:id',
  authenticate,
  wrap(async (req, res) => {
    const assessment = await queryOne(
      `SELECT asm.id, asm.title, asm.instructions, asm.type, asm.max_score,
              asm.pass_score, asm.max_attempts, asm.due_at,
              asm.activity_id, a.title AS activity_title
         FROM assessments asm
         JOIN activities a ON a.id = asm.activity_id
         JOIN enrolments e ON e.activity_id = a.id AND e.user_id = $2
        WHERE asm.id = $1`,
      [req.params.id, req.user.id]
    );

    // No enrolment means no row, which means 404. The enrolment check is
    // part of the lookup rather than a separate if-statement, so it
    // cannot be skipped by a future edit to this handler.
    if (!assessment) throw notFound('Assessment');

    const questions = await query(
      `SELECT id, position, prompt, options, points
         FROM assessment_questions
        WHERE assessment_id = $1
        ORDER BY position`,
      [req.params.id]
    );

    const attempts = await query(
      `SELECT id, attempt, status, score, submitted_at, graded_at
         FROM submissions
        WHERE assessment_id = $1 AND user_id = $2
        ORDER BY attempt DESC`,
      [req.params.id, req.user.id]
    );

    const used = attempts.rows.filter((row) => row.status !== 'draft').length;

    return sendJson(req, res, {
      assessment,
      questions: questions.rows,
      attempts: attempts.rows,
      attemptsRemaining: Math.max(0, assessment.max_attempts - used)
    });
  })
);

/**
 * =====================================================================
 * ADR-026: instant per-question checking, a deliberate trade-off.
 *
 * The GET /:id handler above documents, on purpose, that correct_key is
 * never sent to the client: marking happens server side so a participant
 * cannot read the answer key out of the network tab.
 *
 * This endpoint is the user-requested exception to that rule, made with
 * eyes open rather than by accident. Coursera-style instant "check this
 * answer" feedback is explicitly requested interactivity, and the honest
 * cost of it is that a participant who checks every option in turn can
 * find the correct one before ever submitting, which is a real, accepted
 * weakening of quiz integrity for this specific feature.
 *
 * Two things keep the damage bounded rather than total:
 *
 *   1. This route returns ONLY a boolean. A wrong guess never reveals
 *      which option was correct, so the fastest path is still "try an
 *      option, get told you're wrong, try another", not "read the
 *      answer off the wire" the way an unprotected GET /:id would be.
 *
 *   2. Checking a question has no effect on submissions at all. The real
 *      grade still comes only from POST /submissions below, which still
 *      marks server side from assessment_questions directly and still
 *      counts against max_attempts exactly as before. A participant who
 *      never calls this endpoint is marked identically to one who uses
 *      it on every question.
 *
 * Rate limited, because without a limit this becomes a fast local oracle
 * for brute-forcing every question in a multiple-choice assessment.
 * =====================================================================
 */
const checkLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.CHECK_ANSWER_RATE_LIMIT) || (config.env === 'test' ? 200 : 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Slow down and try again in a moment.' } }
});

const checkSchema = z.object({
  selected: z.string().min(1).max(64)
});

router.post(
  '/:id/questions/:questionId/check',
  authenticate,
  checkLimiter,
  validate({ body: checkSchema }),
  wrap(async (req, res) => {
    // The enrolment join is the entitlement check: the same shape as
    // GET /:id above, so a participant who cannot open the assessment
    // cannot probe its questions either.
    const question = await queryOne(
      `SELECT q.id, q.correct_key
         FROM assessment_questions q
         JOIN assessments asm ON asm.id = q.assessment_id
         JOIN enrolments e    ON e.activity_id = asm.activity_id AND e.user_id = $3
        WHERE q.assessment_id = $1 AND q.id = $2
          AND asm.type = 'quiz'`,
      [req.params.id, req.params.questionId, req.user.id]
    );
    if (!question) throw notFound('Question');

    return sendJson(req, res, {
      correct: question.correct_key != null && req.body.selected === question.correct_key
    }, { private: true });
  })
);

const submissionSchema = z.object({
  answers: z.record(z.string().max(64), z.string().max(5000)).default({}),
  artifactUrl: z.string().url().max(500).optional(),
  // Client-generated key so a retry after a dropped connection does not
  // create a second attempt. REQ-NFR-006, offline resilience.
  idempotencyKey: z.string().min(8).max(64).optional()
});

/**
 * POST /api/assessments/:id/submissions
 *
 * Attempt limits and marking are both inside one transaction with a
 * lock on the assessment row, so a participant cannot fire two parallel
 * submissions to get an extra attempt.
 */
router.post(
  '/:id/submissions',
  authenticate,
  validate({ body: submissionSchema }),
  wrap(async (req, res) => {
    const assessmentId = req.params.id;
    const { answers, artifactUrl } = req.body;

    const result = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT asm.id, asm.type, asm.max_score, asm.pass_score, asm.max_attempts, asm.due_at
           FROM assessments asm
           JOIN enrolments e ON e.activity_id = asm.activity_id AND e.user_id = $2
          WHERE asm.id = $1
            FOR UPDATE OF asm`,
        [assessmentId, req.user.id]
      );
      const assessment = found.rows[0];
      if (!assessment) throw notFound('Assessment');

      if (assessment.due_at && new Date(assessment.due_at) < new Date()) {
        throw badRequest('The deadline for this assessment has passed.');
      }

      const priorCount = await client.query(
        `SELECT count(*)::int AS used FROM submissions
          WHERE assessment_id = $1 AND user_id = $2 AND status <> 'draft'`,
        [assessmentId, req.user.id]
      );
      if (priorCount.rows[0].used >= assessment.max_attempts) {
        throw conflict('You have used all attempts for this assessment.');
      }

      // Server-side marking for quizzes.
      let score = null;
      let status = 'submitted';

      if (assessment.type === 'quiz') {
        const keyRows = await client.query(
          `SELECT id, correct_key, points FROM assessment_questions WHERE assessment_id = $1`,
          [assessmentId]
        );
        let earned = 0;
        let possible = 0;
        for (const question of keyRows.rows) {
          possible += Number(question.points);
          if (question.correct_key && answers[question.id] === question.correct_key) {
            earned += Number(question.points);
          }
        }
        score = possible > 0
          ? Number(((earned / possible) * Number(assessment.max_score)).toFixed(2))
          : 0;
        status = 'graded';
      }

      const inserted = await client.query(
        // $6 is cast explicitly to submission_status.
        //
        // Without the cast, Postgres sees $6 used both as a value for
        // the status column (submission_status) and inside a comparison
        // against the string 'graded' (text), and refuses with
        // "inconsistent types deduced for parameter $6". That made every
        // submission fail with a 500. Casting pins the type once, and
        // the comparison then happens between two enum values.
        `INSERT INTO submissions
           (assessment_id, user_id, attempt, answers, artifact_url, status, score, submitted_at, graded_at)
         VALUES ($1, $2, $3, $4, $5, $6::submission_status, $7, now(),
                 CASE WHEN $6::submission_status = 'graded' THEN now() ELSE NULL END)
         RETURNING id, attempt, status, score, submitted_at`,
        [assessmentId, req.user.id, priorCount.rows[0].used + 1,
         JSON.stringify(answers), artifactUrl ?? null, status, score]
      );

      return { submission: inserted.rows[0], passScore: assessment.pass_score };
    });

    return sendJson(req, res, {
      submission: result.submission,
      passed: result.submission.score !== null
        ? Number(result.submission.score) >= Number(result.passScore)
        : null
    }, { status: 201 });
  })
);

/**
 * =====================================================================
 * INCIDENT DEFENCE 1
 *
 * Brief section 5: "The team submits a project proposal and receives
 * mentor feedback. One member cannot see the updated feedback."
 *
 * Three things cause that symptom. All three are addressed here.
 *
 *   a) STALE CLIENT CACHE. The client held a cached copy and the server
 *      gave it no way to know it was out of date. This endpoint used to
 *      be paired with the app's now-removed ETag/conditional-request
 *      layer, versioned off feedback.version so a revision invalidated
 *      the cached copy deterministically; with caching removed
 *      altogether, every request simply gets the current row, so this
 *      failure mode cannot recur here regardless.
 *
 *   b) PARTIAL VISIBILITY. Feedback released per-recipient can reach
 *      some members and not others. Fixed by visible_from: feedback
 *      becomes visible to everyone entitled to it at one instant.
 *
 *   c) SILENT FAILURE. Nobody could tell whether the member had seen it.
 *      Fixed by read receipts recorded per version, so the facilitator
 *      view shows exactly who has read the current revision.
 * =====================================================================
 */
router.get(
  '/submissions/:id/feedback',
  authenticate,
  can('submission:read', { param: 'id' }),
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT f.id, f.body, f.rubric, f.version, f.created_at, f.updated_at,
              p.full_name AS reviewer_name,
              r.version_seen,
              r.read_at
         FROM feedback f
         LEFT JOIN profiles p ON p.user_id = f.reviewer_id
         LEFT JOIN feedback_receipts r
                ON r.feedback_id = f.id
               AND r.user_id = $2
               AND r.version_seen = f.version
        WHERE f.submission_id = $1
          AND f.visible_from <= now()
        ORDER BY f.created_at`,
      [req.params.id, req.user.id]
    );

    const feedback = rows.rows.map((row) => ({
      id: row.id,
      body: row.body,
      rubric: row.rubric,
      version: row.version,
      reviewerName: row.reviewer_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // The client uses this to badge revised feedback as unread even
      // when an earlier version was already read.
      isUnread: row.read_at === null
    }));

    // The read receipt is deliberately NOT written here.
    //
    // DEFECT FOUND 2026-09-25 (see docs/test-log.md). This handler used
    // to record a receipt as a side effect of the GET. That made the
    // response non-idempotent: the first request returned
    // isUnread: true, the receipt landed, and the identical second
    // request returned isUnread: false. A different body means a
    // different ETag, so the conditional request never matched and the
    // caching layer this endpoint depends on was silently dead.
    //
    // It passed locally and failed against a hosted database purely
    // because of latency: on a loopback connection the fire-and-forget
    // write had not landed before the next request, so the two bodies
    // happened to match.
    //
    // The underlying mistake is older than the bug, and independent of
    // caching: GET is defined as safe, meaning it must not change server
    // state. Marking something read is a state change and belongs in its
    // own POST, which the client sends once it has actually displayed
    // the feedback. That is also more accurate: a response being fetched
    // is not evidence a human read it.
    return sendJson(req, res, { feedback });
  })
);

/**
 * POST /api/assessments/submissions/:id/feedback/read
 *
 * Records that the participant has seen the current version of each
 * visible piece of feedback. Idempotent: sending it twice records one
 * receipt per version, so a client that retries after a dropped
 * connection cannot create duplicates.
 */
router.post(
  '/submissions/:id/feedback/read',
  authenticate,
  can('submission:read', { param: 'id' }),
  wrap(async (req, res) => {
    const result = await query(
      `INSERT INTO feedback_receipts (feedback_id, user_id, version_seen)
       SELECT f.id, $2, f.version
         FROM feedback f
        WHERE f.submission_id = $1 AND f.visible_from <= now()
       ON CONFLICT (feedback_id, user_id, version_seen) DO NOTHING
       RETURNING id`,
      [req.params.id, req.user.id]
    );

    return sendJson(req, res, { recorded: result.rowCount });
  })
);

const feedbackSchema = z.object({
  body: z.string().min(5).max(10_000),
  rubric: z.record(z.string().max(60), z.union([z.number(), z.string().max(500)])).default({}),
  score: z.number().min(0).max(1000).optional(),
  visibleFrom: z.string().datetime().optional()
});

/**
 * POST /api/assessments/submissions/:id/feedback
 * REQ-FUN-008 Facilitator returns feedback.
 *
 * Posting again for the same reviewer UPDATES rather than inserting,
 * which fires the version-bump trigger. That is what makes revised
 * feedback reach every member: there is exactly one row per reviewer,
 * so every reader's next request sees the new version immediately.
 *
 * DEFECT FOUND 2026-09-27, see migration 010 and docs/test-log.md.
 *
 * This used to read first and then branch:
 *
 *     SELECT id FROM feedback WHERE submission_id = $1 AND reviewer_id = $2
 *     if (found) UPDATE else INSERT
 *
 * Under READ COMMITTED two requests from the same reviewer can both see
 * no row and both insert, and there was no unique constraint to reject
 * the second. The result is two pieces of feedback where the code, the
 * version column, the read receipt and the ETag all assume one. The
 * participant then reads the older row, which never changes, while
 * revisions land in the newer one: section 5 of the brief exactly.
 *
 * A transaction does not help, because the two inserts do not conflict
 * with each other until something says they must. ADR-023 adds the
 * constraint that says so, and this becomes one atomic statement.
 */
router.post(
  '/submissions/:id/feedback',
  authenticate,
  requireRole('facilitator', 'mentor', 'admin', 'super_admin'),
  can('submission:grade', { param: 'id' }),
  validate({ body: feedbackSchema }),
  wrap(async (req, res) => {
    const { body, rubric, score, visibleFrom } = req.body;

    const saved = await withTransaction(async (client) => {
      // One statement, so there is no window between deciding and
      // writing. ON CONFLICT resolves against feedback_one_per_reviewer
      // (ADR-023), and the UPDATE branch fires bump_feedback_version
      // exactly as the explicit UPDATE used to.
      //
      // visible_from is only moved when the caller sends one, so
      // revising feedback cannot accidentally hide it again.
      const upserted = await client.query(
        `INSERT INTO feedback (submission_id, reviewer_id, body, rubric, visible_from)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
         ON CONFLICT (submission_id, reviewer_id) DO UPDATE
           SET body         = EXCLUDED.body,
               rubric       = EXCLUDED.rubric,
               visible_from = COALESCE($5::timestamptz, feedback.visible_from)
      RETURNING id, version, updated_at`,
        [req.params.id, req.user.id, body, JSON.stringify(rubric), visibleFrom ?? null]
      );
      const row = upserted.rows[0];

      if (score !== undefined) {
        await client.query(
          `UPDATE submissions SET score = $2, status = 'graded', graded_at = now() WHERE id = $1`,
          [req.params.id, score]
        );
      } else {
        await client.query(
          `UPDATE submissions SET status = 'returned' WHERE id = $1 AND status = 'submitted'`,
          [req.params.id]
        );
      }

      // Notify the submission author so a revision is pushed rather
      // than waiting to be discovered.
      await client.query(
        `INSERT INTO notifications (user_id, kind, payload)
         SELECT s.user_id, 'feedback_available',
                jsonb_build_object('submissionId', s.id, 'feedbackId', $2::uuid, 'version', $3::int)
           FROM submissions s WHERE s.id = $1`,
        [req.params.id, row.id, row.version]
      );

      return row;
    });

    return sendJson(req, res, { feedback: saved }, { status: 201 });
  })
);

export default router;
