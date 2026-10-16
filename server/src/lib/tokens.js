import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';

/**
 * DESIGN DECISION (ADR-006): short-lived access token in memory, plus a
 * rotating refresh token in an httpOnly cookie.
 *
 * Alternatives considered:
 *   a) Server-side sessions in Postgres. Correct and simple, but every
 *      authenticated request becomes a database round trip, which we do
 *      not want on a connection-constrained managed database.
 *   b) A single long-lived JWT. Cheap to verify, but it cannot be
 *      revoked, so a suspended account keeps working until expiry.
 *
 * The chosen design verifies the access token with no database access,
 * while the 15 minute lifetime bounds the damage from a stolen token.
 * Revocation is real because refresh happens against a stored, hashed,
 * single-use record.
 *
 * Trade-off accepted: an account suspended mid-session retains access
 * for at most 15 minutes. Documented, and acceptable for this domain.
 */

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, status: user.status },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtlSeconds, issuer: 'ycp', audience: 'ycp-web' }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret, {
    issuer: 'ycp',
    audience: 'ycp-web'
  });
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * The refresh token is a random opaque string, not a JWT. It carries no
 * claims, so it leaks nothing if intercepted, and it is stored hashed so
 * a database dump does not yield usable sessions.
 */
export async function issueRefreshToken(userId, meta = {}) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 86_400_000);

  const row = await queryOne(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, hashToken(raw), meta.userAgent ?? null, meta.ip ?? null, expiresAt]
  );

  return { raw, id: row.id, expiresAt };
}

/**
 * Rotation with reuse detection.
 *
 * Each refresh consumes the presented token and issues a new one. If a
 * token that has already been revoked is presented again, that means two
 * parties hold the same token, which means it was stolen. The response
 * is to revoke the entire token family for that user, forcing a fresh
 * sign-in everywhere. This is the standard mitigation for refresh token
 * replay and it is worth naming explicitly in the defence.
 */
export async function rotateRefreshToken(rawToken, meta = {}) {
  const tokenHash = hashToken(rawToken);

  const existing = await queryOne(
    `SELECT id, user_id, revoked_at, expires_at
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash]
  );

  if (!existing) return { ok: false, reason: 'unknown_token' };

  if (existing.revoked_at) {
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [existing.user_id]
    );
    return { ok: false, reason: 'reuse_detected', userId: existing.user_id };
  }

  if (new Date(existing.expires_at) < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  const replacement = await issueRefreshToken(existing.user_id, meta);

  await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), replaced_by = $2
      WHERE id = $1`,
    [existing.id, replacement.id]
  );

  return { ok: true, userId: existing.user_id, refresh: replacement };
}

export async function revokeAllForUser(userId) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

export function refreshCookieOptions() {
  return {
    httpOnly: true,           // not readable by JavaScript, so XSS cannot steal it
    secure: config.env === 'production',
    sameSite: 'strict',       // blocks cross-site request forgery on the refresh route
    path: '/api/auth',        // never sent to any other endpoint
    maxAge: config.jwt.refreshTtlDays * 86_400_000
  };
}
