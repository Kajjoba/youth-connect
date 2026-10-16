import { useEffect, useRef, useState } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// Exported so a page can decide whether to show an "or" divider around
// the button without duplicating the env lookup, and without rendering
// this component just to find out it returns null.
export const GOOGLE_SIGNIN_ENABLED = Boolean(CLIENT_ID);

/**
 * ADR-029: "Continue with Google", rendered as Google's own button
 * widget rather than a lookalike this app draws itself.
 *
 * Google requires its real button for the one-tap and account-chooser
 * behaviour to work at all, and reusing it also means a visitor
 * recognises it instantly rather than having to trust an unfamiliar
 * "Sign in with Google" button that could, on any other site, be
 * phishing for their Google password. The ID token it hands back in
 * onCredential is this component's entire job; everything after that
 * (verifying it, creating or matching an account) happens server side.
 *
 * Renders nothing when no client id is configured, so a deployment
 * that has not set one up gets a clean sign-in page with only email
 * and password, not a broken button.
 */
export function GoogleSignInButton({ onCredential, onError }) {
  const slotRef = useRef(null);
  const [scriptReady, setScriptReady] = useState(Boolean(window.google?.accounts?.id));

  // The <script> tag in index.html loads async, so this page may well
  // render before window.google exists yet. Poll briefly rather than
  // depending on a load event that could fire before this component
  // ever mounted.
  useEffect(() => {
    if (!CLIENT_ID || scriptReady) return undefined;
    const timer = setInterval(() => {
      if (window.google?.accounts?.id) {
        setScriptReady(true);
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [scriptReady]);

  useEffect(() => {
    if (!CLIENT_ID || !scriptReady || !slotRef.current) return;

    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        if (response?.credential) onCredential(response.credential);
        else onError?.(new Error('Google did not return a credential.'));
      }
    });

    // Cleared and redrawn on every mount rather than reused, since the
    // slot element itself is recreated whenever this component
    // (re)mounts, e.g. navigating from sign in to register.
    slotRef.current.innerHTML = '';
    window.google.accounts.id.renderButton(slotRef.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'continue_with'
    });
  }, [scriptReady, onCredential, onError]);

  if (!CLIENT_ID) return null;

  return <div ref={slotRef} className="google-signin-slot" />;
}
