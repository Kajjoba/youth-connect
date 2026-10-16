import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../db.js';
import { config } from '../config.js';
import { authenticateOptional } from '../middleware/authenticate.js';
import { wrap, sendJson } from '../lib/http.js';
import { notFound } from '../lib/errors.js';

const router = Router();

/**
 * =====================================================================
 * THE PUBLIC COURSE LANDING PAGE
 *
 * The page someone sees before they have an account: what the course
 * teaches, how long it takes, who runs it, and what is inside it.
 *
 * ADR-018 explains why this is public and what it may disclose. The
 * short version: a catalogue you must log in to browse cannot be shared
 * in a WhatsApp group, and that is the main way a youth programme in
 * this region actually reaches people. But public must not mean the
 * course is readable without enrolling, so this returns the SHAPE of
 * the course and never its substance.
 *
 * Every item field here comes from course_preview_items, a database
 * view that does not contain body, transcript or external_url. A future
 * edit to this handler cannot leak a reading, because the column is not
 * there to select. A control, not a rule.
 * =====================================================================
 */

/**
 * Unauthenticated, so it is rate limited. Generous, because this is a
 * page people share: one class of thirty students opening the same link
 * from one campus network must not trip it.
 */
const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PREVIEW_RATE_LIMIT) || (config.env === 'test' ? 2000 : 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

/**
 * GET /api/courses/:slug
 *
 * Addressed by SLUG, not by UUID. A shareable link should read
 * /courses/ai-literacy-foundations, not a 36-character identifier
 * nobody can repeat over the phone. The slug is already unique and
 * already indexed.
 *
 * authenticateOptional rather than authenticate: a signed-in visitor
 * gets the same page plus their enrolment state, so the button can say
 * "Continue" instead of "Enrol". A signed-out visitor gets the page.
 * Neither gets the course content.
 */
router.get(
  '/courses/:slug',
  previewLimiter,
  authenticateOptional,
  wrap(async (req, res) => {
    const course = await queryOne(
      `SELECT a.id, a.slug, a.title, a.summary, a.description, a.type,
              a.tags, a.level, a.languages, a.weeks, a.hours_per_week,
              a.estimated_minutes, a.payload_kb, a.capacity,
              a.outcomes, a.prerequisites, a.instructor_note, a.skills,
              a.awards_certificate, a.certificate_title,
              a.opens_at, a.closes_at,
              p.full_name  AS instructor_name,
              p.headline   AS instructor_headline,
              p.avatar_url AS instructor_avatar,
              p.country    AS instructor_country,
              (SELECT count(*)::int FROM enrolments e
                WHERE e.activity_id = a.id AND e.status <> 'withdrawn')
                AS enrolled_count,
              (SELECT count(*)::int FROM enrolments e
                WHERE e.activity_id = a.id AND e.status = 'completed')
                AS completed_count
         FROM activities a
         LEFT JOIN profiles p ON p.user_id = a.facilitator_id
        WHERE a.slug = $1 AND a.status = 'published'`,
      [req.params.slug]
    );

    // A draft course is indistinguishable from a course that does not
    // exist. Otherwise the landing page becomes a way to discover what
    // a facilitator is working on before they publish it.
    if (!course) throw notFound('Course');

    const modules = await query(
      `SELECT m.id, m.position, m.title, m.estimated_minutes,
              m.objectives, m.week_offset,
              COALESCE(
                (SELECT json_agg(json_build_object(
                   'id', i.id, 'position', i.position, 'kind', i.kind,
                   'title', i.title, 'estimatedMinutes', i.estimated_minutes,
                   'isRequired', i.is_required,
                   'durationSeconds', i.duration_seconds,
                   'materialCount', i.material_count,
                   'materialBytes', i.material_bytes,
                   'hasTranscript', i.has_transcript
                 ) ORDER BY i.position)
                   FROM course_preview_items i WHERE i.module_id = m.id),
                '[]'::json
              ) AS items
         FROM activity_modules m
        WHERE m.activity_id = $1
        ORDER BY m.position`,
      [course.id]
    );

    // Enrolment state only, never progress detail. Someone sharing a
    // screenshot of a course page should not be sharing how far behind
    // they are.
    let viewer = { enrolled: false, completed: false };
    if (req.user) {
      const enrolment = await queryOne(
        `SELECT status FROM enrolments WHERE activity_id = $1 AND user_id = $2`,
        [course.id, req.user.id]
      );
      viewer = {
        enrolled: Boolean(enrolment) && enrolment.status !== 'withdrawn',
        completed: enrolment?.status === 'completed'
      };
    }

    const items = modules.rows.flatMap((module) => module.items);
    const totalMinutes = items.reduce((sum, item) => sum + (item.estimatedMinutes ?? 0), 0)
      || course.estimated_minutes;

    const syllabus = modules.rows.map((module) => ({
      ...module,
      totalMinutes: module.items.reduce((sum, i) => sum + (i.estimatedMinutes ?? 0), 0)
    }));

    const payload = {
      course: {
        ...course,
        // Derived rather than stored, so it cannot drift from the
        // content. A course that gains a module gains minutes here
        // without anybody editing a number.
        totalMinutes,
        itemCount: items.length,
        // The count of each kind lets the page say "6 readings, 2
        // quizzes" instead of "8 items", which is what a person
        // deciding whether to start actually wants to know.
        breakdown: items.reduce((counts, item) => {
          counts[item.kind] = (counts[item.kind] ?? 0) + 1;
          return counts;
        }, {})
      },
      syllabus,
      viewer
    };

    // Public and cacheable for a signed-out visitor, private for a
    // signed-in one, because the viewer block is identity-derived. A
    // shared cache must never hand one person's enrolment state to
    // another.
    return sendJson(req, res, payload, {
      private: Boolean(req.user),
      maxAge: req.user ? 0 : 300
    });
  })
);

/**
 * GET /api/courses
 *
 * The public catalogue. Distinct from GET /api/activities, which is the
 * signed-in discovery list: this one is browsable by a stranger and
 * returns only what a landing-page card needs.
 */
router.get(
  '/courses',
  previewLimiter,
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT a.slug, a.title, a.summary, a.type, a.tags, a.level,
              a.weeks, a.hours_per_week, a.payload_kb, a.awards_certificate,
              p.full_name AS instructor_name,
              (SELECT count(*)::int FROM enrolments e
                WHERE e.activity_id = a.id AND e.status <> 'withdrawn')
                AS enrolled_count
         FROM activities a
         LEFT JOIN profiles p ON p.user_id = a.facilitator_id
        WHERE a.status = 'published'
          AND (a.opens_at IS NULL OR a.opens_at <= now())
        ORDER BY a.opens_at DESC NULLS LAST
        LIMIT 50`
    );

    return sendJson(req, res, { courses: rows.rows }, { private: false, maxAge: 300 });
  })
);

export default router;
