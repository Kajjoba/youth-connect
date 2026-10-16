/**
 * Typed errors so that handlers throw intent and one central place
 * decides what the client is told.
 *
 * DESIGN DECISION (ADR-005): an authorisation failure on a resource the
 * caller may not even know exists returns 404, not 403.
 *
 * Returning 403 confirms "this resource exists, you just cannot have
 * it", which hands an attacker a working existence oracle. Combined with
 * the URL-tampering incident in the brief, a 403 would let an attacker
 * enumerate valid project identifiers even while every request is
 * blocked. The audit log still records the true reason internally, so
 * we lose no forensic detail by being vague to the caller.
 */
export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (message, details) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const validationFailed = (details) =>
  new AppError(422, 'VALIDATION_FAILED', 'One or more fields are invalid.', details);

export const unauthenticated = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

/** Caller is known but lacks the role. Safe to be explicit: no resource is named. */
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'FORBIDDEN', message);

/** Used for both "absent" and "present but not yours". See ADR-005. */
export const notFound = (what = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${what} not found.`);

export const conflict = (message) =>
  new AppError(409, 'CONFLICT', message);

export const tooManyRequests = (message = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'RATE_LIMITED', message);
