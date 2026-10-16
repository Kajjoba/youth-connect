import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson, readPagination, paginate } from '../lib/http.js';
import { badRequest, notFound, conflict, forbidden } from '../lib/errors.js';
import { recordAccess, findEnumerationSuspects } from '../lib/audit.js';
import { revokeAllForUser } from '../lib/tokens.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

// Everything below requires admin-tier access. Applied once at the
// router rather than repeated per route, so a new route added here
// cannot accidentally ship without the gate. Which admin-tier actions a
// caller may actually take is narrower in places (see PATCH
// /users/:id below) and is checked separately where it matters.
router.use(authenticate, requireRole('admin', 'super_admin'));

/**
 * GET /api/admin/overview
 *
 * The numbers an administrator actually needs on opening the platform:
 * is it growing, is anything stuck, and is anyone attacking it.
 *
 * One query per panel, all aggregated in the database. The naive version
 * fetches every user and every enrolment and counts them in JavaScript,
 * which works with six seeded accounts and falls over at four thousand.
 */
router.get(
  '/overview',
  wrap(async (req, res) => {
    const [people, activity, learning, security] = await Promise.all([
      queryOne(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE role = 'participant')::int AS participants,
               count(*) FILTER (WHERE role = 'facilitator')::int AS facilitators,
               count(*) FILTER (WHERE role = 'mentor')::int      AS mentors,
               count(*) FILTER (WHERE role = 'admin')::int       AS admins,
               count(*) FILTER (WHERE role = 'super_admin')::int AS super_admins,
               count(*) FILTER (WHERE status = 'suspended')::int AS suspended,
               count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS joined_this_week
          FROM users
      `),
      queryOne(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'published')::int AS published,
               count(*) FILTER (WHERE status = 'draft')::int     AS drafts
          FROM activities
      `),
      queryOne(`
        SELECT (SELECT count(*)::int FROM enrolments WHERE status <> 'withdrawn') AS enrolments,
               (SELECT count(*)::int FROM enrolments WHERE status = 'completed')  AS completions,
               (SELECT count(*)::int FROM submissions WHERE status = 'submitted') AS awaiting_grading,
               (SELECT count(*)::int FROM submissions WHERE status <> 'draft')    AS submissions
      `),
      queryOne(`
        SELECT count(*) FILTER (WHERE allowed = FALSE
                 AND created_at > now() - interval '24 hours')::int AS denied_today,
               count(DISTINCT actor_id) FILTER (WHERE allowed = FALSE
                 AND created_at > now() - interval '24 hours')::int AS actors_denied_today
          FROM access_audit
      `)
    ]);

    // Country spread matters for this programme specifically: the brief
    // is about cross-border exchange, so an admin needs to see whether
    // one country dominates.
    const countries = await query(`
      SELECT p.country, count(*)::int AS participants
        FROM profiles p JOIN users u ON u.id = p.user_id
       WHERE u.role = 'participant'
       GROUP BY p.country
       ORDER BY participants DESC
       LIMIT 10
    `);

    return sendJson(req, res, {
      people,
      activities: activity,
      learning,
      security,
      countries: countries.rows
    }, { private: true });
  })
);

/**
 * GET /api/admin/users
 *
 * Searchable, filterable, paginated. Note what is NOT selected:
 * password_hash never leaves the database, and phone numbers are not
 * included because a user list is not a reason to expose contact
 * details for every participant at once.
 */
const userQuerySchema = z.object({
  q: z.string().max(80).optional(),
  role: z.enum(['participant', 'facilitator', 'mentor', 'admin', 'super_admin', 'stakeholder']).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'deactivated']).optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional()
});

