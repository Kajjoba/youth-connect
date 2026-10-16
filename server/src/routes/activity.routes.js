import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate, authenticateOptional } from '../middleware/authenticate.js';
import { can, requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson, readPagination, paginate, selectFields } from '../lib/http.js';
import { conflict, badRequest, notFound } from '../lib/errors.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

const LIST_FIELDS = [
  'id', 'slug', 'title', 'summary', 'type', 'tags',
  'estimated_minutes', 'payload_kb', 'opens_at', 'enrolled_count', 'is_enrolled'
];

const discoverySchema = z.object({
  q: z.string().max(80).optional(),
  type: z.enum(['course', 'workshop', 'discussion', 'challenge']).optional(),
  tag: z.string().max(40).optional(),
  maxMinutes: z.coerce.number().int().positive().max(1000).optional(),
  // REQ-NFR-005: a participant on a metered connection can filter out
  // heavy activities before opening them.
  maxKb: z.coerce.number().int().positive().max(100000).optional(),
  fields: z.string().max(200).optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional()
});

/**
 * GET /api/activities
 * REQ-FUN-003 Discover activities.
 *
 * Keyset pagination on (opens_at, id). Filters are applied in SQL so the
 * database returns only what is needed. Nothing is filtered in
 * JavaScript after fetching, because fetching 4,000 rows to display 20
 * is the single most common cause of a slow list endpoint.
 */
