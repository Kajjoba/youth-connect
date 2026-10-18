-- Weekly quizzes already fit this schema: a quiz is an assessment
-- attached to a module (activity_modules.week_offset) through a
-- lesson_item. What the model has never had is a way to mark ONE
-- assessment on a course as its capstone, the quiz whose pass/fail
-- decides the certificate rather than contributing to a general
-- "pass everything" rule.
--
-- is_final is that mark. At most one per activity, enforced by a
-- partial unique index rather than application code, because this is
-- the kind of invariant that must hold no matter which route writes
-- the row.
ALTER TABLE assessments ADD COLUMN is_final BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX idx_assessments_one_final_per_activity
  ON assessments (activity_id)
  WHERE is_final;

COMMENT ON COLUMN assessments.is_final IS
  'Marks the single capstone quiz for its activity. When one exists, '
  'issue_certificate_if_earned gates the certificate on passing THIS '
  'assessment specifically, not on passing every assessment. At most '
  'one true row per activity_id (partial unique index).';

-- issue_certificate_if_earned, re-defined to prefer the final
-- assessment when the facilitator has set one.
--
-- Backward compatible on purpose: an activity with no is_final row
-- (every activity that existed before this migration, and any new one
-- where nobody has designated a final quiz yet) keeps the exact
-- behaviour it had, pass every assessment on the course. Nothing that
-- already works today changes unless a facilitator opts in by
-- checking "final quiz" on one assessment.
CREATE OR REPLACE FUNCTION issue_certificate_if_earned(
  target_user UUID,
  target_activity UUID
) RETURNS UUID AS $$
DECLARE
  activity_row      activities%ROWTYPE;
  enrolment_row      enrolments%ROWTYPE;
  participant_name   TEXT;
  final_assessment   assessments%ROWTYPE;
  final_passed        BOOLEAN;
  assessments_total  INTEGER;
  assessments_passed INTEGER;
  best_score         NUMERIC;
  spent_hours        NUMERIC;
  existing           UUID;
  new_id             UUID;
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
    SELECT * INTO final_assessment
      FROM assessments
     WHERE activity_id = target_activity AND is_final
     LIMIT 1;

    IF FOUND THEN
      -- A capstone quiz exists for this course. It alone gates the
      -- certificate, the same way a real programme awards one on a
      -- final exam rather than on every weekly worksheet.
      SELECT EXISTS (
        SELECT 1 FROM submissions s
         WHERE s.assessment_id = final_assessment.id
           AND s.user_id = target_user
           AND s.score >= final_assessment.pass_score
      ) INTO final_passed;

      IF NOT final_passed THEN
        RETURN NULL;
      END IF;
    ELSE
      -- No capstone quiz designated yet: the original rule, pass
      -- every assessment the course has.
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
