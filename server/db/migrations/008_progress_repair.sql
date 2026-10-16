-- =====================================================================
-- 008: the rollup repairs missing progress rows
--
-- DEFECT, found by the test suite rather than by reading the code.
--
-- recalculate_progress computed module completion with an UPDATE
-- against module_progress, and counted modules by counting the rows in
-- that table. Both assume a row exists for every module the
-- participant is enrolled in.
--
-- When the rows are missing, the UPDATE matches nothing, the count
-- returns zero, the `IF module_total > 0` guard fails, and the
-- enrolment can NEVER complete. Silently. The participant finishes
-- every item, sees everything ticked, and the course stays open
-- forever with no error anywhere.
--
-- The rows go missing in more ways than one:
--
--   a module added to a course AFTER someone enrolled (the item
--   endpoint backfills item_progress but nothing backfilled
--   module_progress);
--
--   any code path that creates an enrolment without remembering to
--   seed progress rows, which is a thing a future handler, a repair
--   script or a test can easily do;
--
--   a partial delete or a restore from a backup taken mid-write.
--
-- =====================================================================
-- DESIGN DECISION (ADR-021): derive the denominator, do not trust it.
--
-- The rollup now counts modules from activity_modules, which is the
-- definition of how many modules a course has, and UPSERTS
-- module_progress instead of updating it. A missing row is created on
-- the spot with the right status.
--
-- The principle generalises past this bug. module_progress is a CACHE
-- of something derivable from item_progress. Reading a cache as if it
-- were the source of truth means an incomplete cache reads as
-- incomplete truth, and here that meant "you have not finished" to
-- someone who had. Anything derived should be recomputed from its
-- source, and a cache should be repaired when it disagrees.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A module with NO items cannot be completed by finishing its items.
--
-- The old inline rollup treated an empty module as complete, because
-- zero required items means zero remaining. That is wrong once items
-- exist as a concept: an empty module is unfinished content, not
-- finished work, and treating it as done would hand out certificates
-- for courses nobody could have read.
--
-- The `counts.total > 0` condition above handles it. A course that is
-- still being authored simply cannot be completed yet, which is the
-- honest answer.
--
-- The exception is a course written before items existed at all, where
-- modules legitimately carry their content in module.body. Those are
-- still driven by the module-progress endpoint, which writes the
-- status directly, and the UPSERT above would overwrite it with
-- 'not_started'. So: only recompute a module that HAS items.
-- ---------------------------------------------------------------------

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

  INSERT INTO module_progress (enrolment_id, module_id, status, completed_at)
  SELECT target_enrolment,
         m.id,
         (CASE WHEN counts.remaining = 0 THEN 'completed'
               WHEN counts.started > 0   THEN 'in_progress'
               ELSE 'not_started' END)::progress_status,
         CASE WHEN counts.remaining = 0 THEN now() ELSE NULL END
    FROM activity_modules m
    JOIN LATERAL (
      SELECT count(li.id)::int AS total,
             count(*) FILTER (
               WHERE li.is_required
                 AND COALESCE(ip.status, 'not_started') <> 'completed'
             )::int AS remaining,
             count(*) FILTER (
               WHERE COALESCE(ip.status, 'not_started') <> 'not_started'
             )::int AS started
        FROM lesson_items li
        LEFT JOIN item_progress ip
               ON ip.item_id = li.id AND ip.enrolment_id = target_enrolment
       WHERE li.module_id = m.id
    ) AS counts ON TRUE
   WHERE m.activity_id = target_activity
     -- Only modules that HAVE items are driven by their items. A module
     -- from before the item model keeps whatever the module-progress
     -- endpoint set, rather than being reset to not_started here.
     AND counts.total > 0
  ON CONFLICT (enrolment_id, module_id) DO UPDATE
    SET status = EXCLUDED.status,
        completed_at = CASE
          WHEN EXCLUDED.status = 'completed'
            THEN COALESCE(module_progress.completed_at, now())
          ELSE NULL END,
        updated_at = now();

  -- Modules with no items still need a row to be counted against, so
  -- create any that are missing, left at not_started.
  INSERT INTO module_progress (enrolment_id, module_id, status)
  SELECT target_enrolment, m.id, 'not_started'
    FROM activity_modules m
   WHERE m.activity_id = target_activity
  ON CONFLICT (enrolment_id, module_id) DO NOTHING;

  SELECT count(*)::int INTO module_total
    FROM activity_modules WHERE activity_id = target_activity;

  SELECT count(*)::int INTO module_done
    FROM module_progress mp
    JOIN activity_modules m ON m.id = mp.module_id
   WHERE mp.enrolment_id = target_enrolment
     AND m.activity_id = target_activity
     AND mp.status = 'completed';

  IF module_total > 0 AND module_total = module_done THEN
    UPDATE enrolments
       SET status = 'completed', completed_at = COALESCE(completed_at, now())
     WHERE id = target_enrolment;

    PERFORM issue_certificate_if_earned(target_user, target_activity);
  ELSE
    UPDATE enrolments
       SET status = 'in_progress', started_at = COALESCE(started_at, now())
     WHERE id = target_enrolment AND status = 'enrolled';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- REPAIR
--
-- Recalculate every live enrolment. Anyone whose progress rows were
-- missing gets them, and anyone who had actually finished gets the
-- completion and the certificate they were silently denied.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  row_enrolment RECORD;
BEGIN
  FOR row_enrolment IN
    SELECT id FROM enrolments WHERE status <> 'withdrawn'
  LOOP
    PERFORM recalculate_progress(row_enrolment.id);
  END LOOP;
END $$;
