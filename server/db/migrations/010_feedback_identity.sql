-- =====================================================================
-- 010: one piece of feedback per reviewer per submission
--
-- DEFECT, and the worst one found so far, because it defeats a control
-- the brief names explicitly.
--
-- The feedback handler said, in its own comment, "posting again for the
-- same reviewer UPDATES rather than inserting, which fires the
-- version-bump trigger". It implemented that with a SELECT followed by
-- a branch:
--
--     SELECT id FROM feedback WHERE submission_id = $1 AND reviewer_id = $2
--     if (found) UPDATE ... else INSERT ...
--
-- Read, decide, write. Under READ COMMITTED, which is the default, two
-- requests from the same reviewer can both run the SELECT before either
-- runs the INSERT, and both then insert. Nothing stops them: there was
-- no unique constraint on (submission_id, reviewer_id) at all. The
-- transaction is irrelevant here, because the rows do not conflict with
-- anything.
--
-- It is not a theoretical race. The test database ended up with THREE
-- rows from one facilitator on one submission, from ordinary sequential
-- test runs plus a double-click's worth of overlap.
--
-- WHY IT MATTERS MORE THAN A DUPLICATE ROW
--
-- The feedback list is returned ORDER BY created_at, so the client shows
-- the OLDEST row first. Once a duplicate exists, a revision lands in one
-- row while the participant is looking at another. The row they see
-- never changes, so its version never advances, so their cached copy is
-- never invalidated, and their read receipt keeps it marked read.
--
-- That is the incident from section 5 of the brief, word for word: a
-- participant cannot see updated feedback. Every deliberate defence
-- against it, the version column, the version-scoped read receipt, the
-- ETag built from the version, is correct and all of it is bypassed,
-- because they all describe "the feedback" as though there were one.
--
-- A control that assumes a uniqueness the schema does not enforce is not
-- a control.
-- =====================================================================
-- DESIGN DECISION (ADR-023): if the code claims a row is unique, the
-- schema has to say so.
--
-- The handler is rewritten as a single atomic INSERT ... ON CONFLICT
-- DO UPDATE, which cannot race. But the constraint comes first and
-- matters more: it is what makes the upsert possible, it rejects the
-- duplicate no matter which caller attempts it, and it turns a silent
-- data-shape assumption into something the database checks.
--
-- Same reasoning as ADR-022 one migration earlier. Both defects were a
-- rule that lived in application code while the schema permitted the
-- state the rule forbade. That gap is where this kind of bug lives, and
-- it does not announce itself: neither of these produced an error
-- anywhere. They produced a participant who finished a course and got
-- nothing, and a participant reading feedback that had been revised
-- under them.
-- =====================================================================

-- ---------------------------------------------------------------------
-- REPAIR FIRST: collapse the duplicates
--
-- Keep the OLDEST row per (submission_id, reviewer_id). That is the row
-- clients have been shown, the row read receipts point at, and the row
-- whose id already appears in delivered notifications.
--
-- Take the body, rubric and visibility from the NEWEST, because the most
-- recent revision is what the reviewer actually meant to say. The
-- survivor is UPDATEd rather than left alone, which fires
-- bump_feedback_version: the version advances, every held ETag is
-- invalidated, the version-scoped receipt no longer matches, and the
-- feedback correctly resurfaces as unread for the participant.
--
-- So the repair does not merely tidy the table. It delivers the revision
-- that the duplicate row had been hiding.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  group_row RECORD;
BEGIN
  FOR group_row IN
    SELECT submission_id,
           reviewer_id,
           (array_agg(id ORDER BY created_at ASC, id ASC))[1]  AS keeper,
           (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS newest
      FROM feedback
     GROUP BY submission_id, reviewer_id
    HAVING count(*) > 1
  LOOP
    -- Carry the latest wording onto the survivor.
    UPDATE feedback keeper
       SET body         = newest.body,
           rubric       = newest.rubric,
           visible_from = LEAST(keeper.visible_from, newest.visible_from)
      FROM feedback newest
     WHERE keeper.id = group_row.keeper
       AND newest.id = group_row.newest
       AND keeper.id <> newest.id;

    -- Receipts against a row that is about to disappear would vanish
    -- with it (ON DELETE CASCADE). Move the ones the survivor does not
    -- already hold for that version.
    --
    -- NOTE, and this is the same mistake as the defect being fixed, made
    -- once more while fixing it: a NOT EXISTS guard here is not enough.
    -- It is evaluated against the snapshot taken before the statement
    -- ran, so it correctly excludes receipts that collide with the
    -- SURVIVOR and cannot see receipts that collide with EACH OTHER. Two
    -- duplicate rows each holding one person's receipt for version 1
    -- both pass the guard and then violate the unique key between
    -- themselves.
    --
    -- A per-row check cannot enforce a set-wide constraint. DISTINCT ON
    -- reduces the set to one receipt per (person, version) before
    -- anything moves, keeping the earliest, which is the honest reading
    -- time. Whatever is left behind is a receipt for a version the
    -- survivor already records as seen, and goes with the deleted row.
    WITH losers AS (
      SELECT id FROM feedback
       WHERE submission_id = group_row.submission_id
         AND reviewer_id = group_row.reviewer_id
         AND id <> group_row.keeper
    ), movable AS (
      SELECT DISTINCT ON (r.user_id, r.version_seen) r.id
        FROM feedback_receipts r
        JOIN losers l ON l.id = r.feedback_id
       WHERE NOT EXISTS (
         SELECT 1 FROM feedback_receipts held
          WHERE held.feedback_id = group_row.keeper
            AND held.user_id = r.user_id
            AND held.version_seen = r.version_seen
       )
       ORDER BY r.user_id, r.version_seen, r.read_at ASC, r.id ASC
    )
    UPDATE feedback_receipts
       SET feedback_id = group_row.keeper
     WHERE id IN (SELECT id FROM movable);

    DELETE FROM feedback
     WHERE submission_id = group_row.submission_id
       AND reviewer_id = group_row.reviewer_id
       AND id <> group_row.keeper;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- THE CONSTRAINT
--
-- One reviewer, one piece of feedback per submission, revised in place.
-- A second reviewer on the same submission is legitimate and unaffected:
-- a facilitator and a mentor can each leave their own.
-- ---------------------------------------------------------------------

ALTER TABLE feedback
  ADD CONSTRAINT feedback_one_per_reviewer UNIQUE (submission_id, reviewer_id);

COMMENT ON CONSTRAINT feedback_one_per_reviewer ON feedback IS
  'ADR-023: the handler treats feedback as one revisable row per reviewer, and '
  'the version column, read receipts and ETag all depend on that. Without this '
  'constraint a concurrent post inserts a second row, revisions land in the row '
  'the participant is not looking at, and section 5 of the brief happens.';
