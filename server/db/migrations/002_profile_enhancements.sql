-- =====================================================================
-- 002: profile enhancements
--
-- Avatar storage, a curated disciplines vocabulary, and a record of
-- password changes.
--
-- Note what this migration does NOT do: it does not touch 001. The
-- ledger in schema_migrations means 001 has already run everywhere, so
-- editing it would make environments silently disagree. Additive
-- forward migrations are the whole point of ADR-010, and this file is
-- the first demonstration of it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- AVATARS
--
-- DESIGN DECISION (ADR-014): avatars are stored as bytes in Postgres,
-- not on a filesystem or in object storage.
--
-- A filesystem does not survive a Render redeploy, which rebuilds the
-- container. Object storage is the right answer at scale but adds a
-- second service, a second set of credentials and a second failure mode
-- for what is, after client-side downscaling, about 6 KB per user.
-- 4,000 participants is roughly 24 MB, which Postgres handles without
-- noticing.
--
-- They live in their own table rather than a column on profiles so that
-- SELECTing a profile never drags the image bytes along with it. That
-- matters: the progress dashboard reads profiles and has no use for
-- avatar data.
-- ---------------------------------------------------------------------

CREATE TABLE avatars (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  byte_size   INTEGER NOT NULL,
  checksum    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- SVG is deliberately excluded. An SVG can contain <script>, and an
  -- avatar served from our own origin would execute in our security
  -- context: a stored cross-site scripting vector delivered through a
  -- profile picture. Raster formats cannot do this.
  CONSTRAINT avatars_safe_type CHECK (mime_type IN ('image/webp', 'image/jpeg', 'image/png')),

  -- Server-side ceiling, independent of whatever the client claims.
  -- Client-side downscaling produces about 6 KB; 256 KB is generous
  -- headroom while still bounding a malicious upload.
  CONSTRAINT avatars_size_limit CHECK (byte_size > 0 AND byte_size <= 262144)
);

-- ---------------------------------------------------------------------
-- DISCIPLINES
--
-- Free-text disciplines cannot be matched on. "Software Development",
-- "software dev", "Softwre Development" and "coding" are four different
-- strings describing one thing, and Level Two has to build
-- multidisciplinary teams by finding people who complement each other.
-- A controlled vocabulary makes that a real query instead of a guess.
--
-- The brief's own example names agriculture, software development, data
-- analysis and environmental studies, so those anchor the list.
-- ---------------------------------------------------------------------

CREATE TABLE disciplines (
  slug        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL,
  position    SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO disciplines (slug, label, category, position) VALUES
  ('agriculture',            'Agriculture and agribusiness',   'Land and environment', 1),
  ('environmental-studies',  'Environmental studies',          'Land and environment', 2),
  ('water-sanitation',       'Water and sanitation',           'Land and environment', 3),
  ('renewable-energy',       'Renewable energy',               'Land and environment', 4),

  ('software-development',   'Software development',           'Technology',           10),
  ('data-analysis',          'Data analysis',                  'Technology',           11),
  ('cybersecurity',          'Cybersecurity',                  'Technology',           12),
  ('design-ux',              'Design and user experience',     'Technology',           13),
  ('telecommunications',     'Telecommunications',             'Technology',           14),

  ('public-health',          'Public health',                  'Health and wellbeing', 20),
  ('nursing-medicine',       'Nursing and medicine',           'Health and wellbeing', 21),
  ('nutrition',              'Nutrition and food security',    'Health and wellbeing', 22),
  ('mental-health',          'Mental health and counselling',  'Health and wellbeing', 23),

  ('business',               'Business and entrepreneurship',  'Business and finance', 30),
  ('finance',                'Finance and accounting',         'Business and finance', 31),
  ('supply-chain',           'Supply chain and logistics',     'Business and finance', 32),
  ('marketing',              'Marketing and communications',   'Business and finance', 33),

  ('education',              'Education and training',         'Society',              40),
  ('law-policy',             'Law and public policy',          'Society',              41),
  ('social-work',            'Social work and community',      'Society',              42),
  ('journalism',             'Journalism and media',           'Society',              43),
  ('arts-culture',           'Arts and culture',               'Society',              44),

  ('engineering-civil',      'Civil engineering',              'Engineering',          50),
  ('engineering-mechanical', 'Mechanical engineering',         'Engineering',          51),
  ('engineering-electrical', 'Electrical engineering',         'Engineering',          52),
  ('architecture',           'Architecture and planning',      'Engineering',          53);

CREATE INDEX idx_disciplines_order ON disciplines (position);

-- ---------------------------------------------------------------------
-- PASSWORD CHANGE HISTORY
--
-- Not the passwords themselves, only the fact and time of each change.
-- If an account is later disputed or compromised, "when was the
-- password last changed, and from where" is the first question, and
-- without this there is no answer.
-- ---------------------------------------------------------------------

CREATE TABLE password_changes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address  INET,
  user_agent  TEXT
);

CREATE INDEX idx_password_changes_user ON password_changes (user_id, changed_at DESC);
