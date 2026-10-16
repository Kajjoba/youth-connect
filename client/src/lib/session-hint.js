/**
 * =====================================================================
 * SESSION HINT
 *
 * A single boolean in localStorage saying "this browser may have a
 * session to restore".
 *
 * WHY THIS EXISTS
 *
 * The access token is held in memory and never in localStorage, because
 * a token in localStorage is readable by any script on the page and one
 * XSS flaw becomes a full account takeover. The refresh token is an
 * httpOnly cookie, which JavaScript cannot read, for the same reason.
 *
 * Both decisions are right, and together they mean the client has no way
 * of knowing whether a session exists. So on boot it asked, by posting
 * to /auth/refresh, and found out from the answer.
 *
 * DEFECT FOUND 2026-09-27 by opening the app in a browser with an empty
 * localStorage: every visitor to a public course page, including someone
 * who has never had an account, paid a round trip that could only fail
 * with 401. On a platform whose entire argument is that it works on a
 * metered mobile connection, the landing page spent a request finding
 * out something it could have known for free. It also filled the console
 * with expected 401s, which is how people learn to ignore the console.
 *
 * WHAT THIS IS NOT
 *
 * It is not a credential and it is not a security control. It holds no
 * token, no identity, no expiry: one character, '1'. Forging it gains
 * nothing, because the refresh cookie is still what the server checks,
 * and a forged hint only buys the attacker the 401 this file exists to
 * avoid. The security boundary is unchanged.
 *
 * It is a HINT, so it is allowed to be wrong. Clearing site data drops
 * the hint while the cookie survives, and the person sees a signed-out
 * app until they sign in again. That is the correct trade: the failure
 * mode is one extra sign-in for a rare case, against a wasted request
 * for every anonymous visit.
 * =====================================================================
 */

const KEY = 'ycp.session';

/**
 * localStorage throws rather than returning null in a few real
 * situations: Safari private browsing, an iframe with third-party
 * storage blocked, and a browser with cookies disabled entirely. If it
 * throws, the honest answer is "I do not know", and not knowing must
 * mean "try", or a working session would be silently abandoned.
 */
export function mayHaveSession() {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

export function rememberSession() {
  try {
    window.localStorage.setItem(KEY, '1');
  } catch {
    // Nothing to do. Without storage the app falls back to asking on
    // every boot, which is exactly the old behaviour and still correct.
  }
}

export function forgetSession() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}
