import { verifyAccessToken } from '../lib/tokens.js';
import { unauthenticated, forbidden } from '../lib/errors.js';

/**
 * Establishes req.user from the Authorization header.
 *
 * This middleware answers "who is calling". It deliberately does NOT
 * answer "may they touch this record": that is authorize.js. Keeping the
 * two separate is what prevents the classic mistake of assuming that an
 * authenticated request is an authorised one, which is the root cause of
 * the URL-tampering incident in the brief.
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthenticated());
  }

  try {
    const claims = verifyAccessToken(token);

    if (claims.status !== 'active') {
      return next(forbidden('This account is not active.'));
    }

    req.user = {
      id: claims.sub,
      role: claims.role,
      status: claims.status
    };

    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(unauthenticated('Your session expired. Refreshing.'));
    }
    return next(unauthenticated('Invalid session.'));
  }
}

/**
 * For endpoints that behave differently when signed in but do not
 * require it, such as public activity discovery showing an "enrolled"
 * badge. Never throws.
 */
export function authenticateOptional(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();

  try {
    const claims = verifyAccessToken(token);
    if (claims.status === 'active') {
      req.user = { id: claims.sub, role: claims.role, status: claims.status };
    }
  } catch {
    // Ignored on purpose: an expired token on a public route should show
    // the signed-out view, not an error.
  }
  return next();
}