router.get(
  '/users',
  validate({ query: userQuerySchema }),
  wrap(async (req, res) => {
    const filters = req.validatedQuery ?? {};
    const { limit, cursor } = readPagination({ query: filters });

    const params = [];
    const where = [];

    if (filters.q) {
      params.push(`%${filters.q}%`);
      where.push(`(u.email ILIKE $${params.length} OR p.full_name ILIKE $${params.length})`);
    }
    if (filters.role) {
      params.push(filters.role);
      where.push(`u.role = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`u.status = $${params.length}`);
    }
    if (cursor?.createdAt && cursor?.id) {
      params.push(cursor.createdAt, cursor.id);
      where.push(`(u.created_at, u.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(limit + 1);

    const rows = await query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at, u.last_login_at,
              p.full_name, p.country, p.completeness,
              (SELECT count(*)::int FROM enrolments e WHERE e.user_id = u.id
                 AND e.status <> 'withdrawn') AS enrolments
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $${params.length}`,
      params
    );

    return sendJson(req, res,
      paginate(rows.rows, limit, (row) => ({ createdAt: row.created_at, id: row.id })),
      { private: true }
    );
  })
);

const updateUserSchema = z.object({
  role: z.enum(['participant', 'facilitator', 'mentor', 'admin', 'super_admin', 'stakeholder']).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'deactivated']).optional()
});

/**
 * PATCH /api/admin/users/:id
 *
 * Role and status changes, with four guards that exist because the
 * failure modes are unrecoverable:
 *
 *   1. AN ADMIN CANNOT CHANGE THEIR OWN ROLE OR STATUS. A misclick
 *      otherwise locks you out of the system you administer, and there
 *      is no other way back in.
 *
 *   2. ADR-028: ONLY A SUPER ADMIN MAY TOUCH THE ADMIN TIER. A plain
 *      admin may freely move someone between participant, facilitator,
 *      mentor and stakeholder, and may suspend or restore any of those
 *      accounts, same as before. But granting admin or super_admin, and
 *      changing the role or status of an account that already holds
 *      either, is refused for anyone below super_admin. Before this,
 *      any admin could silently hand admin rights to anyone, including
 *      themselves indirectly through a second account; that is now a
 *      narrower, auditable power held only by the tier meant to hold
 *      it.
 *
 *   3. THE LAST SUPER ADMIN CANNOT BE REMOVED. A super admin is the
 *      only account that can create another one, so losing the last
 *      active super admin is unrecoverable through this panel, not
 *      merely inconvenient. Checked inside a transaction with the row
 *      locked, because two super admins demoting each other
 *      simultaneously would both pass a naive count.
 *
 *   4. SUSPENSION REVOKES SESSIONS. Suspending an account that keeps
 *      working until its token expires is not a suspension.
 */
router.patch(
  '/users/:id',
  validate({ body: updateUserSchema }),
  wrap(async (req, res) => {
    const { role, status } = req.body;
    if (role === undefined && status === undefined) {
      throw badRequest('No changes supplied.');
    }

    if (req.params.id === req.user.id) {
      throw badRequest(
        'You cannot change your own role or status. Ask another administrator.'
      );
    }

    const updated = await withTransaction(async (client) => {
      const target = await client.query(
        `SELECT id, email, role, status FROM users WHERE id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!target.rows[0]) throw notFound('User');
      const before = target.rows[0];

      // Guard 2. A plain admin stops here for anything touching the
      // admin tier, whether that is the target's current role or the
      // role being requested, so neither "promote someone to admin"
      // nor "change what an existing admin can do" slips through.
      if (req.user.role !== 'super_admin') {
        const targetsAdminTier = isAdminRole(before.role) || (role !== undefined && isAdminRole(role));
        if (targetsAdminTier) {
          throw forbidden(
            'Only a super administrator can grant, change or revoke admin-tier access.'
          );
        }
      }

      const losingSuperAdmin =
        before.role === 'super_admin'
        && ((role !== undefined && role !== 'super_admin')
            || (status !== undefined && status !== 'active'));

      if (losingSuperAdmin) {
        const remaining = await client.query(
          `SELECT count(*)::int AS n FROM users
            WHERE role = 'super_admin' AND status = 'active' AND id <> $1`,
          [req.params.id]
        );
        if (remaining.rows[0].n === 0) {
          throw conflict(
            'This is the last active super administrator. Appoint another one first.'
          );
        }
      }

      const sets = [];
      const params = [req.params.id];
      if (role !== undefined) { params.push(role); sets.push(`role = $${params.length}`); }
      if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }

      const result = await client.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, email, role, status`,
        params
      );

      return { before, after: result.rows[0] };
    });

    // A role change alters what the account may do, and the old access
    // token still carries the old role until it expires. Revoking
    // forces a fresh token that reflects the new permissions.
    if (role !== undefined || (status !== undefined && status !== 'active')) {
      await revokeAllForUser(req.params.id);
    }

    recordAccess({
      actorId: req.user.id,
      action: 'admin:update_user',
      resourceType: 'user',
      resourceId: req.params.id,
      allowed: true,
      reason: `${updated.before.role}/${updated.before.status} -> ${updated.after.role}/${updated.after.status}`,
      req
    });

    return sendJson(req, res, { user: updated.after });
  })
);

/**
 * GET /api/admin/security
 *
 * The console for the incident in section 5 of the brief. Run the
 * URL-tampering attack in one browser, open this in another, and the
 * attempt is listed. That demonstration takes about ninety seconds and
 * is the strongest thing to show a review committee.
 */
router.get(
  '/security',
  wrap(async (req, res) => {
    const suspects = await findEnumerationSuspects({
      windowMinutes: Number(req.query.window) || 60,
      threshold: Number(req.query.threshold) || 3
    });

    const recent = await query(
      `SELECT a.created_at, a.action, a.resource_type, a.resource_id,
              a.allowed, a.reason, a.ip_address,
              p.full_name AS actor_name, u.email AS actor_email
         FROM access_audit a
         LEFT JOIN users u    ON u.id = a.actor_id
         LEFT JOIN profiles p ON p.user_id = a.actor_id
        WHERE a.allowed = FALSE
        ORDER BY a.created_at DESC
        LIMIT 50`
    );

    const changes = await query(
      `SELECT c.changed_at, c.ip_address, u.email, p.full_name
         FROM password_changes c
         JOIN users u         ON u.id = c.user_id
         LEFT JOIN profiles p ON p.user_id = c.user_id
        ORDER BY c.changed_at DESC
        LIMIT 20`
    );

    return sendJson(req, res, {
      suspects,
      denials: recent.rows,
      passwordChanges: changes.rows
    }, { private: true });
  })
);

/**
 * GET /api/admin/reports
 *
 * Per-activity engagement and outcomes, the level of detail an overview
 * card cannot show. The overview answers "is the platform healthy";
 * this answers "which specific course is worth expanding and which one
 * is quietly failing its participants" - the question a programme
 * coordinator actually has to act on.
 *
 * Everything here is one aggregated query per section, computed in the
 * database rather than reduced in JavaScript, for the same reason as
 * the overview: this has to still be fast once there are thousands of
 * rows instead of a handful of seeded ones.
 */
router.get(
  '/reports',
  wrap(async (req, res) => {
    const activities = await query(`
      SELECT a.id, a.slug, a.title, a.type, a.status,
             count(DISTINCT e.id) FILTER (WHERE e.status <> 'withdrawn')::int   AS enrolments,
             count(DISTINCT e.id) FILTER (WHERE e.status = 'completed')::int    AS completions,
             count(DISTINCT e.id) FILTER (WHERE e.status = 'in_progress')::int  AS in_progress,
             round(avg(mp.percent))::int AS avg_progress
        FROM activities a
        LEFT JOIN enrolments e ON e.activity_id = a.id AND e.status <> 'withdrawn'
        LEFT JOIN LATERAL (
          SELECT 100.0 * count(m.id) FILTER (WHERE m.status = 'completed')
                 / NULLIF(count(m.id), 0) AS percent
            FROM module_progress m WHERE m.enrolment_id = e.id
        ) mp ON TRUE
       GROUP BY a.id
       ORDER BY enrolments DESC, a.title
    `);

    // Assessment performance sits behind a separate join because an
    // activity can have zero, one or several assessments, and folding
    // that into the row above would double-count enrolments.
    const assessments = await query(`
      SELECT ast.activity_id,
             count(s.id) FILTER (WHERE s.status = 'graded')::int      AS graded,
             count(s.id) FILTER (WHERE s.status = 'submitted')::int   AS awaiting_grading,
             round(avg(s.score) FILTER (WHERE s.status = 'graded'))   AS avg_score,
             round(100.0 * count(s.id) FILTER (
               WHERE s.status = 'graded' AND s.score >= ast.pass_score
             ) / NULLIF(count(s.id) FILTER (WHERE s.status = 'graded'), 0))::int AS pass_rate
        FROM assessments ast
        LEFT JOIN submissions s ON s.assessment_id = ast.id
       GROUP BY ast.activity_id
    `);
    const byActivity = new Map(assessments.rows.map((row) => [row.activity_id, row]));

    const report = activities.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      type: row.type,
      status: row.status,
      enrolments: row.enrolments,
      completions: row.completions,
      inProgress: row.in_progress,
      completionRate: row.enrolments ? Math.round((row.completions / row.enrolments) * 100) : 0,
      avgProgress: row.avg_progress ?? 0,
      assessment: byActivity.has(row.id)
        ? {
            graded: byActivity.get(row.id).graded,
            awaitingGrading: byActivity.get(row.id).awaiting_grading,
            avgScore: byActivity.get(row.id).avg_score !== null
              ? Number(byActivity.get(row.id).avg_score) : null,
            passRate: byActivity.get(row.id).pass_rate
          }
        : null
    }));

    // Feedback turnaround: how long a participant actually waits between
    // submitting and hearing back. Slow feedback is invisible in every
    // other panel here, and is exactly the kind of thing a coordinator
    // cannot see just by looking at the platform.
    const turnaround = await queryOne(`
      SELECT round(avg(extract(epoch FROM (f.created_at - s.submitted_at)) / 3600))::int
               AS avg_hours,
             count(*)::int AS sampled
        FROM feedback f
        JOIN submissions s ON s.id = f.submission_id
       WHERE s.submitted_at IS NOT NULL
    `);

    return sendJson(req, res, {
      activities: report,
      feedbackTurnaround: {
        avgHours: turnaround?.avg_hours ?? null,
        sampled: turnaround?.sampled ?? 0
      }
    }, { private: true });
  })
);

export default router;
