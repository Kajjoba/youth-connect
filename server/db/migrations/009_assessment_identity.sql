-- =====================================================================
-- 009: one assessment per title per course
--
-- DEFECT, found by running the seed twice rather than by reading it.
--
-- Every INSERT in db/seed.js carries ON CONFLICT except one: the
-- assessment. So running `npm run db:seed` a second time, which is the
-- most natural thing in the world to do after copying files across or
-- pointing at a new database, silently created a SECOND copy of the
-- same quiz on the same course.
--
-- What that duplicate does is worse than clutter. activities.requires_pass
-- means EVERY assessment attached to the course has to be passed before
-- a certificate is issued. issue_certificate_if_earned therefore counts
-- two assessments and one pass, and returns NULL.
--
-- The participant finishes every reading, passes the quiz, watches the
-- course tick over to complete, and gets no certificate. There is no
-- error. The claim endpoint says "Pass all assessments first. You have
-- passed 1 of 2", which is true and completely baffling, because the
-- second assessment is invisible: nothing links it to a lesson item, so
-- it appears nowhere in the course.
--
-- Three tests failed on it. The failure looked like a certificate bug,
-- then like a migration that had not run, then like a partial copy.
-- It was a missing ON CONFLICT in a seed script.
-- =====================================================================
-- DESIGN DECISION (ADR-022): make the DATABASE refuse the duplicate,
-- not just the seed script.
--
-- The narrow fix is to add ON CONFLICT to seed.js, and that is done too.
-- But the seed is not the only thing that inserts assessments. The
-- facilitator endpoint does, a future import script would, and a
-- restored backup can. Fixing the one caller leaves every other caller
-- free to reintroduce exactly this failure.
--
-- Two assessments with the same title on the same course is not a state
-- worth representing. It is a content error in every case. So it becomes
-- a constraint, where it holds for every writer that will ever exist,
-- rather than a convention in one file that the next writer has not read.
--
-- This is the same reasoning as issue_certificate_if_earned living in
-- the database rather than in three handlers: a rule enforced in one
-- place cannot drift, and a rule enforced per caller always does.
-- =====================================================================

-- ---------------------------------------------------------------------
-- REPAIR FIRST
--
-- The index cannot be created while duplicates exist, and the duplicates
-- hold real rows. Amina's graded submission and its feedback are seeded
-- against whichever copy the seed inserted last, and submissions
-- CASCADE on delete, so deleting a duplicate outright would destroy
-- marked work.
--
-- So: pick a survivor per group, move everything that points at the
-- others onto it, then delete the others.
--
-- The survivor is the copy with the most submissions, because that is
-- the one people have actually used, with the oldest as the tie-break so
-- the choice is deterministic rather than whatever order the planner
-- happened to return.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  duplicate RECORD;
  affected  UUID[] := ARRAY[]::UUID[];
BEGIN
  FOR duplicate IN
    WITH ranked AS (
      SELECT a.id,
             a.activity_id,
             first_value(a.id) OVER (
               PARTITION BY a.activity_id, lower(a.title)
               ORDER BY (SELECT count(*) FROM submissions s WHERE s.assessment_id = a.id) DESC,
                        a.created_at ASC,
                        a.id ASC
             ) AS keeper
        FROM assessments a
    )
    SELECT id AS loser, keeper, activity_id FROM ranked WHERE id <> keeper
  LOOP
    -- Move submissions onto the survivor, but only where the survivor
    -- does not already hold that person's attempt number. UNIQUE
    -- (assessment_id, user_id, attempt) would reject those, and they are
    -- duplicates of work the survivor already has.
    UPDATE submissions s
       SET assessment_id = duplicate.keeper
     WHERE s.assessment_id = duplicate.loser
       AND NOT EXISTS (
         SELECT 1 FROM submissions existing
          WHERE existing.assessment_id = duplicate.keeper
            AND existing.user_id = s.user_id
            AND existing.attempt = s.attempt
       );

    -- Anything that could not move is a second copy of an attempt the
    -- survivor already carries, so it goes with the duplicate.

    -- Repoint any lesson item that referenced the duplicate. Without
    -- this the FK sets it to NULL on delete and the item violates its
    -- own CHECK the next time anything writes to it.
    UPDATE lesson_items
       SET assessment_id = duplicate.keeper
     WHERE assessment_id = duplicate.loser;

    DELETE FROM assessments WHERE id = duplicate.loser;

    IF NOT (duplicate.activity_id = ANY (affected)) THEN
      affected := affected || duplicate.activity_id;
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------
  -- Anyone who was silently denied a certificate by the phantom
  -- assessment has earned it all along. Recalculating their enrolment
  -- issues it, because issue_certificate_if_earned is idempotent and
  -- now counts the right number of assessments.
  --
  -- Same shape as the repair in migration 008: fixing the rule is only
  -- half the job when people have already been affected by the old one.
  -- ---------------------------------------------------------------------
  IF array_length(affected, 1) > 0 THEN
    PERFORM recalculate_progress(e.id)
       FROM enrolments e
      WHERE e.activity_id = ANY (affected)
        AND e.status <> 'withdrawn';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- THE CONSTRAINT
--
-- Case insensitive, because "Week 1 Quiz" and "Week 1 quiz" on one
-- course is the same mistake wearing a different hat.
-- ---------------------------------------------------------------------

CREATE UNIQUE INDEX idx_assessments_unique_title
  ON assessments (activity_id, lower(title));

COMMENT ON INDEX idx_assessments_unique_title IS
  'ADR-022: two assessments with the same title on one course is always a '
  'content error, and it silently blocks certificates because requires_pass '
  'demands a pass on every assessment. Enforced here so every writer is '
  'covered, not only the seed script.';
