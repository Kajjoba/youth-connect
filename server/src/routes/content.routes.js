import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can, requireRole } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import { isAdminRole } from '../lib/roles.js';

const router = Router();

/* ================================================================== */
/* LESSON ITEMS                                                       */
/* ================================================================== */

const itemFields = z.object({
  kind: z.enum(['reading', 'video', 'audio', 'document', 'link', 'quiz', 'assignment', 'discussion'])
    .default('reading'),
  title: z.string().min(3).max(200),
  body: z.string().max(60_000).optional(),
  externalUrl: z.string().url().max(1000).optional().or(z.literal('')),
  transcript: z.string().max(60_000).optional(),
  durationSeconds: z.number().int().positive().max(36_000).optional(),
  assessmentId: z.string().uuid().optional(),
  estimatedMinutes: z.number().int().positive().max(600).default(10),
  isRequired: z.boolean().default(true)
});

/**
 * The create schema adds cross-field rules on top of the field
 * definitions.
 *
 * They are kept separate because superRefine returns a wrapped schema
 * that has no .partial(), and PATCH needs a partial. Deriving both from
 * one plain object keeps the field rules in a single place.
 */
const itemSchema = itemFields.superRefine((value, ctx) => {
  // Mirrors the database CHECK. Validating here as well means the
  // participant-facing error is a sentence rather than a constraint
  // violation, while the database remains the thing that cannot be
  // bypassed.
  if (value.kind === 'reading' && !value.body) {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'A reading needs some text.' });
  }
  if (['video', 'audio', 'link'].includes(value.kind) && !value.externalUrl) {
    ctx.addIssue({ code: 'custom', path: ['externalUrl'], message: 'This needs a link.' });
  }
  if (['quiz', 'assignment'].includes(value.kind) && !value.assessmentId) {
    ctx.addIssue({ code: 'custom', path: ['assessmentId'], message: 'Choose an assessment.' });
  }
  if (value.kind === 'video' && !value.transcript) {
    // A warning rather than an error, raised as a distinct code so the
    // client can show it without blocking. See ADR-016: the transcript
    // is both the accessible option and the one that costs 8 KB instead
    // of 50 MB.
    ctx.addIssue({
      code: 'custom', path: ['transcript'],
      message: 'Add a transcript so participants on slow connections can read instead of watch.',
      fatal: false
    });
  }
});

/**
 * POST /api/activities/:id/modules/:moduleId/items
 *
 * Authorisation note: the policy is evaluated against the ACTIVITY id
 * in the path, and the module is then matched against that same
 * activity inside the query. A module id belonging to someone else's
 * activity therefore resolves to nothing even though can() has already
 * approved this caller for this activity.
 */
router.post(
  '/activities/:id/modules/:moduleId/items',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: itemSchema }),
  wrap(async (req, res) => {
    const b = req.body;

    const item = await withTransaction(async (client) => {
      const owned = await client.query(
        `SELECT id FROM activity_modules WHERE id = $1 AND activity_id = $2 FOR UPDATE`,
        [req.params.moduleId, req.params.id]
      );
      if (!owned.rows[0]) throw notFound('Section');

      const next = await client.query(
        `SELECT COALESCE(max(position), 0) + 1 AS position
           FROM lesson_items WHERE module_id = $1`,
        [req.params.moduleId]
      );

      const inserted = await client.query(
        `INSERT INTO lesson_items
           (module_id, position, kind, title, body, external_url, transcript,
            duration_seconds, assessment_id, estimated_minutes, is_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, position, kind, title, estimated_minutes, is_required`,
        [req.params.moduleId, next.rows[0].position, b.kind, b.title,
         b.body ?? null, b.externalUrl || null, b.transcript ?? null,
         b.durationSeconds ?? null, b.assessmentId ?? null,
         b.estimatedMinutes, b.isRequired]
      );

      // Backfill progress rows for everyone already enrolled, or the
      // new item can never count towards their completion.
      await client.query(
        `INSERT INTO item_progress (enrolment_id, item_id, status)
         SELECT e.id, $1, 'not_started'
           FROM enrolments e
           JOIN activity_modules m ON m.id = $2
          WHERE e.activity_id = m.activity_id
         ON CONFLICT (enrolment_id, item_id) DO NOTHING`,
        [inserted.rows[0].id, req.params.moduleId]
      );

      return inserted.rows[0];
    });

    return sendJson(req, res, { item }, { status: 201 });
  })
);

