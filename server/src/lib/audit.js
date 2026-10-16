import { query } from '../db.js';

/**
 * Every authorisation decision is recorded, allowed or denied.
 *
 * Why record allowed decisions too: a denial log alone tells you that
 * someone was blocked, but not whether an attacker had already succeeded
 * before the control was tightened. The full record is what makes the
 * audit trail usable as evidence.
 *
 * Writes are fire and forget. An audit failure must never break a
 * request that the authorisation layer has already approved, so the
 * promise is deliberately not awaited by callers and errors are swallowed
 * after being logged to stderr.
 */
export function recordAccess({
  actorId = null,
  action,
  resourceType,
  resourceId = null,
  allowed,
  reason = null,
  req = null
}) {
  const ip = req?.ip ?? null;
  const userAgent = req?.get?.('user-agent') ?? null;
  const requestId = req?.id ?? null;

  query(
    `INSERT INTO access_audit
       (actor_id, action, resource_type, resource_id, allowed, reason, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actorId, action, resourceType, resourceId, allowed, reason, ip, userAgent, requestId]
  ).catch((error) => {
    console.error('[audit] write failed', error.message);
  });
}

/**
 * Simple detection query for the CAT 2 defence: who is probing?
 *
 * A legitimate user produces essentially zero denials. A user generating
 * denials across many distinct resource identifiers in a short window is
 * enumerating. This is the query to run live in front of the review
 * committee after demonstrating the URL-tampering attack.
 */
export async function findEnumerationSuspects({ windowMinutes = 15, threshold = 5 } = {}) {
  const result = await query(
    `SELECT actor_id,
            resource_type,
            count(DISTINCT resource_id) AS distinct_targets,
            count(*)                    AS denied_attempts,
            min(created_at)             AS first_attempt,
            max(created_at)             AS last_attempt
       FROM access_audit
      WHERE allowed = FALSE
        AND created_at > now() - ($1 || ' minutes')::interval
      GROUP BY actor_id, resource_type
     HAVING count(DISTINCT resource_id) >= $2
      ORDER BY distinct_targets DESC`,
    [String(windowMinutes), threshold]
  );
  return result.rows;
}
