import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db.js';
import { authenticate } from '../middleware/authenticate.js';
import { can } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { wrap, sendJson } from '../lib/http.js';
import { badRequest, unauthenticated, notFound, forbidden } from '../lib/errors.js';
import { recordAccess } from '../lib/audit.js';
import { issueRefreshToken, refreshCookieOptions, signAccessToken } from '../lib/tokens.js';

const router = Router();

/* ================================================================== */
/* DISCIPLINE VOCABULARY                                              */
/* ================================================================== */

/**
 * GET /api/disciplines
 *
 * The controlled list, grouped for display. Cached publicly for an
 * hour: it is identical for every caller and changes about never, so
 * there is no reason for each participant to fetch it repeatedly.
 */
router.get(
  '/disciplines',
  wrap(async (req, res) => {
    const rows = await query(
      `SELECT slug, label, category FROM disciplines ORDER BY position`
    );

    const grouped = [];
    for (const row of rows.rows) {
      let group = grouped.find((entry) => entry.category === row.category);
      if (!group) {
        group = { category: row.category, items: [] };
        grouped.push(group);
      }
      group.items.push({ slug: row.slug, label: row.label });
    }

    return sendJson(req, res, { disciplines: grouped }, { private: false, maxAge: 3600 });
  })
);

/* ================================================================== */
/* PASSWORD CHANGE                                                    */
/* ================================================================== */

const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Same reasoning as the login limiter in auth.routes.js.
  limit: Number(process.env.PASSWORD_RATE_LIMIT) || (config.env === 'test' ? 200 : 5),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string()
    .min(10, 'Use at least 10 characters.')
    .max(128)
    .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value),
      'Include upper case, lower case and a number.')
});

/**
 * POST /api/auth/password
 *
 * Three properties this endpoint must have, all easy to miss:
 *
 *   1. THE CURRENT PASSWORD IS REQUIRED. Without it, anyone who
 *      borrows an unlocked laptop for thirty seconds takes the account
 *      permanently. Being signed in is not proof of being the owner.
 *
 *   2. EVERY OTHER SESSION IS REVOKED. Changing a password is what
 *      someone does when they think it has been compromised. If the
 *      attacker's session keeps working, the change achieved nothing.
 *      This session is re-issued so the person is not signed out of
 *      the device they are actually using.
 *
 *   3. THE NEW PASSWORD MUST DIFFER. Re-submitting the same password
 *      is almost always a mistake, and accepting it silently leaves
 *      someone believing they have rotated a credential they have not.
 */
