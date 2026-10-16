import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson, readPagination, paginate } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

/* ------------------------------------------------------------------ */
/* PROFILE                                                             */
/* ------------------------------------------------------------------ */

const profileSchema = z.object({
  fullName: z.string().min(2).max(120).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  phone: z.string().max(30).optional(),
  bio: z.string().max(2000).optional(),
  headline: z.string().max(140).optional(),
  // Discipline slugs, checked against the controlled vocabulary below.
  // Free text here would make Level Two team matching impossible: see
  // the note in migration 002.
  disciplines: z.array(z.string().max(60)).max(8).optional(),
  skills: z.array(z.string().max(60)).max(20).optional(),
  languages: z.array(z.string().max(40)).max(10).optional(),
  educationLevel: z.string().max(80).optional(),
  employmentStatus: z.string().max(80).optional(),
  digitalLiteracy: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  lowBandwidthMode: z.boolean().optional(),
  avatarUrl: z.string().url().max(500).optional()
});
// Note what is absent: role, status, email. A participant cannot promote
// themselves by adding a field to the request body, because the schema
// strips anything it does not name. See validate.js.

router.get(
  '/profiles/:id',
  authenticate,
  can('profile:read'),
  wrap(async (req, res) => {
    const profile = await queryOne(
      `SELECT p.user_id, p.full_name, p.country, p.headline, p.bio, p.phone,
              p.disciplines, p.skills, p.languages, p.education_level,
              p.employment_status, p.digital_literacy, p.low_bandwidth_mode,
              p.avatar_url, p.completeness, p.created_at,
              u.role
         FROM profiles p JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1`,
      [req.params.id]
    );
    if (!profile) throw notFound('Profile');

    // Contact details are visible to the owner and to staff only. Other
    // participants see the professional profile without the phone
    // number, which is the minimum-disclosure principle applied at the
    // field level rather than the record level.
    if (!req.resourceRelation.isOwner && req.user.role !== 'facilitator' && !isAdminRole(req.user.role)) {
      delete profile.phone;
    }

    return sendJson(req, res, { profile });
  })
);

router.patch(
  '/profiles/:id',
  authenticate,
  can('profile:update'),
  validate({ body: profileSchema }),
  wrap(async (req, res) => {
    const columns = {
      fullName: 'full_name', country: 'country', phone: 'phone', bio: 'bio',
      headline: 'headline', disciplines: 'disciplines', skills: 'skills',
      languages: 'languages', educationLevel: 'education_level',
      employmentStatus: 'employment_status', digitalLiteracy: 'digital_literacy',
      lowBandwidthMode: 'low_bandwidth_mode', avatarUrl: 'avatar_url'
    };

    // Reject any discipline that is not in the vocabulary. Validating
    // against the table rather than a hardcoded list means adding a
    // discipline is a data change, not a deploy.
    if (req.body.disciplines?.length) {
      const known = await query(
        `SELECT slug FROM disciplines WHERE slug = ANY($1)`,
        [req.body.disciplines]
      );
      const valid = new Set(known.rows.map((row) => row.slug));
      const unknown = req.body.disciplines.filter((slug) => !valid.has(slug));
      if (unknown.length) {
        throw badRequest(`Unknown discipline: ${unknown.join(', ')}`);
      }
    }

    const sets = [];
    const params = [req.params.id];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('No changes supplied.');

    const profile = await queryOne(
      `UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1
       RETURNING user_id, full_name, country, headline, bio, disciplines, skills,
                 languages, digital_literacy, low_bandwidth_mode, avatar_url, updated_at`,
      params
    );

    // Completeness drives the profile nudge in the UI, computed server
    // side so the rule lives in one place.
    const filled = [
      profile.headline, profile.bio, profile.country,
      profile.disciplines?.length, profile.skills?.length, profile.languages?.length,
      profile.avatar_url
    ].filter(Boolean).length;
    const completeness = Math.round((filled / 7) * 100);

    await query('UPDATE profiles SET completeness = $2 WHERE user_id = $1',
      [req.params.id, completeness]);

    return sendJson(req, res, { profile: { ...profile, completeness } });
  })
);

/* ------------------------------------------------------------------ */
/* PROGRESS DASHBOARD                                                  */
/* REQ-FUN-009 Monitor progress.                                       */
/* ------------------------------------------------------------------ */

/**
 * GET /api/me/progress
 *
 * One query, aggregated in the database. The naive version of this
 * endpoint fetches enrolments, then loops issuing a progress query per
 * enrolment, which is the N+1 problem: 20 enrolments become 21 round
 * trips. On a pooled serverless database that is the difference between
 * 40ms and 800ms, and it is a fair question at a defence.
 */
