-- =====================================================================
-- 005: course landing page
--
-- A course list row answers "what is this called". It does not answer
-- the questions someone actually asks before committing their time and
-- their data bundle: what will I be able to do afterwards, how long
-- does it take, who teaches it, do I need anything first.
--
-- These columns hold those answers.
-- =====================================================================

ALTER TABLE activities
  -- "What you'll learn". Stored as an array rather than a blob of text
  -- so the interface can render it as a checklist and so a facilitator
  -- cannot accidentally produce three paragraphs where four bullets
  -- were wanted.
  ADD COLUMN outcomes        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN prerequisites   TEXT[] NOT NULL DEFAULT '{}',

  -- Weeks and weekly hours rather than a single total. "12 hours" tells
  -- someone nothing about whether they can fit it around a job;
  -- "4 weeks, about 3 hours a week" tells them exactly that.
  ADD COLUMN weeks           SMALLINT,
  ADD COLUMN hours_per_week  NUMERIC(4,1),

  ADD COLUMN level           TEXT NOT NULL DEFAULT 'beginner',
  ADD COLUMN languages       TEXT[] NOT NULL DEFAULT '{English}',

  -- Shown on the landing page under the facilitator's name. Distinct
  -- from their profile bio, which is about them as a participant in the
  -- programme rather than as the person teaching this course.
  ADD COLUMN instructor_note TEXT,

  -- ADD CONSTRAINT, not a bare CONSTRAINT clause: inside ALTER TABLE
  -- every action needs its own verb, unlike CREATE TABLE where the
  -- constraint sits alongside the column definitions.
  ADD CONSTRAINT activities_level_known
    CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  ADD CONSTRAINT activities_weeks_sane
    CHECK (weeks IS NULL OR (weeks > 0 AND weeks <= 52));

-- ---------------------------------------------------------------------
-- PUBLIC PREVIEW
--
-- DESIGN DECISION (ADR-018): the landing page is public, and it is a
-- minimum-disclosure PROJECTION of the course rather than the course
-- with a login gate in front of it.
--
-- Making it public is the point. A course catalogue that requires an
-- account to browse cannot be shared, cannot be linked from a WhatsApp
-- group, and cannot be found by anyone who has not already committed.
-- That is how a youth programme fails to reach the young people it is
-- for.
--
-- But "public" must not mean "the whole course is free to anyone who
-- skips enrolment". The split:
--
--   VISIBLE before enrolling: module titles, item titles, item kinds,
--   durations, counts, the data weight. Enough to decide.
--
--   HIDDEN until enrolled: reading bodies, transcripts, material files,
--   assessment questions. The substance.
--
-- This view enforces the split in the database rather than leaving it
-- to whichever handler happens to select the right columns. A future
-- endpoint that queries the view cannot leak a reading body, because
-- the body is not in the view to select.
--
-- That is the difference between a rule and a control: a rule is
-- followed by whoever remembers it, a control cannot be forgotten.
-- ---------------------------------------------------------------------

CREATE VIEW course_preview_items AS
  SELECT
    li.id,
    li.module_id,
    li.position,
    li.kind,
    li.title,
    li.estimated_minutes,
    li.is_required,
    li.duration_seconds,
    -- The existence and size of attachments is structural information,
    -- so it is disclosed. Their contents are not.
    (SELECT count(*)::int FROM materials mat WHERE mat.item_id = li.id)
      AS material_count,
    (SELECT COALESCE(sum(mat.byte_size), 0)::int FROM materials mat WHERE mat.item_id = li.id)
      AS material_bytes,
    -- Whether a transcript exists matters to someone deciding on a
    -- metered connection. Its text does not.
    (li.transcript IS NOT NULL AND length(li.transcript) > 0) AS has_transcript
  FROM lesson_items li;

COMMENT ON VIEW course_preview_items IS
  'Structure-only projection of lesson_items for the public course landing page. Deliberately excludes body, transcript and external_url.';

-- ---------------------------------------------------------------------
-- Seeded courses get real landing-page content, so the page is
-- demonstrable without authoring a course first.
-- ---------------------------------------------------------------------

UPDATE activities SET
  outcomes = ARRAY[
    'Explain in plain language how a machine learning model differs from rules-based software',
    'Recognise confident but incorrect output and say why it happened',
    'Identify whose data is missing from a model and what that costs',
    'Use AI tools in study and work without outsourcing your judgement'
  ],
  prerequisites = ARRAY['No prior technical background needed'],
  weeks = 3,
  hours_per_week = 2.5,
  level = 'beginner',
  instructor_note = 'Daniel has spent six years building data systems for agricultural cooperatives across Kenya and Tanzania, and teaches this course the way he wishes it had been taught to him.'
  WHERE slug = 'ai-literacy-foundations';

UPDATE activities SET
  outcomes = ARRAY[
    'Map your existing skills to roles that are actually hiring in the region',
    'Build a portfolio that survives a thirty second scan',
    'Handle an interview across cultures and time zones with confidence'
  ],
  prerequisites = ARRAY['Some work or volunteer experience helps, but is not required'],
  weeks = 2,
  hours_per_week = 3,
  level = 'beginner'
  WHERE slug = 'employability-in-a-digital-economy';

UPDATE activities SET
  outcomes = ARRAY[
    'Work productively with people whose norms and schedules differ from yours',
    'Run asynchronous collaboration when nobody shares a timezone',
    'Disagree in writing without damaging the working relationship'
  ],
  weeks = 2,
  hours_per_week = 1.5,
  level = 'intermediate',
  languages = ARRAY['English', 'Swahili']
  WHERE slug = 'intercultural-collaboration';

UPDATE activities SET
  outcomes = ARRAY[
    'Separate a symptom from its cause before proposing a fix',
    'Tell evidence, assumption and inference apart in your own reasoning',
    'Write a problem statement other people can act on'
  ],
  prerequisites = ARRAY['Completion of AI Literacy Foundations is helpful but not required'],
  weeks = 4,
  hours_per_week = 2,
  level = 'intermediate'
  WHERE slug = 'critical-thinking-for-problem-solving';