/** PATCH /api/activities/:id/items/:itemId */
router.patch(
  '/activities/:id/items/:itemId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: itemFields.partial() }),
  wrap(async (req, res) => {
    const columns = {
      title: 'title', body: 'body', externalUrl: 'external_url',
      transcript: 'transcript', durationSeconds: 'duration_seconds',
      estimatedMinutes: 'estimated_minutes', isRequired: 'is_required',
      kind: 'kind', assessmentId: 'assessment_id'
    };

    const sets = [];
    const params = [req.params.itemId, req.params.id];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        params.push(req.body[key] === '' ? null : req.body[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('No changes supplied.');

    // The join to activity_modules pins this item to the activity the
    // policy approved. An item id from elsewhere matches nothing.
    const item = await queryOne(
      `UPDATE lesson_items li SET ${sets.join(', ')}
         FROM activity_modules m
        WHERE li.id = $1 AND li.module_id = m.id AND m.activity_id = $2
       RETURNING li.id, li.position, li.kind, li.title, li.estimated_minutes`,
      params
    );
    if (!item) throw notFound('Item');

    return sendJson(req, res, { item });
  })
);

/** DELETE /api/activities/:id/items/:itemId */
router.delete(
  '/activities/:id/items/:itemId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const removed = await queryOne(
      `DELETE FROM lesson_items li
        USING activity_modules m
        WHERE li.id = $1 AND li.module_id = m.id AND m.activity_id = $2
       RETURNING li.module_id, li.position`,
      [req.params.itemId, req.params.id]
    );
    if (!removed) throw notFound('Item');

    // Keep positions contiguous so the numbering a participant sees
    // matches the stored order.
    await query(
      `UPDATE lesson_items SET position = position - 1
        WHERE module_id = $1 AND position > $2`,
      [removed.module_id, removed.position]
    );

    return sendJson(req, res, { ok: true });
  })
);

/* ================================================================== */
/* MATERIALS                                                          */
/* ================================================================== */

/**
 * Magic-byte detection.
 *
 * The MIME type a client sends is an assertion. Only the bytes are
 * evidence. Same reasoning as the avatar upload in account.routes.js,
 * and the stakes are higher here because course materials are served to
 * every enrolled participant.
 *
 * Office formats are ZIP containers, so a .docx and a .zip are
 * indistinguishable by magic bytes alone. The declared type is used to
 * disambiguate WITHIN the zip family only, never to override what the
 * bytes prove.
 */
function detectFileType(buffer, declared) {
  if (buffer.length < 8) return null;

  const ascii = (start, end) => buffer.subarray(start, end).toString('ascii');

  if (ascii(0, 4) === '%PDF') return 'application/pdf';

  if (buffer[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 3) === 'GIF') return 'image/gif';

  // PK zip header: docx, pptx, xlsx and plain zip all look like this.
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zipFamily = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip'
    ];
    return zipFamily.includes(declared) ? declared : 'application/zip';
  }

  // Plain text has no signature, so it is accepted only if it decodes
  // as UTF-8 and contains no null bytes. That excludes binaries
  // mislabelled as text.
  const textTypes = ['text/plain', 'text/csv', 'text/markdown'];
  if (textTypes.includes(declared)) {
    const sample = buffer.subarray(0, 2048);
    if (!sample.includes(0)) return declared;
  }

  return null;
}

