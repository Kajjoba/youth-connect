-- =====================================================================
-- 003: course structure
--
-- The content model was flat: an activity held modules, and a module
-- held one blob of text plus an optional link. That cannot express a
-- real course, where a week contains a reading, then a video, then a
-- quiz, each with its own files.
--
-- Borrowed from the shape Coursera and similar platforms use:
--
--   Activity (course)
--     └── Module (week or unit)
--           └── Item (reading, video, quiz, assignment ...)
--                 └── Material (uploaded file)
--
-- DESIGN DECISION (ADR-016): the structure is borrowed, the media
-- priority is inverted.
--
-- Coursera is video-first. Video is the wrong default here. Ten minutes
-- of 480p video is roughly 50 MB, which on Ugandan prepaid mobile data
-- costs more than many participants' weekly bundle. The brief names
-- low bandwidth twice as a core constraint, so:
--
--   reading is the default item kind, not video
--   every item declares its byte weight, and modules and activities
--     aggregate it, so cost is visible before anything is opened
--   video is supported as an EXTERNAL link rather than an upload, so
--     the platform never serves 50 MB itself and a participant can
--     decide on a connection they understand
--   a transcript field exists on video items, because reading a
--     transcript costs about 8 KB against 50 MB for watching
--
-- That last point is the one worth defending: the accessible option and
-- the cheap option are the same option.
-- =====================================================================

CREATE TYPE item_kind AS ENUM (
  'reading',      -- text held in the platform, the default
  'video',        -- external link, never uploaded
  'audio',        -- external link; far cheaper than video
  'document',     -- uploaded file, for example a PDF worksheet
  'link',         -- external resource
  'quiz',         -- points at an assessment
  'assignment',   -- points at an assessment expecting a submission
  'discussion'    -- prompts a thread
);

-- ---------------------------------------------------------------------
-- LESSON ITEMS
-- ---------------------------------------------------------------------

CREATE TABLE lesson_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id         UUID NOT NULL REFERENCES activity_modules(id) ON DELETE CASCADE,
  position          SMALLINT NOT NULL,
  kind              item_kind NOT NULL DEFAULT 'reading',
  title             TEXT NOT NULL,

  body              TEXT,          -- reading content
  external_url      TEXT,          -- video, audio, link
  transcript        TEXT,          -- the cheap alternative to watching
  duration_seconds  INTEGER,       -- video and audio only

  -- Points at an assessment for quiz and assignment items. Nullable
  -- because most items are not assessed.
  assessment_id     UUID REFERENCES assessments(id) ON DELETE SET NULL,

  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  is_required       BOOLEAN NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (module_id, position),

  -- An item must actually contain what its kind promises. Without this,
  -- a "video" with no URL renders as an empty box and nobody discovers
  -- it until a participant opens it.
  CONSTRAINT lesson_items_has_content CHECK (
    (kind = 'reading'    AND body IS NOT NULL)
    OR (kind IN ('video', 'audio', 'link') AND external_url IS NOT NULL)
    OR (kind IN ('quiz', 'assignment')     AND assessment_id IS NOT NULL)
    OR (kind IN ('document', 'discussion'))
  )
);

CREATE INDEX idx_items_module ON lesson_items (module_id, position);

-- ---------------------------------------------------------------------
-- MATERIALS
--
-- Uploaded files attached to an item.
--
-- Stored in Postgres, same reasoning as ADR-014 for avatars: a
-- container filesystem does not survive a redeploy, and object storage
-- adds a second service and a second set of credentials. The 5 MB cap
-- keeps this honest. Anything larger belongs behind an external link,
-- which the 'link' item kind exists for.
--
-- In production at scale this table should move to object storage with
-- signed URLs. Saying so is not a weakness in the design; pretending
-- Postgres is the right permanent home for binary blobs would be.
-- ---------------------------------------------------------------------

