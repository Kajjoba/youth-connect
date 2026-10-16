-- ADR-028 continued: without this, the new super-admin gate would lock
-- everyone out of it, since no account would hold the role that is
-- allowed to grant it. The longest-standing active admin is promoted
-- automatically so the migration is safe to run unattended; a real
-- deployment can then promote or demote further accounts from the
-- admin panel itself, as a super admin.
UPDATE users SET role = 'super_admin'
 WHERE id = (
   SELECT id FROM users
    WHERE role = 'admin' AND status = 'active'
    ORDER BY created_at ASC
    LIMIT 1
 );
