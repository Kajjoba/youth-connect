import { useState, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Field, Busy } from '../components/ui.jsx';
import { PasswordField } from '../components/PasswordField.jsx';
import { Brand } from '../components/Brand.jsx';
import { GoogleSignInButton, GOOGLE_SIGNIN_ENABLED } from '../components/GoogleSignInButton.jsx';

export default function SignIn() {
  const { signIn, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(form);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  // Memoised so GoogleSignInButton's effect, which re-initialises the
  // widget whenever this callback identity changes, does not redraw the
  // button on every keystroke in the password field above it.
  const handleGoogleCredential = useCallback(async (credential) => {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle(credential);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (googleError) {
      setError(googleError.message);
    } finally {
      setBusy(false);
    }
  }, [signInWithGoogle, navigate, location.state]);

  const handleGoogleError = useCallback(() => {
    setError('Google sign-in did not complete. Please try again.');
  }, []);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  return (
    <div className="auth-shell">
      <div className="auth-illustration">
        <Brand size={40} />
        <h2>Learning and collaboration for young people across East Africa</h2>
        <ul className="auth-illustration-points">
          <li><Point />Verifiable certificates an employer can check without an account</li>
          <li><Point />Every activity shows what it costs in data before you open it</li>
          <li><Point />Works on a slow connection, not just a fast one</li>
        </ul>
      </div>

      <div className="auth-panel">
        <div className="auth-card">
          <header className="auth-head">
            <h1>Welcome back</h1>
            <p>Continue your learning across East Africa.</p>
          </header>

          {error && <div className="notice notice-bad" role="alert">{error}</div>}

          {/* The whole block disappears when Google sign-in is not
              configured, divider included, rather than showing a dead
              end or a lone "or" with nothing to divide. */}
          {GOOGLE_SIGNIN_ENABLED && (
            <>
              <div className="auth-oauth">
                <GoogleSignInButton onCredential={handleGoogleCredential} onError={handleGoogleError} />
              </div>
              <div className="auth-divider"><span>or</span></div>
            </>
          )}

          <form onSubmit={handleSubmit} noValidate>
            <Field label="Email" id="email">
              <input
                id="email" className="input" type="email" name="email"
                autoComplete="email" inputMode="email" required
                placeholder="you@example.com"
                value={form.email} onChange={update('email')}
              />
            </Field>

            <PasswordField
              id="password"
              value={form.password}
              onChange={update('password')}
              autoComplete="current-password"
            />

            <button type="submit" className="btn btn-block btn-lg" disabled={busy}>
              <Busy busy={busy}>{busy ? 'Signing in' : 'Sign in'}</Busy>
            </button>
          </form>

          <p className="auth-alt">
            New here? <Link to="/register">Create an account</Link>
          </p>
        </div>

        {/*
          The data note is not decoration. It sets the expectation that
          this platform is built for metered connections, which is the
          thing that distinguishes it for the people it is aimed at.
        */}
        <p className="auth-foot">
          Built for low bandwidth. Every activity shows what it costs in data.
        </p>
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
