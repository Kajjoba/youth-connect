import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { attachRipple } from './lib/motion.js';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// One delegated listener for every button, chip, tab and nav link in the
// app, rather than a handler wired into each of those components. See
// lib/motion.js for why this is a document-level listener instead of a
// per-element one.
attachRipple();

/**
 * Service worker registration, production only.
 *
 * In development a cached shell hides your changes and wastes an hour
 * before you work out why. In production it is what makes the app open
 * instantly on a repeat visit and keep working when the connection
 * drops.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      // A failed registration degrades to a normal web app. It is not
      // worth interrupting the participant over.
      console.warn('Offline support unavailable:', error.message);
    });
  });
}