router.get(
  '/',
  authenticateOptional,
  validate({ query: discoverySchema }),
  wrap(async (req, res) => {
    const filters = req.validatedQuery ?? {};
    const { limit, cursor } = readPagination({ query: filters });

    const params = [req.user?.id ?? null];
    const where = [`a.status = 'published'`, `(a.opens_at IS NULL OR a.opens_at <= now())`];

    if (filters.q) {
      params.push(`%${filters.q}%`);
      where.push(`(a.title ILIKE $${params.length} OR a.summary ILIKE $${params.length})`);
    }
    if (filters.type) {
      params.push(filters.type);
      where.push(`a.type = $${params.length}`);
    }
    if (filters.tag) {
      params.push(filters.tag);
      where.push(`$${params.length} = ANY(a.tags)`);
    }
    if (filters.maxMinutes) {
      params.push(filters.maxMinutes);
      where.push(`a.estimated_minutes <= $${params.length}`);
    }
    if (filters.maxKb) {
      params.push(filters.maxKb);
      where.push(`a.payload_kb <= $${params.length}`);
    }
    if (cursor?.opensAt && cursor?.id) {
      params.push(cursor.opensAt, cursor.id);
      where.push(`(a.opens_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }

    params.push(limit + 1);

    const result = await query(
      `SELECT a.id, a.slug, a.title, a.summary, a.type, a.tags,
              a.estimated_minutes, a.payload_kb, a.opens_at,
              (SELECT count(*) FROM enrolments e WHERE e.activity_id = a.id) AS enrolled_count,
              EXISTS (SELECT 1 FROM enrolments e
                       WHERE e.activity_id = a.id AND e.user_id = $1) AS is_enrolled
         FROM activities a
        WHERE ${where.join(' AND ')}
        ORDER BY a.opens_at DESC NULLS LAST, a.id DESC
        LIMIT $${params.length}`,
      params
    );

    // Paginate over the RAW rows, then narrow the fields.
    //
    // Doing this in the other order is a bug: selectFields strips
    // opens_at and id when the caller asks for a narrow projection, so
    // the cursor is built from an empty object and paging stops working
    // for exactly the low-bandwidth clients that use ?fields=. The
    // cursor must be derived from the row before it is narrowed.
    const page = paginate(result.rows, limit, (row) => ({ opensAt: row.opens_at, id: row.id }));
    page.data = page.data.map((row) => selectFields(row, filters.fields, LIST_FIELDS));

    // Published catalogue data is identical for everyone except the
    // is_enrolled flag, so a short shared cache window is safe only when
    // the caller is anonymous.
    return sendJson(req, res, page, {
      private: Boolean(req.user),
      maxAge: req.user ? 0 : 60
    });
  })
);

/**
 * GET /api/activities/:id
 * Modules are returned only to an enrolled participant or the owning
 * facilitator, so the detail endpoint cannot be used to read course
 * content without enrolling.
 */
router.get(
  '/:id',
  authenticate,
  can('activity:read'),
  wrap(async (req, res) => {
    const activity = await queryOne(
      `SELECT a.id, a.slug, a.title, a.summary, a.description, a.type, a.status,
              a.tags, a.capacity, a.estimated_minutes, a.payload_kb,
              a.opens_at, a.closes_at, a.created_at,
              p.full_name AS facilitator_name,
              (SELECT count(*) FROM enrolments e WHERE e.activity_id = a.id) AS enrolled_count
         FROM activities a
         LEFT JOIN profiles p ON p.user_id = a.facilitator_id
        WHERE a.id = $1`,
      [req.params.id]
    );
    if (!activity) throw notFound('Activity');

    const relation = req.resourceRelation;
    let modules = [];
    let enrolment = null;

    if (relation.isEnrolled || relation.isOwner || isAdminRole(req.user.role)) {
      const moduleRows = await query(
        `SELECT m.id, m.position, m.title, m.estimated_minutes, m.resource_url,
                m.objectives, m.week_offset,
                COALESCE(mp.status, 'not_started') AS progress_status,
                mp.completed_at
           FROM activity_modules m
           LEFT JOIN enrolments e
                  ON e.activity_id = m.activity_id AND e.user_id = $2
           LEFT JOIN module_progress mp
                  ON mp.module_id = m.id AND mp.enrolment_id = e.id
          WHERE m.activity_id = $1
          ORDER BY m.position`,
        [req.params.id, req.user.id]
      );

      // Items and their materials, fetched in ONE query for the whole
      // activity rather than one per module. A module loop here would
      // be the N+1 problem in the most-visited endpoint in the system.
      //
      // Material BYTES are deliberately not selected: this endpoint
      // returns the catalogue of what exists, and each file is fetched
      // on demand from /api/materials/:id. Inlining them would make
      // opening a course page cost every attachment in it.
      const itemRows = await query(
        `SELECT li.id, li.module_id, li.position, li.kind, li.title,
                li.body, li.external_url, li.transcript, li.duration_seconds,
                li.assessment_id, li.estimated_minutes, li.is_required,
                COALESCE(ip.status, 'not_started') AS progress_status,
                COALESCE(
                  (SELECT json_agg(json_build_object(
                     'id', mat.id, 'filename', mat.filename,
                     'mimeType', mat.mime_type, 'byteSize', mat.byte_size
                   ) ORDER BY mat.created_at)
                     FROM materials mat WHERE mat.item_id = li.id),
                  '[]'::json
                ) AS materials
           FROM lesson_items li
           JOIN activity_modules m ON m.id = li.module_id
           LEFT JOIN enrolments e
                  ON e.activity_id = m.activity_id AND e.user_id = $2
           LEFT JOIN item_progress ip
                  ON ip.item_id = li.id AND ip.enrolment_id = e.id
          WHERE m.activity_id = $1
          ORDER BY m.position, li.position`,
        [req.params.id, req.user.id]
      );

      modules = moduleRows.rows.map((module) => ({
        ...module,
        items: itemRows.rows.filter((item) => item.module_id === module.id)
      }));

      enrolment = await queryOne(
        `SELECT id, status, enrolled_at, started_at, completed_at
           FROM enrolments WHERE activity_id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
    }

    return sendJson(req, res, {
      activity,
      modules,
      enrolment,
      // The client renders controls from this, but the server does not
      // trust it. Every write re-checks the policy. This is a rendering
      // hint, never an access control.
      permissions: {
        canEdit: relation.isOwner || isAdminRole(req.user.role),
        canEnrol: !enrolment && relation.isPublished,
        canParticipate: relation.isEnrolled || relation.isOwner
      }
    });
  })
);

/**
 * POST /api/activities/:id/enrolments
 * REQ-FUN-005 Enrol.
 *
 * Capacity is enforced inside the transaction with a row lock, not by
 * reading a count first. Reading then writing is a race: two concurrent
 * requests both see capacity available and both enrol, overfilling the
 * activity. This is exactly the kind of concurrency defect a Master's
 * level review committee will probe.
 */
router.post(
  '/:id/enrolments',
  authenticate,
  can('activity:read'),
  wrap(async (req, res) => {
    const activityId = req.params.id;

    const enrolment = await withTransaction(async (client) => {
      const locked = await client.query(
        `SELECT id, capacity, status, closes_at FROM activities WHERE id = $1 FOR UPDATE`,
        [activityId]
      );
      const activity = locked.rows[0];
      if (!activity) throw notFound('Activity');
      if (activity.status !== 'published') throw badRequest('This activity is not open for enrolment.');
      if (activity.closes_at && new Date(activity.closes_at) < new Date()) {
        throw badRequest('Enrolment for this activity has closed.');
      }

      if (activity.capacity !== null) {
        const counted = await client.query(
          `SELECT count(*)::int AS taken FROM enrolments
            WHERE activity_id = $1 AND status <> 'withdrawn'`,
          [activityId]
        );
        if (counted.rows[0].taken >= activity.capacity) {
          throw conflict('This activity is full.');
        }
      }

      const inserted = await client.query(
        `INSERT INTO enrolments (user_id, activity_id, status)
         VALUES ($1, $2, 'enrolled')
         ON CONFLICT (user_id, activity_id) DO NOTHING
         RETURNING id, status, enrolled_at`,
        [req.user.id, activityId]
      );

      if (!inserted.rows[0]) throw conflict('You are already enrolled in this activity.');

      // Seed progress rows so the participant's progress view is a
      // single query with no outer joins against missing rows.
      await client.query(
        `INSERT INTO module_progress (enrolment_id, module_id, status)
         SELECT $1, m.id, 'not_started'
           FROM activity_modules m
          WHERE m.activity_id = $2`,
        [inserted.rows[0].id, activityId]
      );

      return inserted.rows[0];
    });

    return sendJson(req, res, { enrolment }, { status: 201 });
  })
);

const moduleProgressSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'completed']),
  secondsSpent: z.number().int().min(0).max(86_400).optional()
});

