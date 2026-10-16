-- ADR-029: Sign in with Google.
--
-- Two changes to the identity model:
--
--   1. password_hash becomes OPTIONAL. An account that only ever signs
--      in through Google never has a password to hash, and storing a
--      random throwaway hash just to satisfy NOT NULL would be a fake
--      credential nobody can ever use to actually get in, which is
--      worse than having none.
--
--   2. google_sub records the stable account identifier Google puts in
--      a verified ID token's "sub" claim. It is NOT the email: Google
--      itself recommends sub as the durable key, because an email
--      address can be changed or reused while sub cannot. It is what
--      this platform actually trusts; the email on the account is a
--      convenience that rides along with it.
--
-- The CHECK constraint keeps the one invariant that actually matters:
-- every account must have SOME way to prove it is them, password or
-- Google, never neither.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN google_sub TEXT UNIQUE;

ALTER TABLE users ADD CONSTRAINT users_has_credential
  CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);

COMMENT ON COLUMN users.google_sub IS
  'ADR-029: the "sub" claim from a verified Google ID token. NULL for '
  'a password-only account. Unique: one Google account cannot become '
  'the second holder of a different YCP account.';
