-- =====================================================================
-- 006: assessments complete the items that point at them
--
-- DEFECT. A participant could complete every reading in a course, take
-- the quiz, PASS it, and still be told "finish every required section
-- first". No certificate, no explanation that made sense to them.
--
-- The cause: submitting an assessment and completing a lesson item were
-- two unconnected code paths. lesson_items of kind 'quiz' carry an
-- assessment_id, but POST /assessments/:id/submissions never looked at
-- lesson_items at all. The quiz item sat at 'not_started' forever, so
-- the module never completed, so the enrolment never completed, so
-- issue_certificate_if_earned always returned NULL.
--
-- Everything worked in isolation. The join between them did not exist.
--
-- =====================================================================
-- DESIGN DECISION (ADR-019): progress rollup lives in ONE database
-- function, called from every path that can change progress.
--
-- The rollup was already written once, inline, in the item-progress
-- handler. The obvious fix for this defect was to write it a second
-- time in the assessment handler. Two copies of "what counts as
-- finished" would drift the first time either was edited, and the
-- symptom of that drift is a participant who has finished a course the
-- system thinks they have not.
--
-- This is the same reasoning as issue_certificate_if_earned in
-- migration 004: a rule about what the data means belongs with the
-- data, not in whichever handler happens to run.
-- =====================================================================

CREATE OR REPLACE FUNCTION recalculate_progress(target_enrolment UUID)
RETURNS void AS $$
DECLARE
  target_user     UUID;
  target_activity UUID;
  module_total    INTEGER;
  module_done     INTEGER;
BEGIN
  SELECT user_id, activity_id INTO target_user, target_activity
    FROM enrolments WHERE id = target_enrolment;
  IF NOT FOUND THEN RETURN; END IF;

  -- Modules roll up from their REQUIRED items. Optional items are
  -- excluded so a bonus reading cannot block someone from finishing.
  UPDATE module_progress mp
     SET status = (CASE WHEN done.remaining = 0 THEN 'completed'
                        WHEN done.started > 0   THEN 'in_progress'
                        ELSE 'not_started' END)::progress_status,
         completed_at = CASE WHEN done.remaining = 0
                             THEN COALESCE(mp.completed_at, now()) ELSE NULL END,
         updated_at = now()
    FROM (
      SELECT li.module_id,
             count(*) FILTER (
               WHERE li.is_required AND COALESCE(ip.status, 'not_started') <> 'completed'
             )::int AS remaining,
             count(*) FILTER (
               WHERE COALESCE(ip.status, 'not_started') <> 'not_started'
             )::int AS started
        FROM lesson_items li
        LEFT JOIN item_progress ip
               ON ip.item_id = li.id AND ip.enrolment_id = target_enrolment
       GROUP BY li.module_id
    ) AS done
   WHERE mp.enrolment_id = target_enrolment AND mp.module_id = done.module_id;

  SELECT count(*)::int, count(*) FILTER (WHERE status = 'completed')::int
    INTO module_total, module_done
    FROM module_progress WHERE enrolment_id = target_enrolment;

  IF module_total > 0 AND module_total = module_done THEN
    UPDATE enrolments
       SET status = 'completed', completed_at = COALESCE(completed_at, now())
     WHERE id = target_enrolment;

    -- Issuing here rather than in the caller means a certificate is
    -- earned the moment the last requirement is met, whichever path
    -- met it: finishing a reading, or passing the final quiz.
    PERFORM issue_certificate_if_earned(target_user, target_activity);
  ELSE
    UPDATE enrolments
       SET status = 'in_progress', started_at = COALESCE(started_at, now())
     WHERE id = target_enrolment AND status = 'enrolled';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- SUBMITTING AN ASSESSMENT COMPLETES ITS ITEM
--
-- What counts as "done" differs by assessment type, and the difference
-- matters to the participant:
--
--   quiz (marked automatically): done when they PASS. Failing with
--   attempts remaining leaves it open, which is correct: they have not
--   yet demonstrated the thing the item exists to demonstrate.
--
--   submission and reflection (marked by a facilitator): done when they
--   SUBMIT. The participant has finished their part, and their course
--   progress should not hang on how quickly someone else grades. The
--   certificate is still withheld until the grade arrives, because
--   issue_certificate_if_earned checks pass marks separately. So the
--   progress bar is honest and the credential is still earned.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_assessment_item_progress() RETURNS TRIGGER AS $$
DECLARE
  assessment_row  assessments%ROWTYPE;
  enrolment_row   enrolments%ROWTYPE;
  earned          BOOLEAN;