router.get(
  '/me/progress',
  authenticate,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT e.id            AS enrolment_id,
              e.status        AS enrolment_status,
              e.enrolled_at,
              e.completed_at,
              a.id            AS activity_id,
              a.title,
              a.type,
              a.estimated_minutes,
              COUNT(mp.id)::int                                             AS modules_total,
              COUNT(mp.id) FILTER (WHERE mp.status = 'completed')::int      AS modules_done,
              COALESCE(SUM(mp.seconds_spent), 0)::int                       AS seconds_spent,
              (SELECT COUNT(*)::int FROM submissions s
                 JOIN assessments asm ON asm.id = s.assessment_id
                WHERE asm.activity_id = a.id AND s.user_id = $1
                  AND s.status <> 'draft')                                  AS submissions_made,
              (SELECT COUNT(*)::int FROM feedback f
                 JOIN submissions s   ON s.id = f.submission_id
                 JOIN assessments asm ON asm.id = s.assessment_id
                 LEFT JOIN feedback_receipts r
                        ON r.feedback_id = f.id AND r.user_id = $1 AND r.version_seen = f.version
                WHERE asm.activity_id = a.id AND s.user_id = $1
                  AND f.visible_from <= now() AND r.id IS NULL)             AS unread_feedback
         FROM enrolments e
         JOIN activities a       ON a.id = e.activity_id
         LEFT JOIN module_progress mp ON mp.enrolment_id = e.id
        WHERE e.user_id = $1 AND e.status <> 'withdrawn'
        GROUP BY e.id, a.id
        ORDER BY e.enrolled_at DESC`,
      [req.user.id]
    );

    const enrolments = rows.rows.map((row) => ({
      ...row,
      percent: row.modules_total
        ? Math.round((row.modules_done / row.modules_total) * 100)
        : 0
    }));

    const summary = {
      enrolled: enrolments.length,
      completed: enrolments.filter((e) => e.enrolment_status === 'completed').length,
      inProgress: enrolments.filter((e) => e.enrolment_status === 'in_progress').length,
      minutesSpent: Math.round(enrolments.reduce((total, e) => total + e.seconds_spent, 0) / 60),
      unreadFeedback: enrolments.reduce((total, e) => total + e.unread_feedback, 0)
    };

    return sendJson(req, res, { summary, enrolments }, { private: true });
  })
);

/* ------------------------------------------------------------------ */
/* DISCUSSION                                                          */
/* ------------------------------------------------------------------ */

router.get(
  '/activities/:id/threads',
  authenticate,
  can('activity:participate'),
  wrap(async (req, res) => {
    const { limit, cursor } = readPagination(req);
    const params = [req.params.id];

    let keyset = '';
    if (cursor?.lastPostAt && cursor?.id) {
      params.push(cursor.lastPostAt, cursor.id);
      keyset = `AND (t.last_post_at, t.id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(limit + 1);

    const rows = await query(
      `SELECT t.id, t.title, t.reply_count, t.is_locked, t.created_at, t.last_post_at,
              p.full_name AS author_name
         FROM discussion_threads t
         LEFT JOIN profiles p ON p.user_id = t.author_id
        WHERE t.activity_id = $1 ${keyset}
        ORDER BY t.last_post_at DESC, t.id DESC
        LIMIT $${params.length}`,
      params
    );

    return sendJson(req, res,
      paginate(rows.rows, limit, (row) => ({ lastPostAt: row.last_post_at, id: row.id })),
      { private: true }
    );
  })
);

const threadSchema = z.object({
  title: z.string().min(4).max(200),
  body: z.string().min(1).max(10_000)
});

router.post(
  '/activities/:id/threads',
  authenticate,
  can('activity:participate'),
  validate({ body: threadSchema }),
  wrap(async (req, res) => {
    const thread = await queryOne(
      `INSERT INTO discussion_threads (activity_id, author_id, title, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, created_at`,
      [req.params.id, req.user.id, req.body.title, req.body.body]
    );
    return sendJson(req, res, { thread }, { status: 201 });
  })
);

const postSchema = z.object({
  body: z.string().min(1).max(10_000),
  parentPostId: z.string().uuid().optional()
});

