-- =====================================================================
-- YouthConnect Platform (YCP) - Database Schema
-- MIT723 Web Application Engineering
--
-- DESIGN DECISION (ADR-001): The schema models the FULL programme
-- progression (Participant -> Team -> Project -> Tasks -> Milestones ->
-- Evidence -> Mentoring -> Assessment -> Validation -> Recognition) even
-- though CAT 1 only implements the Level One slice.
--
-- Rationale: a mid-semester data model rewrite is the single most common
-- cause of project failure. Level Two tables are created now and left
-- unused, so the Level Two extension adds behaviour without migrating
-- data. This is the evidence for the "responds to changing requirements"
-- evaluation criterion.
--
-- DESIGN DECISION (ADR-002): All primary keys are UUIDv4, never
-- sequential integers. Sequential IDs let an attacker enumerate
-- resources by incrementing a number in the URL, which is precisely the
-- incident described in the assessment brief. UUIDs raise the cost of
-- enumeration. They are a defence in depth measure only: the actual
-- authorisation check is enforced server side in every handler.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- ENUMERATED TYPES
-- ---------------------------------------------------------------------

CREATE TYPE user_role AS ENUM (
  'participant',
  'facilitator',
  'mentor',
  'admin',
  'stakeholder'
);

CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deactivated');

CREATE TYPE digital_literacy AS ENUM ('beginner', 'intermediate', 'advanced');

CREATE TYPE activity_type AS ENUM ('course', 'workshop', 'discussion', 'challenge');

CREATE TYPE activity_status AS ENUM ('draft', 'published', 'archived');

CREATE TYPE enrolment_status AS ENUM ('enrolled', 'in_progress', 'completed', 'withdrawn');

CREATE TYPE progress_status AS ENUM ('not_started', 'in_progress', 'completed');

CREATE TYPE assessment_type AS ENUM ('quiz', 'submission', 'reflection');

CREATE TYPE submission_status AS ENUM ('draft', 'submitted', 'under_review', 'graded', 'returned');

-- Level Two types, declared now, exercised in CAT 2
CREATE TYPE team_role AS ENUM ('lead', 'member', 'mentor', 'facilitator');
CREATE TYPE project_status AS ENUM ('proposed', 'approved', 'active', 'submitted', 'validated', 'archived');
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE recognition_kind AS ENUM ('badge', 'certificate', 'micro_credential');

-- ---------------------------------------------------------------------
-- IDENTITY AND ACCESS
-- REQ-SEC-001  Every account has exactly one role at the platform level.
-- REQ-SEC-002  Passwords are never stored in recoverable form.
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            user_role NOT NULL DEFAULT 'participant',
  status          user_status NOT NULL DEFAULT 'pending',
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role_status ON users (role, status);

-- REQ-SEC-003  Sessions use short-lived access tokens with rotating
-- refresh tokens. Refresh tokens are stored hashed so a database leak
-- does not yield usable sessions.
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  replaced_by   UUID REFERENCES refresh_tokens(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- PARTICIPANT PROFILE
-- REQ-FUN-002  Participants create a profile after registration.
-- The digital_literacy field drives adaptive UI: beginners receive
-- extra guidance, advanced users get a denser interface.
-- ---------------------------------------------------------------------

CREATE TABLE profiles (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name           TEXT NOT NULL,
  country             CHAR(2) NOT NULL,          -- ISO 3166-1 alpha-2
  date_of_birth       DATE,
  phone               TEXT,
  bio                 TEXT,
  headline            TEXT,
  disciplines         TEXT[] NOT NULL DEFAULT '{}',
  skills              TEXT[] NOT NULL DEFAULT '{}',
  languages           TEXT[] NOT NULL DEFAULT '{}',
  education_level     TEXT,
  employment_status   TEXT,
  digital_literacy    digital_literacy NOT NULL DEFAULT 'intermediate',
  avatar_url          TEXT,
  low_bandwidth_mode  BOOLEAN NOT NULL DEFAULT FALSE,
  completeness        SMALLINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- REQ-FUN-001 restricts the programme to ages 18-35.
  CONSTRAINT profiles_age_range CHECK (
    date_of_birth IS NULL OR
    (date_of_birth <= (CURRENT_DATE - INTERVAL '18 years')
     AND date_of_birth >= (CURRENT_DATE - INTERVAL '36 years'))
  )
);

CREATE INDEX idx_profiles_country ON profiles (country);
CREATE INDEX idx_profiles_disciplines ON profiles USING GIN (disciplines);

-- ---------------------------------------------------------------------
-- LEARNING ACTIVITIES
-- REQ-FUN-003  Participants discover and filter activities.
-- REQ-FUN-004  Facilitators author and publish activities.
-- ---------------------------------------------------------------------

CREATE TABLE activities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  description        TEXT,
  type               activity_type NOT NULL DEFAULT 'course',
  status             activity_status NOT NULL DEFAULT 'draft',
  facilitator_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  capacity           INTEGER,
  estimated_minutes  INTEGER NOT NULL DEFAULT 60,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  -- REQ-NFR-004: content authors declare a data weight so the client can
  -- warn users on metered connections before they open heavy material.
  payload_kb         INTEGER NOT NULL DEFAULT 0,
  opens_at           TIMESTAMPTZ,
  closes_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_activities_discovery ON activities (status, opens_at DESC);
CREATE INDEX idx_activities_facilitator ON activities (facilitator_id);
CREATE INDEX idx_activities_tags ON activities USING GIN (tags);

CREATE TABLE activity_modules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id        UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  position           SMALLINT NOT NULL,
  title              TEXT NOT NULL,
  body               TEXT,
  resource_url       TEXT,
  estimated_minutes  INTEGER NOT NULL DEFAULT 15,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (activity_id, position)
);

