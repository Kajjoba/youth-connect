import { useId, useState } from 'react';

/**
 * Password input with a reveal toggle.
 *
 * Not a cosmetic addition. Typing a password blind on a phone keyboard
 * is the single most common cause of a failed sign-in, and the failure
 * is indistinguishable from a wrong password, so people retry until the
 * account locks. Letting someone confirm what they typed removes that.
 *
 * Accessibility details that are easy to get wrong:
 *
 *   The toggle is a real <button type="button">. A <span> with onClick
 *   is unreachable by keyboard, and a button without type="button"
 *   submits the form when you press it.
 *
 *   aria-pressed tells a screen reader the current state rather than
 *   just naming the action.
 *
 *   The button is excluded from the tab order between the field and the
 *   submit button would be more convenient for mouse users, but it
 *   stays in the order because a keyboard user needs to reach it too.
 */
export function PasswordField({
  label = 'Password',
  hint,
  error,
  value,
  onChange,
  autoComplete = 'current-password',
  required = true,
  id: providedId
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {hint && <span className="field-hint">{hint}</span>}

      <div className="password-wrap">
        <input
          id={id}
          className="input password-input"
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setRevealed((current) => !current)}
          aria-pressed={revealed}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          title={revealed ? 'Hide password' : 'Show password'}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </button>
      </div>

      {error && <span className="field-error" id={`${id}-error`} role="alert">{error}</span>}
    </div>
  );
}

/* Inline icons rather than an icon library. lucide-react is roughly
   12 KB gzipped for what amounts to two shapes here. */

function Eye() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 7 10 7a15.9 15.9 0 0 1-3 3.9" />
      <path d="M6.6 6.8A15.9 15.9 0 0 0 2 13s3.6 7 10 7a9.6 9.6 0 0 0 4.2-.9" />
      <path d="m3 3 18 18" />
      <path d="M9.9 10.1a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
