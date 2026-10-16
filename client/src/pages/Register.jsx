import { useState, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Field, Busy } from '../components/ui.jsx';
import { PasswordField } from '../components/PasswordField.jsx';
import { Brand } from '../components/Brand.jsx';
import { GoogleSignInButton, GOOGLE_SIGNIN_ENABLED } from '../components/GoogleSignInButton.jsx';

const COUNTRIES = [
  ['UG', 'Uganda'], ['KE', 'Kenya'], ['TZ', 'Tanzania'], ['RW', 'Rwanda'],
  ['BI', 'Burundi'], ['SS', 'South Sudan'], ['ET', 'Ethiopia'], ['SO', 'Somalia']
];

/**
 * Client validation mirrors the server rules so a participant on a slow
 * connection learns about a weak password immediately rather than after
 * a round trip. It is a usability measure only. The server validates
 * independently and is the actual control.
 */
function check(form) {
  const errors = {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.email = 'Enter a valid email address.';
  if (form.password.length < 10) errors.password = 'Use at least 10 characters.';
  else if (!/[a-z]/.test(form.password) || !/[A-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
    errors.password = 'Include upper case, lower case and a number.';
  }
  if (form.fullName.trim().length < 2) errors.fullName = 'Enter your full name.';
  if (!form.country) errors.country = 'Select your country.';

  if (form.dateOfBirth) {
    const age = (Date.now() - new Date(form.dateOfBirth)) / 31_557_600_000;
    if (age < 18 || age > 35) errors.dateOfBirth = 'YouthConnect is for people aged 18 to 35.';
  }
  return errors;
}

export default function Register() {
  const { register, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({
    fullName: '', email: '', password: '', country: '',
    dateOfBirth: '', digitalLiteracy: 'intermediate'
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) => {
    setForm({ ...form, [key]: event.target.value });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  };

  async function handleSubmit(event) {
    event.preventDefault();
    const found = check(form);
    setErrors(found);
    if (Object.keys(found).length) return;

    setServerError(null);
    setBusy(true);
    try {
      await register({ ...form, dateOfBirth: form.dateOfBirth || undefined });
      // Honours the same redirect-back CourseLanding sets up when it
      // sends someone signed out here after tapping Enrol (ADR-018);
      // this was previously dropped, so a new participant lost their
      // place and landed on Discover instead of the course they came
      // to sign up for.
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (error) {
      // The server returns field-level details for a 422. Show them
      // against the fields rather than as one opaque banner.
      if (error.details) setErrors(error.details);
      else setServerError(error.message);
    } finally {
      setBusy(false);
    }
  }

  // ADR-029. "Continue with Google" here creates the account in one
  // step on the server, so this is the register page's entire handler
  // for it: no form to validate first, there is nothing in form state
  // Google did not already supply.
  const handleGoogleCredential = useCallback(async (credential) => {
    setServerError(null);
    setBusy(true);
    try {
      await signInWithGoogle(credential);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (googleError) {
      setServerError(googleError.message);
    } finally {
      setBusy(false);
    }
  }, [signInWithGoogle, navigate, location.state]);

  const handleGoogleError = useCallback(() => {
    setServerError('Google sign-in did not complete. Please try again.');
  }, []);

  return (
    <div className="auth-shell">
      <div className="auth-illustration">
        <Brand size={40} />
        <h2>Join thousands of young people building real, verifiable skills</h2>
        <ul className="auth-illustration-points">
          <li><Point />Free to join, open to ages 18 to 35</li>
          <li><Point />Courses, workshops, challenges and discussions</li>
          <li><Point />A certificate anyone can verify when you finish</li>
        </ul>
      </div>

      <div className="auth-panel">
      <div className="auth-card">
        <header className="auth-head">
          <h1>Create your account</h1>
          <p>Open to people aged 18 to 35 across East Africa.</p>
        </header>

      {serverError && <div className="notice notice-bad" role="alert">{serverError}</div>}

      {GOOGLE_SIGNIN_ENABLED && (
        <>
          <div className="auth-oauth">
            <GoogleSignInButton onCredential={handleGoogleCredential} onError={handleGoogleError} />
          </div>
          <div className="auth-divider"><span>or</span></div>
        </>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <Field label="Full name" id="fullName" error={errors.fullName}>
          <input
            id="fullName" className="input" autoComplete="name" required
            aria-invalid={Boolean(errors.fullName)}
            value={form.fullName} onChange={update('fullName')}
          />
        </Field>

        <Field label="Email" id="email" error={errors.email}>
          <input
            id="email" className="input" type="email" autoComplete="email"
            inputMode="email" required aria-invalid={Boolean(errors.email)}
            value={form.email} onChange={update('email')}
          />
        </Field>

        <PasswordField
          id="password"
          hint="At least 10 characters, with upper case, lower case and a number."
          error={errors.password}
          value={form.password}
          onChange={update('password')}
          autoComplete="new-password"
        />

        <Field label="Country" id="country" error={errors.country}>
          <select id="country" className="select" required value={form.country} onChange={update('country')}>
            <option value="">Select your country</option>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </Field>

        <Field label="Date of birth" id="dob" hint="Optional. Used to confirm eligibility." error={errors.dateOfBirth}>
          <input
            id="dob" className="input" type="date"
            value={form.dateOfBirth} onChange={update('dateOfBirth')}
          />
        </Field>

        {/*
          This choice shapes the interface afterwards. Participants who
          say they are new to digital tools get fuller guidance text and
          fewer assumptions, which is the platform's answer to the
          "different levels of digital literacy" requirement.
        */}
        <Field
          label="How comfortable are you with online learning tools?"
          id="literacy"
          hint="We use this to decide how much guidance to show. You can change it later."
        >
          <select id="literacy" className="select" value={form.digitalLiteracy} onChange={update('digitalLiteracy')}>
            <option value="beginner">New to them</option>
            <option value="intermediate">Reasonably comfortable</option>
            <option value="advanced">Very comfortable</option>
          </select>
        </Field>

        <button type="submit" className="btn btn-block btn-lg" disabled={busy}>
          <Busy busy={busy}>{busy ? 'Creating account' : 'Create account'}</Busy>
        </button>
      </form>

        <p className="auth-alt">
          Already registered? <Link to="/signin">Sign in</Link>
        </p>
      </div>
      </div>
    </div>
  );
}

function Point() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}
