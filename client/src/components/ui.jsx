/**
 * Shared primitives.
 *
 * Every network view needs four states: loading, error, empty and
 * loaded. These components exist so that writing all four is the path
 * of least resistance rather than extra work, which is how the states
 * that participants on bad connections actually see end up designed
 * rather than forgotten.
 */

import { useCountUp } from '../lib/motion.js';

export function Loading({ rows = 3, label = 'Loading' }) {
  return (
    <div className="rows" role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div className="row" key={index} aria-hidden="true">
          <div className="skeleton" style={{ height: '1rem', width: '55%', marginBottom: '.5rem' }} />
          <div className="skeleton" style={{ height: '.75rem', width: '85%', marginBottom: '.25rem' }} />
          <div className="skeleton" style={{ height: '.75rem', width: '40%' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Errors state what happened and what to do next. They do not apologise
 * and they are never vague: "Something went wrong" tells a participant
 * on a failing connection nothing they can act on.
 */
export function Problem({ error, onRetry }) {
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  const message = offline
    ? 'You are offline. This page needs a connection to load.'
    : error?.status === 404
      ? 'That page is not available to you.'
      : error?.status === 429
        ? 'Too many requests. Wait a minute, then try again.'
        : error?.message || 'The server did not respond.';

  return (
    <div className="notice notice-bad" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      {error?.requestId && (
        <p className="muted numeric" style={{ margin: '.25rem 0 0', fontSize: '.75rem' }}>
          Reference {error.requestId.slice(0, 8)}
        </p>
      )}
      {onRetry && (
        <button type="button" className="btn btn-plain" style={{ marginTop: '.75rem' }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** An empty screen is an invitation to act, not a dead end. */
export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/**
 * The data meter. Shows what an activity costs to open, relative to a
 * 500 KB reference. This is the element that makes the platform's
 * bandwidth engineering visible to the person paying for it.
 */
export function Weight({ kb }) {
  if (kb == null) return null;
  const percent = Math.min(100, Math.round((kb / 500) * 100));
  const heavy = kb > 300;

  return (
    <span className="weight" title={`About ${kb} KB of data`}>
      <span className="weight-rail" aria-hidden="true">
        <span
          className="weight-fill"
          style={{ width: `${percent}%`, background: heavy ? 'var(--alert)' : 'var(--meter)' }}
        />
      </span>
      <span>{kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`}</span>
    </span>
  );
}

export function Progress({ done, total, label }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  const shown = useCountUp(percent, { duration: 600 });
  return (
    <div>
      <div className="between" style={{ marginBottom: '.375rem' }}>
        <span className="muted">{label}</span>
        <span className="muted numeric">{done} of {total}</span>
      </div>
      <div
        className="progress-rail"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/*
          The bar's WIDTH tracks the real percent immediately, because a
          progress indicator that lags the actual state is worse than one
          that does not animate at all. Only the shimmer sweep on
          completion is gated on the counted-up display value, so it
          plays once the count finishes rather than firing early.
        */}
        <div
          className="progress-fill"
          style={{ width: `${percent}%` }}
          data-complete={percent === 100 && shown === 100 ? 'true' : 'false'}
        />
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, id }) {
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      {hint && <span className="field-hint">{hint}</span>}
      {children}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

export function Busy({ children, busy }) {
  return (
    <>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </>
  );
}
