-- =====================================================================
-- 004: recognition and certificates
--
-- The brief's Level One journey ends at "monitor progress", but the
-- programme's stated purpose includes "recognition of participants'
-- learning and project achievements". A progress bar is not
-- recognition. Something a participant can show an employer is.
-- =====================================================================

-- ---------------------------------------------------------------------
-- WHAT AN ACTIVITY AWARDS
-- ---------------------------------------------------------------------

ALTER TABLE activities
  ADD COLUMN awards_certificate  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN certificate_title   TEXT,
  -- Completing the sections is not the same as demonstrating learning.
  -- When this is true, every assessment attached to the activity must
  -- also be passed before a certificate is issued.
  ADD COLUMN requires_pass       BOOLEAN NOT NULL DEFAULT TRUE;

-- ---------------------------------------------------------------------
-- THE CREDENTIAL ITSELF
--
-- recognitions already existed from migration 001. These columns make
-- an issued credential a self-contained, independently checkable record
-- rather than a pointer into live tables.
--
-- DESIGN DECISION (ADR-017): a certificate SNAPSHOTS the facts at the
-- moment of issue.
--
-- The obvious implementation joins recognitions to users and activities
-- when rendering. That produces a certificate whose text changes
-- retroactively: rename the course and every certificate ever issued
-- silently claims something different. A credential that can be edited
-- after the fact is not evidence of anything.
--
-- So the recipient's name, the activity title, the score and the hours
-- are copied in at issue time and never updated. If a participant later
-- changes their display name, their existing certificate keeps the name
-- it was awarded under, which is also what a registrar would do.
-- ---------------------------------------------------------------------

ALTER TABLE recognitions
  ADD COLUMN recipient_name   TEXT,
  ADD COLUMN activity_title   TEXT,
  ADD COLUMN score            NUMERIC(6,2),
  ADD COLUMN hours            NUMERIC(6,2),
  ADD COLUMN completed_at     TIMESTAMPTZ,
  ADD COLUMN issued_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN revoked_reason   TEXT;

-- One certificate per participant per activity. Without this, a
-- completion recalculated twice issues two credentials with two
-- verification codes for one achievement.
CREATE UNIQUE INDEX idx_recognitions_unique_award
  ON recognitions (user_id, activity_id, kind)
  WHERE activity_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX idx_recognitions_user ON recognitions (user_id, issued_at DESC);

-- ---------------------------------------------------------------------
-- VERIFICATION CODES
--
-- The code is what makes a certificate worth anything: an employer with
-- no account can check it.
--
-- Format YCP-XXXX-XXXX-XXXX from an alphabet that excludes 0, O, 1, I
-- and L. Someone will read this off a printed page and type it, and
-- those five characters are where transcription errors come from.
--
-- 26 characters over 12 positions is about 10^17 combinations, so codes
-- cannot be guessed at any useful rate. The verification endpoint is
-- rate limited as well, because an unauthenticated lookup is otherwise
-- an enumeration surface.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_verification_code() RETURNS TEXT AS $$
DECLARE
  alphabet TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result TEXT := 'YCP';
  i INTEGER;
BEGIN
  FOR block IN 1..3 LOOP
    result := result || '-';
    FOR i IN 1..4 LOOP
      result := result || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    END LOOP;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- ISSUANCE
--
-- Kept in the database as a function rather than in application code.
--
-- The rule "has this person earned a certificate" is a question about
-- data, and it has to give the same answer whether it is asked by the
-- completion handler, an administrator issuing manually, or a repair
-- script after an incident. Three copies of that rule in JavaScript
-- would drift. One function cannot.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION issue_certificate_if_earned(
  target_user UUID,
  target_activity UUID
) RETURNS UUID AS $$
DECLARE
  activity_row      activities%ROWTYPE;
  enrolment_row     enrolments%ROWTYPE;
  participant_name  TEXT;
  assessments_total INTEGER;
  assessments_passed INTEGER;
  best_score        NUMERIC;
  spent_hours       NUMERIC;
  existing          UUID;
  new_id            UUID;
BEGIN
  SELECT * INTO activity_row FROM activities WHERE id = target_activity;
  IF NOT FOUND OR NOT activity_row.awards_certificate THEN
    RETURN NULL;
  END IF;

  SELECT * INTO enrolment_row
    FROM enrolments
   WHERE user_id = target_user AND activity_id = target_activity;
  IF NOT FOUND OR enrolment_row.status <> 'completed' THEN
    RETURN NULL;
  END IF;

  -- Already issued: return the existing credential rather than minting
  -- a second one.
  SELECT id INTO existing
    FROM recognitions
   WHERE user_id = target_user AND activity_id = target_activity
     AND kind = 'certificate' AND revoked_at IS NULL;
  IF FOUND THEN
    RETURN existing;
  END IF;

  IF activity_row.requires_pass THEN
    SELECT count(*)::int INTO assessments_total
      FROM assessments WHERE activity_id = target_activity;

    SELECT count(DISTINCT a.id)::int INTO assessments_passed
      FROM assessments a
      JOIN submissions s ON s.assessment_id = a.id
     WHERE a.activity_id = target_activity
       AND s.user_id = target_user
       AND s.score >= a.pass_score;

    IF assessments_total > 0 AND assessments_passed < assessments_total THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT full_name INTO participant_name FROM profiles WHERE user_id = target_user;

  SELECT COALESCE(avg(best.score), NULL) INTO best_score
    FROM (
      SELECT max(s.score) AS score
        FROM submissions s
        JOIN assessments a ON a.id = s.assessment_id
       WHERE a.activity_id = target_activity AND s.user_id = target_user
       GROUP BY a.id
    ) AS best;

  SELECT ROUND(COALESCE(SUM(ip.seconds_spent), 0) / 3600.0, 1) INTO spent_hours
    FROM item_progress ip
   WHERE ip.enrolment_id = enrolment_row.id;

  IF spent_hours IS NULL OR spent_hours = 0 THEN
    spent_hours := ROUND(activity_row.estimated_minutes / 60.0, 1);
  END IF;

  INSERT INTO recognitions
    (user_id, activity_id, kind, title, verification_code,
     recipient_name, activity_title, score, hours, completed_at)
  VALUES
    (target_user, target_activity, 'certificate',
     COALESCE(activity_row.certificate_title, activity_row.title),
     generate_verification_code(),
     COALESCE(participant_name, 'Participant'),
     activity_row.title,
     best_score,
     spent_hours,
     COALESCE(enrolment_row.completed_at, now()))
  RETURNING id INTO new_id;

  INSERT INTO notifications (user_id, kind, payload)
  VALUES (target_user, 'certificate_issued',
          jsonb_build_object('recognitionId', new_id, 'activityId', target_activity));

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- Any activity that already exists when this migration runs gets
-- certificates enabled. Note that on a fresh database this matches
-- nothing, because migrations run before seeding: the seed script
-- enables the flag on the activities it creates. Both paths are needed,
-- and neither is a substitute for the other.
UPDATE activities SET awards_certificate = TRUE WHERE status = 'published';
