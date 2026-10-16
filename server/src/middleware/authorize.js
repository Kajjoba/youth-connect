import { queryOne } from '../db.js';
import { forbidden, notFound } from '../lib/errors.js';
import { recordAccess } from '../lib/audit.js';
import { isAdminRole } from '../lib/roles.js';

/**
 * =====================================================================
 * THE AUTHORISATION LAYER
 *
 * This file is the primary answer to the incident in section 5 of the
 * brief: "Another user changes a project identifier in the browser and
 * gains access to information belonging to another team."
 *
 * The vulnerability class is Insecure Direct Object Reference, OWASP
 * A01:2021 Broken Access Control. It happens when a handler trusts an
 * identifier supplied by the client and fetches the record without
 * asking whether this particular caller is entitled to it.
 *
 * The defence has to satisfy three properties:
 *
 *   1. It must be SERVER SIDE. Hiding a link in React hides the link,
 *      not the data. Anyone can type the URL.
 *
 *   2. It must be CENTRAL. A per-handler ownership check works until one
 *      handler is written in a hurry and forgets. There are roughly
 *      forty handlers in this system; expecting forty correct manual
 *      checks is not an engineering control, it is optimism. So every
 *      resource-scoped route declares a policy and the policy is
 *      enforced by middleware that runs before the handler.
 *
 *   3. It must be DEFAULT DENY. An unknown resource type or a missing
 *      policy denies. Adding a new resource without a policy makes it
 *      inaccessible, which is a loud, safe failure. The opposite default
 *      makes it world-readable, which is a silent, unsafe one.
 *
 * Note the interaction with ADR-005: a denial returns 404, not 403, so
 * the caller cannot use the status code to learn that the resource
 * exists. The audit row records the true reason.
 * =====================================================================
 */

/**
 * A resolver takes the caller and a resource id, and returns either
 * null (does not exist, or the caller may not know it exists) or an
 * object describing the caller's relationship to that resource.
 *
 * Each resolver is a SINGLE query that joins ownership into the lookup.
 * Fetching the row first and checking ownership afterwards is a common
 * pattern and a bad one: it means the record has already been read into
 * memory, and one careless `res.json(row)` in an error branch leaks it.
 */
const resolvers = {
  /** A participant owns their own profile. Facilitators and admins may read any. */
  async profile(user, id) {
    const row = await queryOne(
      `SELECT user_id FROM profiles WHERE user_id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      isOwner: row.user_id === user.id,
      exists: true
    };
  },

  /** An activity is readable when published, writable by its facilitator. */
  async activity(user, id) {
    const row = await queryOne(
      `SELECT a.id,
              a.status,
              a.facilitator_id,
              EXISTS (
                SELECT 1 FROM enrolments e
                 WHERE e.activity_id = a.id AND e.user_id = $2
              ) AS is_enrolled
         FROM activities a
        WHERE a.id = $1`,
      [id, user.id]
    );
    if (!row) return null;
    return {
      isOwner: row.facilitator_id === user.id,
      isEnrolled: row.is_enrolled,
      isPublished: row.status === 'published',
      exists: true
    };
  },

  /** An enrolment belongs to one participant and to one activity's facilitator. */
  async enrolment(user, id) {
    const row = await queryOne(
      `SELECT e.id, e.user_id, a.facilitator_id
         FROM enrolments e
         JOIN activities a ON a.id = e.activity_id
        WHERE e.id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      isOwner: row.user_id === user.id,
      isFacilitator: row.facilitator_id === user.id,
      exists: true
    };
  },

  /** A submission belongs to its author; the activity facilitator may grade it. */
  async submission(user, id) {
    const row = await queryOne(
      `SELECT s.id, s.user_id, a.facilitator_id
         FROM submissions s
         JOIN assessments asm ON asm.id = s.assessment_id
         JOIN activities a    ON a.id   = asm.activity_id
        WHERE s.id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      isOwner: row.user_id === user.id,
      isFacilitator: row.facilitator_id === user.id,
      exists: true
    };
  },

  /** A discussion post is editable by its author, moderatable by the facilitator. */
  async post(user, id) {
    const row = await queryOne(
      `SELECT p.id, p.author_id, a.facilitator_id
         FROM discussion_posts p
         JOIN discussion_threads t ON t.id = p.thread_id
         JOIN activities a         ON a.id = t.activity_id
        WHERE p.id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      isOwner: row.author_id === user.id,
      isFacilitator: row.facilitator_id === user.id,
      exists: true
    };
  },

  /**
   * LEVEL TWO. Unused in CAT 1, present so the extension adds no new
   * authorisation mechanism, only a new resolver.
   *
   * This is the exact resolver that defeats the brief's incident. Note
   * that team membership is joined into the lookup: a project id that
   * belongs to another team simply does not resolve for this caller, so
   * no row is ever loaded.
   */
  async project(user, id) {
    const row = await queryOne(
      `SELECT p.id,
              tm.role       AS member_role,
              m.mentor_id   AS mentor_id
         FROM projects p
         LEFT JOIN team_members tm
                ON tm.team_id = p.team_id
               AND tm.user_id = $2
               AND tm.left_at IS NULL
         LEFT JOIN mentorships m
                ON m.project_id = p.id
               AND m.mentor_id  = $2
               AND m.ended_at IS NULL
        WHERE p.id = $1`,
      [id, user.id]
    );
    if (!row) return null;
    return {
      isMember: Boolean(row.member_role),
      isLead: row.member_role === 'lead',
      isMentor: Boolean(row.mentor_id),
      exists: true
    };
  }
};