router.post(
  '/threads/:threadId/posts',
  authenticate,
  validate({ body: postSchema }),
  wrap(async (req, res) => {
    // Enrolment is verified by joining through to the activity, so a
    // thread id guessed from another activity resolves to nothing.
    const thread = await queryOne(
      `SELECT t.id, t.is_locked
         FROM discussion_threads t
         JOIN enrolments e ON e.activity_id = t.activity_id AND e.user_id = $2
        WHERE t.id = $1`,
      [req.params.threadId, req.user.id]
    );
    if (!thread) throw notFound('Thread');
    if (thread.is_locked) throw badRequest('This thread is closed.');

    const post = await queryOne(
      `INSERT INTO discussion_posts (thread_id, parent_post_id, author_id, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, body, created_at`,
      [req.params.threadId, req.body.parentPostId ?? null, req.user.id, req.body.body]
    );

    return sendJson(req, res, { post }, { status: 201 });
  })
);

/* ------------------------------------------------------------------ */
/* LESSON COMMENTS (ADR-027)                                           */
/*                                                                     */
/* A comment thread scoped to one lesson item rather than the whole    */
/* activity, surfaced inline under that item in the course player      */
/* instead of in the activity-wide Discussion tab. Built on the same   */
/* discussion_threads/discussion_posts tables (see migration 011):     */
/* the thread is created lazily on the first comment, so an item with  */
/* no comments yet has no row to list, rather than an empty thread     */
/* created the moment someone merely looks at it.                      */
/* ------------------------------------------------------------------ */

/**
 * Shared entitlement check for a lesson item: enrolled participant,
 * the facilitator who owns the activity, or an admin. The same shape
 * as the materials-download check in content.routes.js, so a item id
 * guessed from a course someone cannot see resolves to nothing.
 */
async function resolveItemAccess(itemId, user) {
  return queryOne(
    `SELECT a.id AS activity_id
       FROM lesson_items li
       JOIN activity_modules m ON m.id = li.module_id
       JOIN activities a       ON a.id = m.activity_id
      WHERE li.id = $1
        AND (
          a.facilitator_id = $2
          OR $3
          OR EXISTS (SELECT 1 FROM enrolments e
                      WHERE e.activity_id = a.id AND e.user_id = $2
                        AND e.status <> 'withdrawn')
        )`,
    [itemId, user.id, isAdminRole(user.role)]
  );
}

router.get(
  '/items/:itemId/comments',
  authenticate,
  wrap(async (req, res) => {
    const access = await resolveItemAccess(req.params.itemId, req.user);
    if (!access) throw notFound('Lesson item');

    const rows = await query(
      `SELECT p.id, p.body, p.created_at, p.author_id,
              pr.full_name AS author_name
         FROM discussion_threads t
         JOIN discussion_posts p ON p.thread_id = t.id
         LEFT JOIN profiles pr   ON pr.user_id = p.author_id
        WHERE t.lesson_item_id = $1
        ORDER BY p.created_at ASC
        LIMIT 200`,
      [req.params.itemId]
    );

    return sendJson(req, res, { comments: rows.rows }, { private: true });
  })
);

const commentSchema = z.object({
  body: z.string().min(1).max(4000)
});

router.post(
  '/items/:itemId/comments',
  authenticate,
  validate({ body: commentSchema }),
  wrap(async (req, res) => {
    const access = await resolveItemAccess(req.params.itemId, req.user);
    if (!access) throw notFound('Lesson item');

    // Find-or-create the thread for this item in one statement, relying
    // on idx_threads_one_per_item (migration 011) to make a concurrent
    // double-insert fail rather than silently succeed twice: exactly the
    // ADR-023 shape, applied to a second table.
    const created = await queryOne(
      `INSERT INTO discussion_threads (activity_id, lesson_item_id, author_id, title, body)
       VALUES ($1, $2, $3, 'Comments', '')
       ON CONFLICT (lesson_item_id) WHERE lesson_item_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [access.activity_id, req.params.itemId, req.user.id]
    );

    const threadId = created?.id ?? (await queryOne(
      `SELECT id FROM discussion_threads WHERE lesson_item_id = $1`,
      [req.params.itemId]
    )).id;

    const comment = await queryOne(
      `INSERT INTO discussion_posts (thread_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [threadId, req.user.id, req.body.body]
    );

    return sendJson(req, res, { comment }, { status: 201 });
  })
);

/* ------------------------------------------------------------------ */
/* NOTIFICATIONS                                                       */
/* ------------------------------------------------------------------ */

router.get(
  '/me/notifications',
  authenticate,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT id, kind, payload, read_at, created_at
         FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [req.user.id]
    );
    return sendJson(req, res, {
      notifications: rows.rows,
      unread: rows.rows.filter((row) => !row.read_at).length
    }, { private: true });
  })
);

router.post(
  '/me/notifications/read',
  authenticate,
  wrap(async (req, res) => {
    await query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    return sendJson(req, res, { ok: true });
  })
);

export default router;