/**
 * PUT /api/activities/:id/modules/:moduleId/progress
 * REQ-FUN-006 Participate.
 *
 * Progress writes are idempotent so the offline client can replay a
 * queued mutation after reconnecting without creating duplicates or
 * double-counting time. Idempotency is what makes offline-first safe.
 */
router.put(
  '/:id/modules/:moduleId/progress',
  authenticate,
  can('activity:participate'),
  validate({ body: moduleProgressSchema }),
  wrap(async (req, res) => {
    const { status, secondsSpent = 0 } = req.body;

    const updated = await queryOne(
      `UPDATE module_progress mp
          SET status = $3::progress_status,
              seconds_spent = GREATEST(mp.seconds_spent, $4),
              -- Cast for the same reason as item progress: a parameter
              -- used as both an enum value and a comparand is rejected.
              completed_at = CASE WHEN $3::progress_status = 'completed'
                                  THEN COALESCE(mp.completed_at, now()) ELSE NULL END,
              updated_at = now()
         FROM enrolments e
        WHERE mp.enrolment_id = e.id
          AND e.user_id = $1
          AND mp.module_id = $2
       RETURNING mp.id, mp.status, mp.completed_at, mp.enrolment_id`,
      [req.user.id, req.params.moduleId, status, secondsSpent]
    );

    if (!updated) throw notFound('Module');

    // ADR-019: the module-progress path uses the same rollup function
    // as the item path and the assessment trigger. Three callers, one
    // definition of what finished means.
    await query('SELECT recalculate_progress($1)', [updated.enrolment_id]);

    const summary = await queryOne(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS done
         FROM module_progress WHERE enrolment_id = $1`,
      [updated.enrolment_id]
    );

    return sendJson(req, res, {
      progress: updated,
      completion: { total: summary.total, completed: summary.done }
    });
  })
);

/**
 * The ONE mapping from request field to database column.
 *
 * DEFECT FOUND 2026-09-27. POST and PATCH each had their own list.
 * PATCH knew about all 21 fields; POST knew about 12 and silently
 * discarded the other 9. So creating a course with outcomes,
 * prerequisites, weeks, level, languages or skills accepted them,
 * validated them, returned 201, and threw them away. No error anywhere.
 * The facilitator had to know to immediately PATCH the thing they had
 * just created.
 *
 * The bug is not the nine missing columns. It is that there were two
 * lists, so every field added afterwards had to be added twice and
 * nothing complained when it was not. Both handlers now build their SQL
 * from this map, which makes drift impossible rather than merely
 * unlikely.
 */
const ACTIVITY_COLUMNS = Object.freeze({
  title: 'title',
  summary: 'summary',
  description: 'description',
  type: 'type',
  status: 'status',
  tags: 'tags',
  capacity: 'capacity',
  estimatedMinutes: 'estimated_minutes',
  opensAt: 'opens_at',
  closesAt: 'closes_at',
  outcomes: 'outcomes',
  prerequisites: 'prerequisites',
  weeks: 'weeks',
  hoursPerWeek: 'hours_per_week',
  level: 'level',
  languages: 'languages',
  skills: 'skills',
  instructorNote: 'instructor_note',
  awardsCertificate: 'awards_certificate',
  certificateTitle: 'certificate_title',
  requiresPass: 'requires_pass'
});

const activitySchema = z.object({
  title: z.string().min(4).max(160),
  summary: z.string().min(10).max(400),
  description: z.string().max(20_000).optional(),
  type: z.enum(['course', 'workshop', 'discussion', 'challenge']).default('course'),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  tags: z.array(z.string().max(40)).max(10).default([]),
  capacity: z.number().int().positive().max(5000).nullable().optional(),
  estimatedMinutes: z.number().int().positive().max(10_000).default(60),
  opensAt: z.string().datetime().optional(),
  closesAt: z.string().datetime().optional(),

  // Landing page fields (migration 005). Everything a person needs to
  // decide whether to commit their time and their data bundle.
  //
  // Outcomes are capped at 8 and 200 characters each on purpose. The
  // failure mode of a "what you'll learn" list is not too little, it is
  // a facilitator pasting a syllabus into it, which nobody reads.
  outcomes: z.array(z.string().min(3).max(200)).max(8).optional(),
  prerequisites: z.array(z.string().min(3).max(200)).max(5).optional(),
  weeks: z.number().int().min(1).max(52).nullable().optional(),
  hoursPerWeek: z.number().min(0.5).max(40).nullable().optional(),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  languages: z.array(z.string().max(40)).max(6).optional(),
  // Skills are not tags. Tags are topical and used for browsing;
  // skills are what a participant can claim afterwards, and what
  // Level Two team matching queries against.
  skills: z.array(z.string().min(2).max(80)).max(12).optional(),
  instructorNote: z.string().max(1000).optional(),
  awardsCertificate: z.boolean().optional(),
  certificateTitle: z.string().max(200).optional(),
  requiresPass: z.boolean().optional()
});

/** POST /api/activities - facilitators and admins only. REQ-FUN-004 */
router.post(
  '/',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  validate({ body: activitySchema }),
  wrap(async (req, res) => {
    const b = req.body;

    // The slug is derived from the title with a base-36 timestamp
    // suffix, so two courses with the same name cannot collide and the
    // facilitator never has to think about URLs.
    const slug = `${b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${Date.now().toString(36)}`;

    // Built from ACTIVITY_COLUMNS, so every field the schema accepts is
    // stored. Fields the caller omitted are left to their column
    // defaults rather than being written as NULL, which matters for the
    // NOT NULL array columns.
    const columns = ['slug', 'facilitator_id'];
    const values = [slug, req.user.id];
    for (const [field, column] of Object.entries(ACTIVITY_COLUMNS)) {
      if (b[field] !== undefined) {
        columns.push(column);
        values.push(b[field]);
      }
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');

    const activity = await queryOne(
      `INSERT INTO activities (${columns.join(', ')})
       VALUES (${placeholders})
       RETURNING id, slug, title, status, created_at`,
      values
    );

    return sendJson(req, res, { activity }, { status: 201 });
  })
);

/** PATCH /api/activities/:id - owner or admin. Policy enforced by can(). */
router.patch(
  '/:id',
  authenticate,
  can('activity:update'),
  validate({ body: activitySchema.partial() }),
  wrap(async (req, res) => {
    const sets = [];
    const params = [req.params.id];
    for (const [key, column] of Object.entries(ACTIVITY_COLUMNS)) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('No changes supplied.');

    const activity = await queryOne(
      `UPDATE activities SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, slug, title, status, updated_at`,
      params
    );

    return sendJson(req, res, { activity });
  })
);

export default router;
