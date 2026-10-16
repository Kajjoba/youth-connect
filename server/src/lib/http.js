import { config } from '../config.js';

/**
 * Respond with JSON.
 *
 * REMOVED BY REQUEST: this used to also compute a strong ETag over the
 * serialised payload and answer a matching If-None-Match with an empty
 * 304, so a refresh of unchanged data cost headers only. That
 * conditional-request revalidation layer, and the client-side cache in
 * client/src/lib/api.js that made use of it, have both been taken out.
 * Every request now gets a full 200 with the full body, every time.
 *
 * The Cache-Control/Vary marking below is kept: it is not about saving
 * bandwidth, it is about correctness and privacy. `private` tells any
 * shared proxy or CDN between here and the browser that a response is
 * for one signed-in person and must never be stored and handed to
 * someone else; `public` with a maxAge is only ever used for data that
 * is identical for every caller, such as the discipline vocabulary or
 * the public catalogue. Removing conditional requests does not change
 * either of those facts.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {unknown} body
 * @param {{ status?: number, maxAge?: number, private?: boolean }} options
 */
export function sendJson(req, res, body, options = {}) {
  const serialised = JSON.stringify(body);
  res.set('Content-Type', 'application/json; charset=utf-8');

  if (options.private) {
    res.set('Cache-Control', 'private, no-store');
    // A shared cache keyed only on the URL would otherwise serve one
    // user's private response to the next user who asks for the same
    // path with a different token.
    res.set('Vary', 'Authorization');
  } else if (options.private === false) {
    const maxAge = options.maxAge ?? 0;
    res.set('Cache-Control', `public, max-age=${maxAge}`);
  }

  return res.status(options.status ?? 200).send(serialised);
}

/**
 * REQ-NFR-003: cursor pagination rather than OFFSET.
 *
 * OFFSET makes the database scan and discard every skipped row, so page
 * 50 costs far more than page 1. A keyset cursor is O(log n) at any
 * depth and is stable when rows are inserted mid-scroll, which matters
 * on a slow connection where a user may take minutes to reach page 3.
 */
export function readPagination(req) {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), config.pagination.maxLimit)
    : config.pagination.defaultLimit;

  const cursor = typeof req.query.cursor === 'string' && req.query.cursor.length
    ? decodeCursor(req.query.cursor)
    : null;

  return { limit, cursor };
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // A malformed cursor is treated as no cursor. Never throw on it:
    // a stale bookmark should degrade to page one, not to an error page.
    return null;
  }
}

/**
 * Build a paged envelope. Fetch limit + 1 rows and pass them in; this
 * derives hasMore without a second COUNT query.
 */
export function paginate(rows, limit, cursorFrom) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page,
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && page.length ? encodeCursor(cursorFrom(page[page.length - 1])) : null
    }
  };
}

/**
 * REQ-NFR-004: field selection. A list view needs four fields per row;
 * a detail view needs twenty. Sending twenty to the list view multiplies
 * the payload for no benefit. Callers pass ?fields=id,title,summary and
 * the server narrows the response.
 */
export function selectFields(row, requested, allowed) {
  if (!requested) return row;
  const wanted = String(requested)
    .split(',')
    .map((field) => field.trim())
    .filter((field) => allowed.includes(field));
  if (!wanted.length) return row;
  return Object.fromEntries(wanted.map((field) => [field, row[field]]));
}

/** Async route wrapper so a rejected promise reaches the error middleware. */
export const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
