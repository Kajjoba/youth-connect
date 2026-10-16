-- =====================================================================
-- 011: comments scoped to a specific lesson item, not just the activity
--
-- DESIGN DECISION (ADR-027): a lesson comment is a discussion_thread
-- with a lesson_item_id, not a new table.
--
-- Discussion already has the right shape: a thread, posts hung off it,
-- a reply_count kept current by trigger, an authorisation path through
-- enrolment. A separate "lesson_comments" table would duplicate every
-- one of those and then need its own copy of each, which is exactly the
-- kind of parallel structure that drifts out of sync with the original.
--
-- Instead, discussion_threads gets one new nullable column. A thread
-- with lesson_item_id NULL is an activity-wide discussion, exactly as
-- before; a thread with it set is scoped to one lesson item, and reads
-- as a comment thread under that item rather than a forum topic. The
-- existing activity_id stays NOT NULL on every thread (comments still
-- belong to one activity), so every authorisation check already written
-- against activity_id continues to work unchanged for both kinds.
-- =====================================================================

ALTER TABLE discussion_threads
  ADD COLUMN lesson_item_id UUID REFERENCES lesson_items(id) ON DELETE CASCADE;

-- Looked up by item far more often than by activity once a course has
-- any content, so this is the index that matters for the comment view.
CREATE INDEX idx_threads_item ON discussion_threads (lesson_item_id, last_post_at DESC)
  WHERE lesson_item_id IS NOT NULL;

-- One comment thread per lesson item, enforced the same way ADR-023
-- enforces one feedback row per reviewer: the handler finds-or-creates
-- the thread in a single INSERT ... ON CONFLICT, which only works
-- because this constraint makes a second concurrent insert for the same
-- item impossible rather than merely unlikely. Partial, because every
-- activity-wide thread has lesson_item_id NULL and must not collide
-- with every other NULL.
CREATE UNIQUE INDEX idx_threads_one_per_item ON discussion_threads (lesson_item_id)
  WHERE lesson_item_id IS NOT NULL;

COMMENT ON COLUMN discussion_threads.lesson_item_id IS
  'ADR-027: NULL = an activity-wide discussion topic. Set = a comment thread '
  'scoped to one lesson item, shown inline under that item rather than in the '
  'activity''s Discussion tab.';