router.post(
  '/auth/password',
  authenticate,
  passwordLimiter,
  validate({ body: changePasswordSchema }),
  wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    const user = await queryOne(
      `SELECT id, email, role, status, password_hash FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!user) throw unauthenticated();

    // ADR-029: an account created through Google sign-in has no
    // password_hash to compare against (bcrypt.compare would throw on
    // it rather than just returning false), and "your current password
    // is not correct" would be a strange thing to tell someone who has
    // never had one.
    if (!user.password_hash) {
      throw badRequest(
        'This account was created with Google and has no password yet. ' +
        'Use "Continue with Google" to sign in.'
      );
    }

    const matches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!matches) {
      recordAccess({
        actorId: user.id, action: 'auth:password_change', resourceType: 'user',
        resourceId: user.id, allowed: false, reason: 'wrong_current_password', req
      });
      throw badRequest('Your current password is not correct.');
    }

    if (await bcrypt.compare(newPassword, user.password_hash)) {
      throw badRequest('Your new password must be different from your current one.');
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    const replacement = await withTransaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, newHash]);

      // Revoke everything, including this device, then immediately mint
      // a fresh session for this device only. Any attacker session is
      // now dead.
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id]
      );

      await client.query(
        `INSERT INTO password_changes (user_id, ip_address, user_agent)
         VALUES ($1, $2, $3)`,
        [user.id, req.ip ?? null, req.get('user-agent') ?? null]
      );

      await client.query(
        `INSERT INTO notifications (user_id, kind, payload)
         VALUES ($1, 'password_changed', jsonb_build_object('at', now()))`,
        [user.id]
      );

      return true;
    });

    if (replacement) {
      const fresh = await issueRefreshToken(user.id, {
        userAgent: req.get('user-agent'),
        ip: req.ip
      });
      res.cookie('ycp_refresh', fresh.raw, refreshCookieOptions());
    }

    recordAccess({
      actorId: user.id, action: 'auth:password_change', resourceType: 'user',
      resourceId: user.id, allowed: true, req
    });

    return sendJson(req, res, {
      ok: true,
      accessToken: signAccessToken(user),
      message: 'Password changed. You have been signed out on all other devices.'
    });
  })
);

/* ================================================================== */
/* AVATARS                                                            */
/* ================================================================== */

/**
 * Magic-byte signatures.
 *
 * A client can claim any MIME type it likes. Trusting that claim is how
 * a file that is actually HTML gets stored and later served from our
 * own origin. The bytes themselves are checked instead, and the stored
 * type comes from what the bytes prove rather than what the request
 * asserted.
 */
function detectImageType(buffer) {
  if (buffer.length < 12) return null;

  // WebP: "RIFF" .... "WEBP"
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => buffer[index] === byte)) {
    return 'image/png';
  }
  return null;
}

const avatarSchema = z.object({
  // Base64 rather than multipart. Multipart needs a parser dependency
  // and buys nothing here: the client has already downscaled the image
  // to a few kilobytes, so base64's 33% overhead is a couple of KB
  // against the simplicity of one JSON endpoint.
  data: z.string().min(32).max(400_000)
});

/**
 * PUT /api/profiles/:id/avatar
 */
router.put(
  '/profiles/:id/avatar',
  authenticate,
  can('profile:update'),
  validate({ body: avatarSchema }),
  wrap(async (req, res) => {
    const raw = req.body.data.replace(/^data:[^;]+;base64,/, '');

    let buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      throw badRequest('That image could not be read.');
    }

    if (buffer.length === 0) throw badRequest('That image is empty.');
    if (buffer.length > 262_144) {
      throw badRequest('That image is too large. Pictures are resized automatically, so try again.');
    }

    const mimeType = detectImageType(buffer);
    if (!mimeType) {
      throw badRequest('That file is not a JPEG, PNG or WebP image.');
    }

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

    await query(
      `INSERT INTO avatars (user_id, mime_type, bytes, byte_size, checksum)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET mime_type = EXCLUDED.mime_type,
             bytes = EXCLUDED.bytes,
             byte_size = EXCLUDED.byte_size,
             checksum = EXCLUDED.checksum,
             updated_at = now()`,
      [req.params.id, mimeType, buffer, buffer.length, checksum]
    );

    // The URL carries the checksum so a changed picture produces a
    // different URL. Without it, a browser holding the old image in
    // cache would keep showing it after an update.
    const url = `/api/profiles/${req.params.id}/avatar?v=${checksum}`;
    await query('UPDATE profiles SET avatar_url = $2 WHERE user_id = $1', [req.params.id, url]);

    return sendJson(req, res, {
      avatarUrl: url,
      byteSize: buffer.length,
      mimeType
    }, { status: 201 });
  })
);

/**
 * GET /api/profiles/:id/avatar
 *
 * Public within the platform: profile pictures are visible to everyone
 * who can see the profile, and gating them behind a token would mean
 * no plain <img src> anywhere in the client.
 *
 */
router.get(
  '/profiles/:id/avatar',
  wrap(async (req, res) => {
    const row = await queryOne(
      `SELECT mime_type, bytes, checksum FROM avatars WHERE user_id = $1`,
      [req.params.id]
    ).catch(() => null);

    if (!row) throw notFound('Picture');

    res.set('Content-Type', row.mime_type);
    // Belt and braces: even though only raster types can be stored,
    // this stops any future mistake being rendered as a document.
    res.set('Content-Disposition', 'inline');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(row.bytes);
  })
);

/** DELETE /api/profiles/:id/avatar */
router.delete(
  '/profiles/:id/avatar',
  authenticate,
  can('profile:update'),
  wrap(async (req, res) => {
    await query('DELETE FROM avatars WHERE user_id = $1', [req.params.id]);
    await query('UPDATE profiles SET avatar_url = NULL WHERE user_id = $1', [req.params.id]);
    return sendJson(req, res, { ok: true });
  })
);

export default router;
