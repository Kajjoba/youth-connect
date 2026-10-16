import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/authenticate.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, unauthenticated, conflict } from '../lib/errors.js';
import { recordAccess } from '../lib/audit.js';
import { verifyGoogleIdToken, countryFromLocale } from '../lib/google.js';
import {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeAllForUser,
  refreshCookieOptions
} from '../lib/tokens.js';

const router = Router();

/**
 * REQ-SEC-007: credential endpoints are rate limited per IP.
 *
 * Without this, an attacker can try thousands of passwords per minute.
 * The limit is generous enough that a user fumbling their password three
 * times is unaffected, and tight enough that automated guessing is not
 * viable.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Raised under NODE_ENV=test because the suite signs in thirteen
  // times across three files and would otherwise throttle itself: the
  // first file to run absorbs the 429s and its setup hook fails, which
  // reads as a broken application when nothing is wrong.
  //
  // This is a real trade-off. Relaxing a control in test means the
  // suite no longer exercises it, so the limiter has its own test that
  // pins the production value and verifies refusal past the cap.
  limit: Number(process.env.LOGIN_RATE_LIMIT) || (config.env === 'test' ? 500 : 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' } }
});

const passwordRule = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value),
    'Include upper case, lower case and a number.');

const registerSchema = z.object({
  email: z.string().email('Enter a valid email address.').max(254),
  password: passwordRule,
  fullName: z.string().min(2, 'Enter your full name.').max(120),
  country: z.string().length(2, 'Select your country.').toUpperCase(),
  dateOfBirth: z.string().date().optional(),
  digitalLiteracy: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate')
});

/**
 * POST /api/auth/register
 * REQ-FUN-001 Register, REQ-FUN-002 Create profile.
 *
 * Account and profile are created in ONE transaction. A half-registered
 * user with an account but no profile is a state the rest of the system
 * would have to defend against forever, so it is made unreachable.
 */
router.post(
  '/register',
  credentialLimiter,
  validate({ body: registerSchema }),
  wrap(async (req, res) => {
    const { email, password, fullName, country, dateOfBirth, digitalLiteracy } = req.body;

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      // Deliberately the same shape as success would be, worded so it
      // does not confirm the address is registered to an attacker
      // harvesting emails, while still being useful to a real user.
      throw conflict('That email cannot be used to register. Try signing in instead.');
    }

    // Cost factor 12: roughly 250ms per hash on typical hardware. High
    // enough to make offline cracking expensive, low enough that login
    // stays responsive on a modest Render instance.
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO users (email, password_hash, role, status)
         VALUES ($1, $2, 'participant', 'active')
         RETURNING id, email, role, status, created_at`,
        [email, passwordHash]
      );
      const row = created.rows[0];

      await client.query(
        `INSERT INTO profiles (user_id, full_name, country, date_of_birth, digital_literacy, completeness)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, fullName, country, dateOfBirth ?? null, digitalLiteracy, dateOfBirth ? 40 : 30]
      );

      return row;
    });

    const refresh = await issueRefreshToken(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    recordAccess({
      actorId: user.id, action: 'auth:register', resourceType: 'user',
      resourceId: user.id, allowed: true, req
    });

    res.cookie('ycp_refresh', refresh.raw, refreshCookieOptions());
    return sendJson(req, res, {
      accessToken: signAccessToken(user),
      user: { id: user.id, email: user.email, role: user.role, fullName }
    }, { status: 201 });
  })
);

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128)
});

/**
 * POST /api/auth/login
 *
 * Note the uniform failure message and the dummy hash comparison. Both
 * exist so that a wrong email and a wrong password take the same time
 * and produce the same response. Without the dummy compare, a missing
 * account returns in microseconds while a real one takes 250ms, and that
 * timing difference alone enumerates registered users.
 */
const DUMMY_HASH = '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';