-- ---------------------------------------------------------------------
-- ENROLMENT AND PROGRESS
-- REQ-FUN-005  A participant enrols once per activity.
-- ---------------------------------------------------------------------

CREATE TABLE enrolments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id   UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  status        enrolment_status NOT NULL DEFAULT 'enrolled',
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  UNIQUE (user_id, activity_id)
);

CREATE INDEX idx_enrolments_user ON enrolments (user_id, status);
CREATE INDEX idx_enrolments_activity ON enrolments (activity_id, status);

CREATE TABLE module_progress (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrolment_id  UUID NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  module_id     UUID NOT NULL REFERENCES activity_modules(id) ON DELETE CASCADE,
  status        progress_status NOT NULL DEFAULT 'not_started',
  seconds_spent INTEGER NOT NULL DEFAULT 0,
  completed_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (enrolment_id, module_id)
);

-- ---------------------------------------------------------------------
-- DISCUSSION
-- REQ-FUN-006  Participants discuss within an activity they are enrolled in.
-- ---------------------------------------------------------------------

CREATE TABLE discussion_threads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id   UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  is_locked     BOOLEAN NOT NULL DEFAULT FALSE,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  last_post_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_threads_activity ON discussion_threads (activity_id, last_post_at DESC);

CREATE TABLE discussion_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       UUID NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
  parent_post_id  UUID REFERENCES discussion_posts(id) ON DELETE CASCADE,
  author_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  edited_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_posts_thread ON discussion_posts (thread_id, created_at);

-- ---------------------------------------------------------------------
-- ASSESSMENT AND FEEDBACK
-- REQ-FUN-007  Participants complete assessments.
-- REQ-FUN-008  Facilitators grade and return feedback.
-- ---------------------------------------------------------------------

CREATE TABLE assessments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id   UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  instructions  TEXT,
  type          assessment_type NOT NULL DEFAULT 'quiz',
  max_score     NUMERIC(6,2) NOT NULL DEFAULT 100,
  pass_score    NUMERIC(6,2) NOT NULL DEFAULT 50,
  max_attempts  SMALLINT NOT NULL DEFAULT 1,
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assessments_activity ON assessments (activity_id);

CREATE TABLE assessment_questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position       SMALLINT NOT NULL,
  prompt         TEXT NOT NULL,
  -- options is [{ "key": "a", "text": "..." }]. correct_key is NEVER sent
  -- to a participant client: the serialiser strips it. Marking happens
  -- server side only.
  options        JSONB NOT NULL DEFAULT '[]'::jsonb,
  correct_key    TEXT,
  points         NUMERIC(6,2) NOT NULL DEFAULT 1,
  UNIQUE (assessment_id, position)
);

CREATE TABLE submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id  UUID NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt        SMALLINT NOT NULL DEFAULT 1,
  answers        JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_url   TEXT,
  status         submission_status NOT NULL DEFAULT 'draft',
  score          NUMERIC(6,2),
  submitted_at   TIMESTAMPTZ,
  graded_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, user_id, attempt)
);

CREATE INDEX idx_submissions_user ON submissions (user_id, status);
CREATE INDEX idx_submissions_assessment ON submissions (assessment_id, status);

