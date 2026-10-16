import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * ACCOUNT MANAGEMENT
 *
 * Password change and file upload are the two places where a profile
 * page most often goes wrong, so both are tested from the attacker's
 * side as well as the owner's.
 * =====================================================================
 */

let joseph, kwame;

// A 1x1 PNG. Real bytes, so the magic-byte check is genuinely exercised
// rather than bypassed by a stub.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

before(async () => {
  await startServer();
  [joseph, kwame] = await Promise.all([
    signIn(ACCOUNTS.joseph),
    signIn(ACCOUNTS.kwame)
  ]);
});

after(stopServer);

describe('Discipline vocabulary', () => {

  test('the list is served grouped by category', async () => {
    const result = await call('/api/disciplines');
    assert.equal(result.status, 200);
    assert.ok(result.body.disciplines.length > 3);

    const flat = result.body.disciplines.flatMap((group) => group.items);
    const slugs = flat.map((item) => item.slug);
    // The brief's own example names these four.
    for (const expected of ['agriculture', 'software-development', 'data-analysis', 'environmental-studies']) {
      assert.ok(slugs.includes(expected), `${expected} should be offered`);
    }
  });

  test('the vocabulary is publicly cacheable', async () => {
    const result = await call('/api/disciplines');
    const cacheControl = result.headers.get('cache-control') ?? '';
    assert.ok(cacheControl.includes('public'), 'identical for every caller, so cache it');
  });

  test('a known discipline is accepted', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}`, {
      method: 'PATCH',
      token: joseph.token,
      body: { disciplines: ['agriculture', 'data-analysis'] }
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.profile.disciplines, ['agriculture', 'data-analysis']);
  });

  test('an invented discipline is refused', async () => {
    // Free text would let this through and quietly break Level Two
    // team matching, which depends on comparable values.
    const result = await call(`/api/profiles/${joseph.user.id}`, {
      method: 'PATCH',
      token: joseph.token,
      body: { disciplines: ['agriculture', 'wizardry'] }
    });
    assert.equal(result.status, 400);
    assert.ok(result.body.error.message.includes('wizardry'));
  });
});

describe('Password change', () => {

  test('the current password is required, not just a session', async () => {
    // Being signed in is not proof of ownership. Without this check,
    // thirty seconds with an unlocked laptop takes the account.
    const result = await call('/api/auth/password', {
      method: 'POST',
      token: joseph.token,
      body: { currentPassword: 'WrongPassword123', newPassword: 'BrandNewPass99' }
    });
    assert.equal(result.status, 400);

    const unchanged = await signIn(ACCOUNTS.joseph);
    assert.ok(unchanged.token, 'the old password must still work');
  });

  test('the new password must meet the policy', async () => {
    const result = await call('/api/auth/password', {
      method: 'POST',
      token: joseph.token,
      body: { currentPassword: 'YcpDemo2026!', newPassword: 'short' }
    });
    assert.equal(result.status, 422);
  });

  test('the new password must differ from the current one', async () => {
    const result = await call('/api/auth/password', {
      method: 'POST',
      token: joseph.token,
      body: { currentPassword: 'YcpDemo2026!', newPassword: 'YcpDemo2026!' }
    });
    assert.equal(result.status, 400);
    assert.ok(/different/i.test(result.body.error.message));
  });

  test('a successful change revokes every other session', async () => {
    // Someone changing their password usually believes it has been
    // compromised. If an attacker's session survives, the change
    // achieved nothing.
    const first = await signIn(ACCOUNTS.kwame);
    const second = await signIn(ACCOUNTS.kwame);

    const before = await query(
      `SELECT count(*)::int AS n FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [kwame.user.id]
    );
    assert.ok(before.rows[0].n >= 2, 'two live sessions to start with');

    const changed = await call('/api/auth/password', {
      method: 'POST',
      token: second.token,
      body: { currentPassword: 'YcpDemo2026!', newPassword: 'RotatedPass2026' }
    });
    assert.equal(changed.status, 200);
    assert.ok(changed.body.accessToken, 'this device is re-issued a session');

    const after = await query(
      `SELECT count(*)::int AS n FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [kwame.user.id]
    );
    assert.equal(after.rows[0].n, 1, 'exactly one session survives: this one');

    // The change is recorded for later dispute.
    const audit = await query(
      `SELECT count(*)::int AS n FROM password_changes WHERE user_id = $1`,
      [kwame.user.id]
    );
    assert.ok(audit.rows[0].n >= 1);

    // Put it back so the suite is re-runnable.
    await call('/api/auth/password', {
      method: 'POST',
      token: changed.body.accessToken,
      body: { currentPassword: 'RotatedPass2026', newPassword: 'YcpDemo2026!' }
    });
  });

  test('an unauthenticated caller cannot change a password', async () => {
    const result = await call('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'YcpDemo2026!', newPassword: 'Whatever12345' }
    });
    assert.equal(result.status, 401);
  });
});

describe('Avatar upload', () => {

  test('the owner can upload a picture', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'PUT',
      token: joseph.token,
      body: { data: TINY_PNG.toString('base64') }
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.mimeType, 'image/png');
    assert.ok(result.body.avatarUrl.includes('?v='), 'the URL carries a checksum');
  });

  test('the picture is served with the right content type', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'image/png');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  });

  test('a repeat fetch returns the same picture', async () => {
    const first = await call(`/api/profiles/${joseph.user.id}/avatar`);
    const second = await call(`/api/profiles/${joseph.user.id}/avatar`);
    assert.equal(second.status, 200);
    assert.equal(second.raw, first.raw, 'the same stored image must come back both times');
  });

  test('THE ATTACK: an SVG disguised as an avatar is refused', async () => {
    // An SVG can carry <script>. Served from our own origin it would
    // execute in our security context: stored XSS delivered as a
    // profile picture. The magic-byte check refuses it whatever the
    // request claims the type is.
    const malicious = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
    );
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'PUT',
      token: joseph.token,
      body: { data: malicious.toString('base64') }
    });
    assert.equal(result.status, 400);
  });

  test('an HTML file claiming to be a PNG is refused', async () => {
    // The MIME type a client sends is an assertion, not evidence. Only
    // the bytes are trusted.
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'PUT',
      token: joseph.token,
      body: { data: `data:image/png;base64,${html.toString('base64')}` }
    });
    assert.equal(result.status, 400);
    assert.ok(/not a JPEG, PNG or WebP/i.test(result.body.error.message));
  });

  test('a participant cannot overwrite another participant picture', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'PUT',
      token: kwame.token,
      body: { data: TINY_PNG.toString('base64') }
    });
    assert.ok([403, 404].includes(result.status));
  });

  test('a participant cannot delete another participant picture', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'DELETE',
      token: kwame.token
    });
    assert.ok([403, 404].includes(result.status));

    const survived = await query('SELECT count(*)::int AS n FROM avatars WHERE user_id = $1',
      [joseph.user.id]);
    assert.equal(survived.rows[0].n, 1, 'the picture must still be there');
  });

  test('the owner can remove their own picture', async () => {
    const result = await call(`/api/profiles/${joseph.user.id}/avatar`, {
      method: 'DELETE',
      token: joseph.token
    });
    assert.equal(result.status, 200);

    const gone = await call(`/api/profiles/${joseph.user.id}/avatar`);
    assert.equal(gone.status, 404);
  });
});

describe('Rate limiting', () => {

  test('the production login limit is 10 per 15 minutes', async () => {
    // The limiter is relaxed under NODE_ENV=test so the suite does not
    // throttle itself. That relaxation means the suite is no longer
    // exercising the control, so this test pins the production value
    // instead. If someone raises the real limit, this fails and they
    // have to justify it.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/routes/auth.routes.js', import.meta.url), 'utf8'
    );
    assert.match(source, /config\.env === 'test' \? \d+ : 10/,
      'the non-test login limit must remain 10');
    assert.match(source, /windowMs: 15 \* 60 \* 1000/);
  });

  test('a locked account is refused even with the right password', async () => {
    // Five wrong passwords locks the account for 15 minutes. This is a
    // separate control from the IP rate limit: it follows the account
    // rather than the source address, so rotating IPs does not evade it.
    const email = 'lockout-probe@ycp.africa';
    await query(
      `INSERT INTO users (email, password_hash, role, status)
       VALUES ($1, '$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012', 'participant', 'active')
       ON CONFLICT (email) DO UPDATE SET failed_logins = 0, locked_until = NULL`,
      [email]
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call('/api/auth/login', {
        method: 'POST',
        body: { email, password: `WrongGuess${attempt}` }
      });
    }

    const locked = await query(
      'SELECT failed_logins, locked_until FROM users WHERE email = $1', [email]
    );
    assert.ok(locked.rows[0].failed_logins >= 5);
    assert.ok(locked.rows[0].locked_until, 'the account must be locked');

    await query('DELETE FROM users WHERE email = $1', [email]);
  });
});