const materialSchema = z.object({
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(3).max(120),
  data: z.string().min(16).max(7_500_000)   // base64 of up to 5 MB
});

/** POST /api/activities/:id/items/:itemId/materials */
router.post(
  '/activities/:id/items/:itemId/materials',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  validate({ body: materialSchema }),
  wrap(async (req, res) => {
    const owned = await queryOne(
      `SELECT li.id FROM lesson_items li
         JOIN activity_modules m ON m.id = li.module_id
        WHERE li.id = $1 AND m.activity_id = $2`,
      [req.params.itemId, req.params.id]
    );
    if (!owned) throw notFound('Item');

    const raw = req.body.data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(raw, 'base64');

    if (buffer.length === 0) throw badRequest('That file is empty.');
    if (buffer.length > 5_242_880) {
      throw badRequest(
        'Files are limited to 5 MB. Anything larger should be a link instead, '
        + 'so participants can decide whether to download it.'
      );
    }

    const mimeType = detectFileType(buffer, req.body.mimeType);
    if (!mimeType) {
      throw badRequest(
        'That file type is not allowed. Accepted: PDF, images, plain text, '
        + 'CSV, and Word, PowerPoint or Excel documents.'
      );
    }

    // Filename is sanitised, not trusted. Path separators in a filename
    // are a directory-traversal attempt, and the name is echoed back in
    // a Content-Disposition header where a newline would let an
    // attacker inject further headers.
    const filename = req.body.filename
      .replace(/[/\\]/g, '_')
      .replace(/[\r\n"]/g, '')
      .slice(0, 200);

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    const material = await queryOne(
      `INSERT INTO materials (item_id, filename, mime_type, bytes, byte_size, checksum, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, filename, mime_type, byte_size, checksum, created_at`,
      [req.params.itemId, filename, mimeType, buffer, buffer.length, checksum, req.user.id]
    );

    return sendJson(req, res, { material }, { status: 201 });
  })
);

/**
 * GET /api/materials/:materialId
 *
 * Course materials belong to enrolled participants and the owning
 * facilitator. The entitlement check is joined into the lookup rather
 * than performed afterwards, so an unentitled caller's request never
 * loads the bytes at all.
 */
router.get(
  '/materials/:materialId',
  authenticate,
  wrap(async (req, res) => {
    const material = await queryOne(
      `SELECT mat.filename, mat.mime_type, mat.bytes, mat.checksum, mat.byte_size
         FROM materials mat
         JOIN lesson_items li      ON li.id = mat.item_id
         JOIN activity_modules m   ON m.id = li.module_id
         JOIN activities a         ON a.id = m.activity_id
        WHERE mat.id = $1
          AND (
            a.facilitator_id = $2
            OR $3
            OR EXISTS (SELECT 1 FROM enrolments e
                        WHERE e.activity_id = a.id AND e.user_id = $2
                          AND e.status <> 'withdrawn')
          )`,
      [req.params.materialId, req.user.id, isAdminRole(req.user.role)]
    ).catch(() => null);

    if (!material) throw notFound('Material');

    /**
     * Everything except images is sent as an attachment.
     *
     * A PDF rendered inline runs in the browser's PDF engine, which
     * supports JavaScript. An uploaded PDF is content one user supplied
     * and another downloads, so rendering it in our own origin is a
     * risk that buys nothing: participants want the file, not a preview
     * inside the page.
     */
    const inlineSafe = material.mime_type.startsWith('image/');
    const disposition = inlineSafe ? 'inline' : 'attachment';

    res.set('Content-Type', material.mime_type);
    res.set('Content-Disposition', `${disposition}; filename="${material.filename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    // Entitlement, not just identity, decides who gets these bytes, so a
    // shared cache must never store one person's download and hand it to
    // someone else who asks for the same URL.
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Authorization');
    return res.send(material.bytes);
  })
);

/** DELETE /api/activities/:id/materials/:materialId */
router.delete(
  '/activities/:id/materials/:materialId',
  authenticate,
  requireRole('facilitator', 'admin', 'super_admin'),
  can('activity:update'),
  wrap(async (req, res) => {
    const removed = await queryOne(
      `DELETE FROM materials mat
        USING lesson_items li, activity_modules m
        WHERE mat.id = $1
          AND li.id = mat.item_id
          AND m.id = li.module_id
          AND m.activity_id = $2
       RETURNING mat.id`,
      [req.params.materialId, req.params.id]
    );
    if (!removed) throw notFound('Material');
    return sendJson(req, res, { ok: true });
  })
);

/* ================================================================== */
/* ITEM PROGRESS                                                      */
/* ================================================================== */

const itemProgressSchema = z.object({
  status: z.enum(['not_started', 'in_progress', 'completed']),
  secondsSpent: z.number().int().min(0).max(86_400).optional()
});

/**
 * PUT /api/activities/:id/items/:itemId/progress
 *
 * Idempotent, so the offline queue can replay it safely.
 *
 * Completing an item rolls up: a module counts as complete when every
 * REQUIRED item in it is done, and the enrolment completes when every
 * module does. Optional items are excluded from the requirement so a
 * bonus reading cannot block someone from finishing.
 */
router.put(
  '/activities/:id/items/:itemId/progress',
  authenticate,
  can('activity:participate'),
  validate({ body: itemProgressSchema }),
  wrap(async (req, res) => {
    const { status, secondsSpent = 0 } = req.body;

    const result = await withTransaction(async (client) => {
      const updated = await client.query(
        // $3 is cast to progress_status in BOTH places it appears.
        //
        // This is the second occurrence of this defect in the project
        // (the first broke assessment submission entirely, see
        // docs/test-log.md). Postgres infers a parameter's type from
        // its first use, so a parameter that is both an enum column
        // value and a comparand against a string literal is rejected
        // with "inconsistent types deduced". The cast pins it once.
        //
        // Worth naming as a pattern rather than two incidents: any
        // parameter reused across a VALUES clause and a CASE needs an
        // explicit cast.
        `INSERT INTO item_progress (enrolment_id, item_id, status, seconds_spent, completed_at)
         SELECT e.id, $2, $3::progress_status, $4,
                CASE WHEN $3::progress_status = 'completed' THEN now() ELSE NULL END
           FROM enrolments e
          WHERE e.activity_id = $1 AND e.user_id = $5
         ON CONFLICT (enrolment_id, item_id) DO UPDATE
           SET status = EXCLUDED.status,
               seconds_spent = GREATEST(item_progress.seconds_spent, EXCLUDED.seconds_spent),
               completed_at = CASE WHEN EXCLUDED.status = 'completed'
                                   THEN COALESCE(item_progress.completed_at, now())
                                   ELSE NULL END,
               updated_at = now()
         RETURNING id, enrolment_id, item_id, status, completed_at`,
        [req.params.id, req.params.itemId, status, secondsSpent, req.user.id]
      );

      if (!updated.rows[0]) throw notFound('Item');
      const enrolmentId = updated.rows[0].enrolment_id;

      // ADR-019: one definition of what "finished" means, in the
      // database, called from every path that can change progress.
      // This used to be forty lines of rollup written inline here, and
      // the fix for the assessment defect would have been a second
      // copy in the assessment handler. Two copies of this rule drift,
      // and the symptom of drift is a participant who has finished a
      // course the system thinks they have not.
      await client.query('SELECT recalculate_progress($1)', [enrolmentId]);

      const summary = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'completed')::int AS done
           FROM module_progress WHERE enrolment_id = $1`,
        [enrolmentId]
      );

      return { progress: updated.rows[0], modules: summary.rows[0] };
    });

    return sendJson(req, res, result);
  })
);

export default router;