router.post(
  '/login',
  credentialLimiter,
  validate({ body: loginSchema }),
  wrap(async (req, res) => {
    const { email, password } = req.body;

    const user = await queryOne(
      `SELECT u.id, u.email, u.password_hash, u.role, u.status, u.locked_until, u.failed_logins,
              p.full_name
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.email = $1`,
      [email]
    );

    const fail = () => {
      recordAccess({
        actorId: user?.id ?? null, action: 'auth:login', resourceType: 'user',
        resourceId: user?.id ?? null, allowed: false, reason: 'bad_credentials', req
      });
      throw unauthenticated('Email or password is incorrect.');
    };

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return fail();
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw unauthenticated('Account temporarily locked. Try again shortly.');
    }

    // A Google-only account has no password_hash to compare against
    // (ADR-029). bcrypt.compare throws on a non-string hash, and the
    // correct answer here is the same uniform failure as a wrong
    // password, not a 500 and not a hint that "this email uses Google".
    const matches = user.password_hash
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    if (!matches) {
      // Progressive lockout after repeated failures from any source.
      const attempts = user.failed_logins + 1;
      await query(
        `UPDATE users
            SET failed_logins = $2,
                locked_until = CASE WHEN $2 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
          WHERE id = $1`,
        [user.id, attempts]
      );
      return fail();
    }

    if (user.status !== 'active') {
      throw unauthenticated('This account is not active. Contact an administrator.');
    }

    await query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id]
    );

    const refresh = await issueRefreshToken(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    recordAccess({
      actorId: user.id, action: 'auth:login', resourceType: 'user',
      resourceId: user.id, allowed: true, req
    });

    res.cookie('ycp_refresh', refresh.raw, refreshCookieOptions());
    return sendJson(req, res, {
      accessToken: signAccessToken(user),
      user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name }
    });
  })
);

const googleSchema = z.object({
  // A real Google ID token is a compact JWT, three base64url segments
  // joined by dots, comfortably over a thousand characters. The length
  // floor is not the security control (verifyGoogleIdToken is), just a
  // cheap way to reject obvious junk before it reaches Google's servers.
  credential: z.string().min(100).max(4096)
});

/**
 * POST /api/auth/google
 *
 * ADR-029: Sign in with Google, for both a brand new account and an
 * existing one. One endpoint does both, the same way a door with a key
 * reader and a code pad is still one door: which credential arrives
 * decides whether this is a first visit or a returning one, not which
 * route the request took.
 *
 * Trust chain: verifyGoogleIdToken checks the token's signature and
 * audience, so by the time this handler runs, Google has already
 * vouched for the email. That is also why account LINKING here is
 * safe: a password-based account that later signs in with Google under
 * the same, Google-verified email is not "anyone who knows an email
 * address," it is Google itself making the claim.
 */
