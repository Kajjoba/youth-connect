-- =====================================================================
-- 007: pacing, objectives, skills and grades
--
-- Studied against Coursera's current course page and learner
-- experience. This migration adds the parts that genuinely transfer to
-- this brief, and deliberately omits the parts that do not.
--
-- TAKEN:
--   per-module learning objectives  (pedagogically real, cheap)
--   per-module week offsets         (the suggested schedule)
--   skills gained                   (serves employability AND Level Two
--                                    team matching, which needs to find
--                                    people whose skills complement)
--   a grades projection             (the brief's "monitor progress"
--                                    has no single place to see marks)
--
-- LEFT OUT, with reasons:
--   ratings and reviews   a four-person cohort produces no signal, and
--                         inventing stars would be fabricating evidence
--   specializations       large scope, no requirement in the brief
--   employer logos        social proof this programme has not earned
--   video player features this platform deliberately does not host video
--
-- =====================================================================
-- DESIGN DECISION (ADR-020): deadlines are PERSONALISED and SOFT.
--
-- Coursera computes a learner's deadlines from the date they enrolled,
-- not from a fixed cohort calendar, and missing one carries no penalty.
-- Copying that here is not imitation, it is the right answer for this
-- population.
--
-- A fixed cohort deadline punishes a participant for their
-- infrastructure. Someone who loses power for four days, or whose data
-- bundle runs out mid-month, falls behind a date they never had a fair
-- chance at, and the system tells them they failed. A schedule anchored
-- to their own enrolment gives them the thing deadlines are actually
-- for, which is structure and a sense of pace, without the thing
-- deadlines are often used for, which is punishment.
--
-- So: due dates are DERIVED, never stored per participant. There is no
-- row anywhere saying "Amina's module 3 is due on the 14th". There is a
-- week offset on the module and an enrolment date, and the deadline is
-- computed from the two. Nothing to backfill, nothing to migrate when
-- someone re-enrols, and no way for a stored date to drift from the
-- schedule it came from.
-- =====================================================================

ALTER TABLE activity_modules
  -- "In this module you will..." Coursera shows these collapsed under
  -- each module heading. Cheap to store, genuinely useful to a learner
  -- deciding whether they need this section.
  ADD COLUMN objectives  TEXT[] NOT NULL DEFAULT '{}',

  -- Which week of the course this module belongs to. NULL means
  -- unscheduled, which is correct for a self-paced activity with no
  -- suggested pace at all.
  ADD COLUMN week_offset SMALLINT,

  ADD CONSTRAINT modules_week_offset_sane
    CHECK (week_offset IS NULL OR (week_offset >= 1 AND week_offset <= 52));

ALTER TABLE activities
  -- Skills are NOT tags. Tags are topical and used for browsing
  -- ("ai", "careers"). Skills are what a participant can claim
  -- afterwards, which is what an employer reads and what Level Two
  -- team matching has to query against.
  ADD COLUMN skills TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_activities_skills ON activities USING GIN (skills);

-- ---------------------------------------------------------------------
-- THE PERSONAL SCHEDULE
--
-- One view, computing every participant's deadline for every module
-- they are enrolled in. Derived from enrolment date plus week offset.
--
-- Note `is_overdue` is a fact, not a judgement: it says the suggested
-- date has passed and the work is not done. Nothing in the system
-- blocks, penalises or locks on the strength of it. The interface says
-- "behind schedule", never "late", and offers to reset the schedule.
-- ---------------------------------------------------------------------

CREATE VIEW module_schedule AS
  SELECT
    e.id           AS enrolment_id,
    e.user_id,
    e.activity_id,
    m.id           AS module_id,
    m.position,
    m.title,
    m.week_offset,
    e.enrolled_at,
    -- The suggested date: enrolment plus one week per offset. A module
    -- with no offset has no deadline, which the interface renders as
    -- "no set date" rather than as an absent value.
    CASE WHEN m.week_offset IS NULL THEN NULL
         ELSE (e.enrolled_at + (m.week_offset * INTERVAL '7 days'))
    END            AS due_at,
    COALESCE(mp.status, 'not_started') AS status,
    mp.completed_at,
    CASE
      WHEN m.week_offset IS NULL THEN FALSE
      WHEN COALESCE(mp.status, 'not_started') = 'completed' THEN FALSE
      ELSE (e.enrolled_at + (m.week_offset * INTERVAL '7 days')) < now()
    END            AS is_overdue
  FROM enrolments e
  JOIN activity_modules m ON m.activity_id = e.activity_id
  LEFT JOIN module_progress mp
         ON mp.enrolment_id = e.id AND mp.module_id = m.id
  WHERE e.status <> 'withdrawn';