BEGIN
  IF NEW.status = 'draft' THEN RETURN NULL; END IF;

  SELECT * INTO assessment_row FROM assessments WHERE id = NEW.assessment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO enrolment_row
    FROM enrolments
   WHERE user_id = NEW.user_id AND activity_id = assessment_row.activity_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  earned := CASE
    WHEN assessment_row.type = 'quiz'
      THEN NEW.score IS NOT NULL AND NEW.score >= assessment_row.pass_score
    ELSE TRUE
  END;

  IF earned THEN
    -- There may be more than one item pointing at the same assessment,
    -- for instance a quiz reused across modules. All of them complete.
    INSERT INTO item_progress (enrolment_id, item_id, status, completed_at)
    SELECT enrolment_row.id, li.id, 'completed', now()
      FROM lesson_items li
      JOIN activity_modules m ON m.id = li.module_id
     WHERE li.assessment_id = NEW.assessment_id
       AND m.activity_id = assessment_row.activity_id
    ON CONFLICT (enrolment_id, item_id) DO UPDATE
      SET status = 'completed',
          completed_at = COALESCE(item_progress.completed_at, now()),
          updated_at = now();
  END IF;

  -- Recalculate either way. A failed attempt still moves the enrolment
  -- from 'enrolled' to 'in_progress', which is true and useful.
  PERFORM recalculate_progress(enrolment_row.id);

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_submission_completes_item
  AFTER INSERT OR UPDATE OF status, score ON submissions
  FOR EACH ROW EXECUTE FUNCTION sync_assessment_item_progress();

-- ---------------------------------------------------------------------
-- A facilitator's grade can also be the last requirement.
--
-- Someone submits an assignment, finishes everything else, and waits.
-- When the grade lands and it is a pass, that is the moment they earn
-- the certificate. Without this they would have to revisit the course
-- and click something to trigger a recalculation, which nobody would
-- think to do.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION recalculate_on_grade() RETURNS TRIGGER AS $$
DECLARE
  target_activity UUID;
  enrolment_row   enrolments%ROWTYPE;
BEGIN
  SELECT a.activity_id INTO target_activity
    FROM assessments a
    JOIN submissions s ON s.assessment_id = a.id
   WHERE s.id = NEW.submission_id;

  SELECT e.* INTO enrolment_row
    FROM enrolments e
    JOIN submissions s ON s.user_id = e.user_id
   WHERE s.id = NEW.submission_id AND e.activity_id = target_activity;

  IF FOUND THEN
    PERFORM recalculate_progress(enrolment_row.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_feedback_recalculates
  AFTER INSERT OR UPDATE ON feedback
  FOR EACH ROW EXECUTE FUNCTION recalculate_on_grade();

-- ---------------------------------------------------------------------
-- REPAIR
--
-- Anyone already stuck in this state has met every requirement and is
-- holding no certificate. Recalculating every enrolment issues what
-- they already earned.
--
-- Safe to run against a populated database: recalculate_progress only
-- ever moves an enrolment towards the truth, and
-- issue_certificate_if_earned is idempotent and returns the existing
-- credential rather than minting a second one.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  row_enrolment RECORD;
BEGIN
  FOR row_enrolment IN
    SELECT s.user_id, a.activity_id, e.id AS enrolment_id
      FROM submissions s
      JOIN assessments a ON a.id = s.assessment_id
      JOIN enrolments e ON e.user_id = s.user_id AND e.activity_id = a.activity_id
     WHERE s.status <> 'draft'
       AND s.score IS NOT NULL
       AND s.score >= a.pass_score
  LOOP
    INSERT INTO item_progress (enrolment_id, item_id, status, completed_at)
    SELECT row_enrolment.enrolment_id, li.id, 'completed', now()
      FROM lesson_items li
      JOIN activity_modules m ON m.id = li.module_id
     WHERE m.activity_id = row_enrolment.activity_id
       AND li.assessment_id IN (
         SELECT id FROM assessments WHERE activity_id = row_enrolment.activity_id
       )
    ON CONFLICT (enrolment_id, item_id) DO UPDATE SET status = 'completed';

    PERFORM recalculate_progress(row_enrolment.enrolment_id);
  END LOOP;
END $$;