router.post(
  '/google',
  credentialLimiter,
  validate({ body: googleSchema }),
  wrap(async (req, res) => {
    const payload = await verifyGoogleIdToken(req.body.credential);

    if (!payload || !payload.email) {
      throw unauthenticated('Google sign-in could not be verified.');
    }
    if (!payload.email_verified) {
      throw unauthenticated('That Google account\'s email address is not verified.');
    }

    const email = payload.email;
    const googleSub = payload.sub;

    let user = await queryOne(
      `SELECT u.id, u.email, u.role, u.status, u.google_sub, p.full_name
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.email = $1`,
      [email]
    );

    if (!user) {
      // A brand new account, built the same way registration builds
      // one, minus a password: Google has already proven the email, so
      // there is nothing left for a password to additionally prove.
      const fullName = payload.name ?? email.split('@')[0];
      const country = countryFromLocale(payload.locale) ?? 'UG';

      const created = await withTransaction(async (client) => {
        const row = await client.query(
          `INSERT INTO users (email, google_sub, role, status, email_verified)
           VALUES ($1, $2, 'participant', 'active', TRUE)
           RETURNING id, email, role, status`,
          [email, googleSub]
        );
        // completeness is lower than a filled-in registration form: a
        // guessed country and a name borrowed from Google are a start,
        // not a finished profile, and the number should say so.
        await client.query(
          `INSERT INTO profiles (user_id, full_name, country, completeness)
           VALUES ($1, $2, $3, 20)`,
          [row.rows[0].id, fullName, country]
        );
        return row.rows[0];
      });

      user = { ...created, full_name: fullName };

      recordAccess({
        actorId: user.id, action: 'auth:register_google', resourceType: 'user',
        resourceId: user.id, allowed: true, req
      });
    } else {
      if (user.status !== 'active') {
        throw unauthenticated('This account is not active. Contact an administrator.');
      }

      if (!user.google_sub) {
        // First time this existing, password-based account has signed
        // in with Google. Linking, not replacing: the password still
        // works afterwards too.
        await query(`UPDATE users SET google_sub = $2 WHERE id = $1`, [user.id, googleSub]);
      } else if (user.google_sub !== googleSub) {
        // Should not be reachable, since google_sub is UNIQUE and
        // Google itself asserted this email, but refusing outright
        // costs nothing and silently re-linking would.
        recordAccess({
          actorId: user.id, action: 'auth:login_google', resourceType: 'user',
          resourceId: user.id, allowed: false, reason: 'google_sub_mismatch', req
        });
        throw unauthenticated('This email is already linked to a different Google account.');
      }

      await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

      recordAccess({
        actorId: user.id, action: 'auth:login_google', resourceType: 'user',
        resourceId: user.id, allowed: true, req
      });
    }

    const refresh = await issueRefreshToken(user.id, {
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    res.cookie('ycp_refresh', refresh.raw, refreshCookieOptions());
    return sendJson(req, res, {
      accessToken: signAccessToken(user),
      user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name }
    });
  })
);

/**
 * POST /api/auth/refresh
 *
 * Called by the client when a request returns 401. See ADR-006 for the
 * rotation and reuse-detection design.
 */
router.post(
  '/refresh',
  wrap(async (req, res) => {
    const presented = req.cookies?.ycp_refresh;
    if (!presented) throw unauthenticated('No session to refresh.');

    const result = await rotateRefreshToken(presented, {
      userAgent: req.get('user-agent'),
      ip: req.ip
    });

    if (!result.ok) {
      res.clearCookie('ycp_refresh', refreshCookieOptions());

      if (result.reason === 'reuse_detected') {
        recordAccess({
          actorId: result.userId, action: 'auth:refresh', resourceType: 'session',
          resourceId: null, allowed: false, reason: 'token_reuse_all_sessions_revoked', req
        });
        throw unauthenticated('Session security issue detected. Please sign in again.');
      }
      throw unauthenticated('Session expired. Please sign in again.');
    }

    const user = await queryOne(
      `SELECT u.id, u.email, u.role, u.status, p.full_name
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [result.userId]
    );

    if (!user || user.status !== 'active') {
      // This is where revocation actually bites: a suspended account
      // cannot renew, so it drops out within one access-token lifetime.
      await revokeAllForUser(result.userId);
      res.clearCookie('ycp_refresh', refreshCookieOptions());
      throw unauthenticated('This account is no longer active.');
    }

    res.cookie('ycp_refresh', result.refresh.raw, refreshCookieOptions());
    return sendJson(req, res, {
      accessToken: signAccessToken(user),
      user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name }
    });
  })
);

router.post(
  '/logout',
  wrap(async (req, res) => {
    const presented = req.cookies?.ycp_refresh;
    if (presented) {
      await query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = encode(digest($1, 'sha256'), 'hex') AND revoked_at IS NULL`,
        [presented]
      ).catch(() => {});
    }
    res.clearCookie('ycp_refresh', refreshCookieOptions());
    return sendJson(req, res, { ok: true });
  })
);

/** GET /api/auth/me - who am I, used by the client on boot. */
router.get(
  '/me',
  authenticate,
  wrap(async (req, res) => {
    const me = await queryOne(
      `SELECT u.id, u.email, u.role, u.status, u.created_at,
              p.full_name, p.country, p.digital_literacy, p.low_bandwidth_mode,
              p.completeness, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (!me) throw unauthenticated();
    return sendJson(req, res, { user: me });
  })
);

export default router;