COMMENT ON VIEW module_schedule IS
  'Personalised soft deadlines, derived from enrolment date and module week offset. Nothing is stored per participant. See ADR-020.';

-- ---------------------------------------------------------------------
-- RESETTING THE SCHEDULE
--
-- Coursera lets a learner who has fallen behind shift their deadlines
-- forward rather than stare at a wall of red. That is the humane
-- behaviour and it costs almost nothing here: move the enrolment date
-- and every derived deadline moves with it.
--
-- This is the payoff of deriving rather than storing. With stored
-- per-participant dates, resetting a schedule means rewriting a row per
-- module and hoping none were missed.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reset_schedule(target_enrolment UUID)
RETURNS TIMESTAMPTZ AS $$
DECLARE
  new_start TIMESTAMPTZ;
BEGIN
  -- Anchor to the start of today rather than this instant, so a reset
  -- at 23:50 does not give someone a deadline at 23:50 six weeks later.
  new_start := date_trunc('day', now());

  UPDATE enrolments
     SET enrolled_at = new_start
   WHERE id = target_enrolment
     AND status <> 'completed'
  RETURNING enrolled_at INTO new_start;

  RETURN new_start;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- GRADES
--
-- The brief's Level One journey ends at "Monitor Progress", and until
-- now there was nowhere to see your marks in one place: a score lived
-- inside whichever assessment produced it.
--
-- One row per assessment per enrolled participant, whether or not they
-- have attempted it. The unattempted ones matter most: a grades page
-- that only lists what you have done cannot tell you what you still
-- owe.
-- ---------------------------------------------------------------------

CREATE VIEW grade_book AS
  SELECT
    e.user_id,
    e.activity_id,
    a.id                AS assessment_id,
    a.title,
    a.type,
    a.max_score,
    a.pass_score,
    a.max_attempts,
    a.due_at,
    best.score          AS best_score,
    best.status         AS status,
    best.attempt        AS attempts_used,
    best.submitted_at,
    best.graded_at,
    CASE
      WHEN best.score IS NULL THEN NULL
      ELSE best.score >= a.pass_score
    END                 AS passed,
    (SELECT count(*)::int FROM submissions s2
      WHERE s2.assessment_id = a.id AND s2.user_id = e.user_id
        AND s2.status <> 'draft')  AS submission_count
  FROM enrolments e
  JOIN assessments a ON a.activity_id = e.activity_id
  LEFT JOIN LATERAL (
    -- The BEST attempt, not the latest. Someone who scores 80 then 60
    -- has demonstrated 80, and every assessment here allows retries
    -- precisely so a bad connection mid-quiz is recoverable.
    SELECT s.score, s.status, s.attempt, s.submitted_at, s.graded_at
      FROM submissions s
     WHERE s.assessment_id = a.id AND s.user_id = e.user_id
       AND s.status <> 'draft'
     ORDER BY s.score DESC NULLS LAST, s.attempt DESC
     LIMIT 1
  ) best ON TRUE
  WHERE e.status <> 'withdrawn';

COMMENT ON VIEW grade_book IS
  'Every assessment a participant is enrolled in, attempted or not, with their best attempt.';

-- ---------------------------------------------------------------------
-- Seeded content gets objectives, a schedule and skills, so the
-- features are visible without authoring a course first.
--
-- Same reason as migrations 004 and 005: this UPDATE matches nothing on
-- a fresh database, because migrations run before seeding. The seed
-- also sets these. Both paths are needed.
-- ---------------------------------------------------------------------

UPDATE activities SET skills = ARRAY[
  'Critical evaluation of AI output', 'Prompt literacy',
  'Data bias awareness', 'Responsible technology use'
] WHERE slug = 'ai-literacy-foundations';

UPDATE activities SET skills = ARRAY[
  'CV and portfolio writing', 'Interviewing', 'Skills mapping',
  'Remote work readiness'
] WHERE slug = 'employability-in-a-digital-economy';

UPDATE activities SET skills = ARRAY[
  'Cross-cultural communication', 'Asynchronous collaboration',
  'Written negotiation'
] WHERE slug = 'intercultural-collaboration';

UPDATE activities SET skills = ARRAY[
  'Problem framing', 'Root cause analysis', 'Evidence evaluation'
] WHERE slug = 'critical-thinking-for-problem-solving';

-- Give every seeded module a week, so the timeline has something to
-- show. Module N belongs to week N, which is the obvious default and
-- the one a facilitator would start from.
UPDATE activity_modules SET week_offset = position;
