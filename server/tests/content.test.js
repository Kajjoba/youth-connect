import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, call, signIn, query, fixtures, ACCOUNTS } from './helpers.js';

/**
 * =====================================================================
 * COURSE STRUCTURE
 *
 * Activity -> Module -> Item -> Material.
 *
 * Two things are tested harder than the rest:
 *
 *   MATERIAL UPLOAD, because a file that one user supplies and another
 *   downloads is the highest-risk path in any learning platform.
 *
 *   THE PROGRESS ROLLUP, because it is the piece most likely to be
 *   quietly wrong: a module that never completes, or one that completes
 *   while work remains, both look plausible until someone checks.
 * =====================================================================
 */

let ids, facilitator, amina, kwame;
let moduleId, itemId;

const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

before(async () => {
  await startServer();
  ids = await fixtures();
  [facilitator, amina, kwame] = await Promise.all([
    signIn(ACCOUNTS.facilitator),
    signIn(ACCOUNTS.amina),
    signIn(ACCOUNTS.kwame)
  ]);

  const created = await call(`/api/activities/${ids.activityId}/modules`, {
    method: 'POST',
    token: facilitator.token,
    body: { title: 'Structure test module', estimatedMinutes: 30 }
  });
  moduleId = created.body.module.id;
});

after(async () => {
  if (moduleId) {
    await query('DELETE FROM activity_modules WHERE id = $1', [moduleId]).catch(() => {});
  }
  await stopServer();
});

describe('Lesson items', () => {

  test('a reading can be added and is ordered automatically', async () => {
    const result = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        kind: 'reading',
        title: 'What a model actually does',
        body: 'Machine learning differs from rules-based software because...',
        estimatedMinutes: 12
      }
    });

    assert.equal(result.status, 201);
    assert.equal(result.body.item.position, 1, 'position is assigned server side');
    itemId = result.body.item.id;
  });

  test('a reading with no text is refused', async () => {
    // Otherwise it renders as an empty box and nobody finds out until a
    // participant opens it.
    const result = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: facilitator.token,
      body: { kind: 'reading', title: 'Empty reading' }
    });
    assert.equal(result.status, 422);
  });

  test('a video with no link is refused', async () => {
    const result = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: facilitator.token,
      body: { kind: 'video', title: 'Broken video' }
    });
    assert.equal(result.status, 422);
  });

  test('video is external, never uploaded', async () => {
    // ADR-016. Ten minutes of 480p video is roughly 50 MB, which costs
    // more than a weekly data bundle. The platform links to it and
    // stores a transcript, rather than serving the bytes itself.
    const result = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        kind: 'video',
        title: 'Interview with a smallholder farmer',
        externalUrl: 'https://example.org/video/farmer',
        transcript: 'Full transcript so this can be read instead of watched.',
        durationSeconds: 600,
        estimatedMinutes: 10
      }
    });
    assert.equal(result.status, 201);

    const stored = await query(
      `SELECT external_url, transcript FROM lesson_items WHERE id = $1`,
      [result.body.item.id]
    );
    assert.ok(stored.rows[0].external_url, 'the video lives elsewhere');
    assert.ok(stored.rows[0].transcript, 'the cheap alternative is stored with it');
  });

  test('THE ATTACK: a participant cannot add an item', async () => {
    const result = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: kwame.token,
      body: { kind: 'reading', title: 'Injected', body: 'text' }
    });
    assert.equal(result.status, 403);
  });

  test('items appear nested under their module for enrolled participants', async () => {
    const result = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    assert.equal(result.status, 200);

    const module = result.body.modules.find((m) => m.id === moduleId);
    assert.ok(module, 'the module is returned');
    assert.ok(Array.isArray(module.items), 'items are nested, not a separate fetch');
    assert.ok(module.items.length >= 2);
    assert.ok(module.items.every((item) => 'progress_status' in item));
  });
});