/**
 * Policies map an action to a predicate over the resolved relationship.
 * Read top to bottom as a sentence: "a participant may read an activity
 * if it is published or they are enrolled".
 */
const policies = {
  'profile:read': (user, rel) =>
    rel.isOwner || user.role === 'facilitator' || isAdminRole(user.role),
  'profile:update': (user, rel) => rel.isOwner || isAdminRole(user.role),

  'activity:read': (user, rel) =>
    rel.isPublished || rel.isOwner || isAdminRole(user.role),
  'activity:update': (user, rel) => rel.isOwner || isAdminRole(user.role),
  'activity:delete': (user, rel) => rel.isOwner || isAdminRole(user.role),
  'activity:participate': (user, rel) => rel.isEnrolled || rel.isOwner,

  'enrolment:read': (user, rel) =>
    rel.isOwner || rel.isFacilitator || isAdminRole(user.role),
  'enrolment:withdraw': (user, rel) => rel.isOwner,

  'submission:read': (user, rel) =>
    rel.isOwner || rel.isFacilitator || isAdminRole(user.role),
  'submission:update': (user, rel) => rel.isOwner,
  'submission:grade': (user, rel) => rel.isFacilitator || isAdminRole(user.role),

  'post:update': (user, rel) => rel.isOwner,
  'post:delete': (user, rel) =>
    rel.isOwner || rel.isFacilitator || isAdminRole(user.role),

  // Level Two
  'project:read': (user, rel) =>
    rel.isMember || rel.isMentor || isAdminRole(user.role) || user.role === 'stakeholder',
  'project:update': (user, rel) => rel.isLead || rel.isMember,
  'project:manage': (user, rel) => rel.isLead || isAdminRole(user.role)
};

/**
 * Route-level middleware.
 *
 * Usage:
 *   router.get('/:id', authenticate, can('activity:read'), handler)
 *
 * On success it attaches req.resourceRelation so the handler can shape
 * the response without repeating the lookup, for example hiding a
 * grading panel from a participant.
 */
export function can(action, { param = 'id' } = {}) {
  const [resourceType] = action.split(':');

  return async function authorizeMiddleware(req, res, next) {
    const user = req.user;
    const resourceId = req.params[param];

    const deny = (reason, error) => {
      recordAccess({
        actorId: user?.id ?? null,
        action,
        resourceType,
        resourceId,
        allowed: false,
        reason,
        req
      });
      return next(error);
    };

    if (!user) return deny('unauthenticated', notFound());

    const resolve = resolvers[resourceType];
    const policy = policies[action];

    // Default deny. A missing policy is a programming error and must not
    // silently permit the request.
    if (!resolve || !policy) {
      console.error(`[authz] no policy or resolver for "${action}"`);
      return deny('no_policy', notFound());
    }

    let relation;
    try {
      relation = await resolve(user, resourceId);
    } catch (error) {
      // A malformed UUID makes Postgres throw. That is an enumeration
      // attempt with a garbage id, not a server fault.
      if (error.code === '22P02') return deny('malformed_id', notFound());
      return next(error);
    }

    if (!relation) return deny('resource_absent', notFound());

    if (!policy(user, relation)) {
      // THIS is the line that stops the incident in the brief.
      // The resource exists, the caller is authenticated, and they are
      // still refused, because entitlement is evaluated against the
      // caller's actual relationship to the record rather than against
      // their possession of its identifier.
      return deny('policy_denied', notFound());
    }

    recordAccess({
      actorId: user.id,
      action,
      resourceType,
      resourceId,
      allowed: true,
      req
    });

    req.resourceRelation = relation;
    return next();
  };
}

/**
 * Coarse role gate for routes that are not scoped to a single record,
 * for example "list all participants". Use alongside can(), not instead
 * of it: a role check answers "what kind of user", never "whose data".
 */
export function requireRole(...roles) {
  return function roleGate(req, res, next) {
    if (!req.user) return next(notFound());
    if (!roles.includes(req.user.role)) {
      recordAccess({
        actorId: req.user.id,
        action: `role:${roles.join('|')}`,
        resourceType: 'route',
        resourceId: req.path,
        allowed: false,
        reason: 'insufficient_role',
        req
      });
      return next(forbidden());
    }
    return next();
  };
}
