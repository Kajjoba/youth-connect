import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

/**
 * ADR-029: Sign in with Google.
 *
 * The client never sends us a password or an email it typed; it sends a
 * Google ID token, a signed JWT issued by Google itself. This file is
 * the entire trust boundary: verifyIdToken checks the signature against
 * Google's published keys, the expiry, and the AUDIENCE, which is the
 * part that actually matters here. Without pinning the audience to our
 * own client id, a token minted for some unrelated app that also used
 * Google sign-in would verify just as successfully and let its holder
 * log into this one. Google's own library is used rather than a hand
 * rolled JWT check specifically so that key rotation, clock skew and
 * algorithm confusion are handled by code whose whole job is this.
 */

let client;

function getClient() {
  if (!client) client = new OAuth2Client(config.google.clientId);
  return client;
}

/**
 * Verifies a Google ID token and returns its payload, or null if the
 * token does not check out, or if Google sign-in is not configured on
 * this deployment at all. Callers treat null as "cannot sign in this
 * way right now" and never distinguish the reasons to the client: which
 * one it was is not information a caller should get to use.
 */
export async function verifyGoogleIdToken(idToken) {
  if (!config.google.clientId) return null;

  try {
    const ticket = await getClient().verifyIdToken({
      idToken,
      audience: config.google.clientId
    });
    return ticket.getPayload() ?? null;
  } catch {
    return null;
  }
}

/**
 * Google's "locale" claim is free text ("en", "en-GB", "sw-KE", or
 * absent entirely), not the ISO 3166 country code this platform's
 * profile field expects. Best effort only: it seeds a plausible
 * starting value so a new Google sign-up is not left with a blank
 * required field, and the participant can correct it from their
 * profile exactly as anyone can correct a typo made at registration.
 */
export function countryFromLocale(locale) {
  const region = String(locale ?? '').split(/[-_]/)[1];
  return region && /^[a-zA-Z]{2}$/.test(region) ? region.toUpperCase() : null;
}