describe('Materials', () => {

  test('a facilitator can attach a PDF', async () => {
    const result = await call(`/api/activities/${ids.activityId}/items/${itemId}/materials`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        filename: 'worksheet.pdf',
        mimeType: 'application/pdf',
        data: TINY_PDF.toString('base64')
      }
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.material.mime_type, 'application/pdf');
  });

  test('THE ATTACK: an HTML file claiming to be a PDF is refused', async () => {
    // Served from our own origin it would execute in our security
    // context: stored cross-site scripting delivered as course material.
    const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
    const result = await call(`/api/activities/${ids.activityId}/items/${itemId}/materials`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        filename: 'notes.pdf',
        mimeType: 'application/pdf',
        data: html.toString('base64')
      }
    });
    assert.equal(result.status, 400);
  });

  test('an SVG is refused even when declared as an image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const result = await call(`/api/activities/${ids.activityId}/items/${itemId}/materials`, {
      method: 'POST',
      token: facilitator.token,
      body: { filename: 'diagram.svg', mimeType: 'image/png', data: svg.toString('base64') }
    });
    assert.equal(result.status, 400);
  });

  test('a filename containing path separators is sanitised', async () => {
    // A traversal attempt, and the name is echoed into a
    // Content-Disposition header where a newline would let an attacker
    // inject further headers.
    const result = await call(`/api/activities/${ids.activityId}/items/${itemId}/materials`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        filename: '../../etc/passwd.pdf',
        mimeType: 'application/pdf',
        data: TINY_PDF.toString('base64')
      }
    });
    assert.equal(result.status, 201);
    assert.ok(!result.body.material.filename.includes('/'), 'separators are stripped');
    assert.ok(!result.body.material.filename.includes('..\\'), 'no traversal survives');
  });

  test('an enrolled participant can download a material', async () => {
    const list = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const item = list.body.modules
      .find((m) => m.id === moduleId).items
      .find((i) => i.materials.length > 0);
    assert.ok(item, 'a material is listed');

    const download = await call(`/api/materials/${item.materials[0].id}`, { token: amina.token });
    assert.equal(download.status, 200);
    assert.ok((download.headers.get('cache-control') ?? '').includes('private'),
      'course material must not be stored by a shared proxy');
  });

  test('a PDF is sent as an attachment, not rendered inline', async () => {
    // A PDF rendered inline runs in the browser's PDF engine, which
    // supports JavaScript. Participants want the file, not a preview.
    const list = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const material = list.body.modules
      .find((m) => m.id === moduleId).items
      .flatMap((i) => i.materials)
      .find((m) => m.mimeType === 'application/pdf');

    const download = await call(`/api/materials/${material.id}`, { token: amina.token });
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  });

  test('a participant NOT enrolled cannot download', async () => {
    const list = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const material = list.body.modules
      .find((m) => m.id === moduleId).items
      .flatMap((i) => i.materials)[0];

    await query(
      `DELETE FROM enrolments WHERE activity_id = $1 AND user_id = $2`,
      [ids.activityId, kwame.user.id]
    );

    const blocked = await call(`/api/materials/${material.id}`, { token: kwame.token });
    assert.equal(blocked.status, 404, 'entitlement is joined into the lookup');

    await query(
      `INSERT INTO enrolments (user_id, activity_id, status) VALUES ($2, $1, 'in_progress')
       ON CONFLICT DO NOTHING`,
      [ids.activityId, kwame.user.id]
    );
  });

  test('materials list without their bytes', async () => {
    // The activity page returns the catalogue of what exists. Inlining
    // the files would make opening a course cost every attachment in it.
    const result = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const materials = result.body.modules.flatMap((m) => (m.items ?? []).flatMap((i) => i.materials));
    for (const material of materials) {
      assert.ok(material.byteSize > 0, 'the size is advertised');
      assert.equal(material.bytes, undefined, 'the bytes are not');
    }
  });
});

describe('Derived data weight', () => {

  test('activity weight is computed from real content, not typed in', async () => {
    // payload_kb used to be a number a facilitator entered. A typed
    // number drifts from reality the moment content changes, and the
    // entire low-bandwidth promise rests on that figure being true.
    const weight = await query('SELECT payload_kb FROM activities WHERE id = $1', [ids.activityId]);
    assert.ok(weight.rows[0].payload_kb > 0, 'weight is populated');

    const actual = await query(
      `SELECT COALESCE(sum(mat.byte_size), 0)::int AS bytes
         FROM materials mat
         JOIN lesson_items li    ON li.id = mat.item_id
         JOIN activity_modules m ON m.id = li.module_id
        WHERE m.activity_id = $1`,
      [ids.activityId]
    );
    assert.ok(weight.rows[0].payload_kb >= Math.floor(actual.rows[0].bytes / 1024),
      'the advertised weight covers at least the stored files');
  });
});

describe('Progress rollup', () => {

  test('completing every required item completes the module', async () => {
    const detail = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const module = detail.body.modules.find((m) => m.id === moduleId);
    const required = module.items.filter((item) => item.is_required);
    assert.ok(required.length >= 2, 'the module has required items');

    for (const item of required) {
      const result = await call(
        `/api/activities/${ids.activityId}/items/${item.id}/progress`,
        { method: 'PUT', token: amina.token, body: { status: 'completed' } }
      );
      assert.equal(result.status, 200);
    }

    const after = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const updated = after.body.modules.find((m) => m.id === moduleId);
    assert.equal(updated.progress_status, 'completed',
      'the module rolls up from its items');
  });

  test('an optional item does not block module completion', async () => {
    const optional = await call(`/api/activities/${ids.activityId}/modules/${moduleId}/items`, {
      method: 'POST',
      token: facilitator.token,
      body: {
        kind: 'reading', title: 'Further reading, optional',
        body: 'Extra material for anyone interested.', isRequired: false
      }
    });
    assert.equal(optional.status, 201);

    // Adding an item backfills a not_started progress row, so this also
    // proves the rollup ignores optional work rather than simply not
    // having noticed the new item.
    const after = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const module = after.body.modules.find((m) => m.id === moduleId);
    assert.equal(module.progress_status, 'completed',
      'a bonus reading must not un-complete the module');
  });

  test('progress writes are idempotent, so the offline queue can replay', async () => {
    const detail = await call(`/api/activities/${ids.activityId}`, { token: amina.token });
    const item = detail.body.modules.find((m) => m.id === moduleId).items[0];

    const first = await call(
      `/api/activities/${ids.activityId}/items/${item.id}/progress`,
      { method: 'PUT', token: amina.token, body: { status: 'completed' } }
    );
    const second = await call(
      `/api/activities/${ids.activityId}/items/${item.id}/progress`,
      { method: 'PUT', token: amina.token, body: { status: 'completed' } }
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const rows = await query(
      `SELECT count(*)::int AS n FROM item_progress ip
         JOIN enrolments e ON e.id = ip.enrolment_id
        WHERE ip.item_id = $1 AND e.user_id = $2`,
      [item.id, amina.user.id]
    );
    assert.equal(rows.rows[0].n, 1, 'a replay must not create a second row');
  });
});