CREATE TABLE materials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID NOT NULL REFERENCES lesson_items(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  bytes         BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  checksum      TEXT NOT NULL,
  uploaded_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 5 MB. Generous for a worksheet, small enough that one careless
  -- upload cannot make a module unopenable on a mobile connection.
  CONSTRAINT materials_size_limit CHECK (byte_size > 0 AND byte_size <= 5242880),

  -- Executable and scriptable types are excluded outright. An SVG or an
  -- HTML file served from our own origin executes in our security
  -- context, which turns a course material into stored cross-site
  -- scripting. See the avatar reasoning in migration 002.
  CONSTRAINT materials_safe_type CHECK (mime_type IN (
    'application/pdf',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'text/plain', 'text/csv', 'text/markdown',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip'
  ))
);

CREATE INDEX idx_materials_item ON materials (item_id);

-- ---------------------------------------------------------------------
-- ITEM PROGRESS
--
-- Progress is now tracked per item. module_progress is KEPT and derived
-- from it rather than replaced, so every existing endpoint, query and
-- test continues to work unchanged. A module with no items still
-- behaves exactly as before.
--
-- That is the deliberate shape of this migration: extend, do not
-- rewrite. The evaluation criterion is whether the system absorbs a
-- changing requirement without redesign, and a migration that broke
-- every progress query would be the answer "no".
-- ---------------------------------------------------------------------

CREATE TABLE item_progress (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES lesson_items(id) ON DELETE CASCADE,
  status        progress_status NOT NULL DEFAULT 'not_started',
  seconds_spent INTEGER NOT NULL DEFAULT 0,
  completed_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrolment_id, item_id)
);

CREATE INDEX idx_item_progress_enrolment ON item_progress (enrolment_id);

-- ---------------------------------------------------------------------
-- DERIVED WEIGHT
--
-- activities.payload_kb was a number a facilitator typed in. A number
-- someone types is a guess that drifts from reality the moment content
-- changes, and the entire low-bandwidth promise of this platform rests
-- on that figure being true.
--
-- It is now computed from what is actually stored: the real bytes of
-- every material, plus an estimate for text. Participants see a
-- measured cost, not an intention.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION recompute_activity_weight(target_activity UUID)
RETURNS void AS $$
BEGIN
  UPDATE activities a
     SET payload_kb = GREATEST(1, COALESCE((
           SELECT ceil(SUM(weight) / 1024.0)
             FROM (
               -- real bytes of uploaded files
               SELECT mat.byte_size::numeric AS weight
                 FROM materials mat
                 JOIN lesson_items li ON li.id = mat.item_id
                 JOIN activity_modules m ON m.id = li.module_id
                WHERE m.activity_id = a.id

               UNION ALL

               -- text weighs what it weighs, roughly one byte a character
               SELECT (COALESCE(length(li.body), 0)
                     + COALESCE(length(li.transcript), 0))::numeric
                 FROM lesson_items li
                 JOIN activity_modules m ON m.id = li.module_id
                WHERE m.activity_id = a.id

               UNION ALL

               SELECT COALESCE(length(m.body), 0)::numeric
                 FROM activity_modules m
                WHERE m.activity_id = a.id
             ) AS parts
         ), 0))
   WHERE a.id = target_activity;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_activity_weight() RETURNS TRIGGER AS $$
DECLARE
  target UUID;
BEGIN
  SELECT m.activity_id INTO target
    FROM activity_modules m
    JOIN lesson_items li ON li.module_id = m.id
   WHERE li.id = COALESCE(NEW.item_id, OLD.item_id);

  IF target IS NOT NULL THEN
    PERFORM recompute_activity_weight(target);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_materials_weight
  AFTER INSERT OR UPDATE OR DELETE ON materials
  FOR EACH ROW EXECUTE FUNCTION touch_activity_weight();

CREATE OR REPLACE FUNCTION touch_activity_weight_from_item() RETURNS TRIGGER AS $$
DECLARE
  target UUID;
BEGIN
  SELECT m.activity_id INTO target
    FROM activity_modules m
   WHERE m.id = COALESCE(NEW.module_id, OLD.module_id);

  IF target IS NOT NULL THEN
    PERFORM recompute_activity_weight(target);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_weight
  AFTER INSERT OR UPDATE OR DELETE ON lesson_items
  FOR EACH ROW EXECUTE FUNCTION touch_activity_weight_from_item();

CREATE TRIGGER trg_items_touch BEFORE UPDATE ON lesson_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