-- INCIDENT DEFENCE 1 (brief section 5: "One member cannot see the
-- updated feedback").
--
-- Feedback is VERSIONED and carries its own updated_at. A client holding
-- a cached copy compares the version, not the body. Feedback that has
-- been revised produces a new version number, which invalidates every
-- cached copy deterministically rather than relying on a time-to-live
-- guess. visible_from lets a facilitator draft feedback and release it
-- to the whole cohort at one moment, so no participant sees a partially
-- released comment.
CREATE TABLE feedback (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body           TEXT NOT NULL,
  rubric         JSONB NOT NULL DEFAULT '{}'::jsonb,
  version        INTEGER NOT NULL DEFAULT 1,
  visible_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_submission ON feedback (submission_id, version DESC);

-- Read receipts close the loop: the facilitator can see who has actually
-- opened the revised feedback, which turns "cannot see the feedback"
-- from an invisible failure into an observable one.
CREATE TABLE feedback_receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id    UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_seen   INTEGER NOT NULL,
  read_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feedback_id, user_id, version_seen)
);

-- ---------------------------------------------------------------------
-- NOTIFICATIONS AND AUDIT
-- ---------------------------------------------------------------------

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_unread ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- INCIDENT DEFENCE 2 (brief section 5: "Another user changes a project
-- identifier in the browser and gains access to information belonging to
-- another team").
--
-- Every authorisation decision, allowed or denied, is written here. A
-- denied decision is the forensic record of an enumeration attempt. In
-- the CAT 2 defence this table is the evidence that the attack was both
-- blocked and detected, rather than merely blocked.
CREATE TABLE access_audit (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_id    TEXT,
  allowed        BOOLEAN NOT NULL,
  reason         TEXT,
  ip_address     INET,
  user_agent     TEXT,
  request_id     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_denied ON access_audit (created_at DESC) WHERE allowed = FALSE;
CREATE INDEX idx_audit_actor ON access_audit (actor_id, created_at DESC);

-- =====================================================================
-- LEVEL TWO TABLES
-- Created now, unused until CAT 2. See ADR-001.
-- =====================================================================

CREATE TABLE teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  mission       TEXT,
  countries     CHAR(2)[] NOT NULL DEFAULT '{}',
  is_open       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        team_role NOT NULL DEFAULT 'member',
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ,
  UNIQUE (team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members (user_id) WHERE left_at IS NULL;

CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  problem       TEXT,
  solution      TEXT,
  sdg_tags      TEXT[] NOT NULL DEFAULT '{}',
  status        project_status NOT NULL DEFAULT 'proposed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_team ON projects (team_id);

CREATE TABLE milestones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  due_at      TIMESTAMPTZ,
  achieved_at TIMESTAMPTZ,
  position    SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE project_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id  UUID REFERENCES milestones(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  assignee_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  status        task_status NOT NULL DEFAULT 'todo',
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_evidence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id  UUID REFERENCES milestones(id) ON DELETE SET NULL,
  uploaded_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  bytes         BIGINT,
  checksum      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mentorships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mentor_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  UNIQUE (project_id, mentor_id)
);

CREATE TABLE stakeholder_validations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stakeholder_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verdict         TEXT NOT NULL,
  remarks         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recognitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,
  activity_id   UUID REFERENCES activities(id) ON DELETE SET NULL,
  kind          recognition_kind NOT NULL,
  title         TEXT NOT NULL,
  -- verification_code makes a credential independently checkable by an
  -- employer without an account on the platform.
  verification_code TEXT NOT NULL UNIQUE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_activities_touch BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Feedback revision bumps the version, which is what invalidates a
-- stale client cache. See INCIDENT DEFENCE 1 above.
CREATE OR REPLACE FUNCTION bump_feedback_version() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.rubric IS DISTINCT FROM OLD.rubric THEN
    NEW.version = OLD.version + 1;
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_feedback_version BEFORE UPDATE ON feedback
  FOR EACH ROW EXECUTE FUNCTION bump_feedback_version();

-- Keep thread counters current so the discussion list needs one query
-- instead of a correlated subquery per row. REQ-NFR-002.
CREATE OR REPLACE FUNCTION sync_thread_counters() RETURNS TRIGGER AS $$
BEGIN
  UPDATE discussion_threads
     SET reply_count  = (SELECT count(*) FROM discussion_posts WHERE thread_id = COALESCE(NEW.thread_id, OLD.thread_id)),
         last_post_at = now()
   WHERE id = COALESCE(NEW.thread_id, OLD.thread_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_posts_counters AFTER INSERT OR DELETE ON discussion_posts
  FOR EACH ROW EXECUTE FUNCTION sync_thread_counters();
