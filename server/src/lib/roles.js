/**
 * ADR-028: the admin tier has two levels, admin and super_admin.
 *
 * super_admin is a superset: everywhere a plain admin was previously
 * allowed, a super admin is allowed too. The one place they differ is
 * assigning roles (see admin.routes.js), where only a super admin may
 * grant or revoke admin-tier access. Centralising the membership test
 * here means that distinction lives in exactly one place instead of
 * being reimplemented, slightly differently, at every call site that
 * used to just write `=== 'admin'`.
 */
export const ADMIN_ROLES = ['admin', 'super_admin'];

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}
