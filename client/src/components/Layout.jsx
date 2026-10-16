import { NavLink, Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { useConnection, usePendingWrites } from '../lib/hooks.js';
import { Brand } from './Brand.jsx';

/**
 * Navigation is role-aware.
 *
 * Before this, an administrator signing in landed on the participant
 * Discover page with no route to anything they were there to do. The
 * server already enforced the roles; the interface simply did not
 * acknowledge they existed.
 *
 * These entries decide what is VISIBLE, never what is permitted. Every
 * endpoint behind them re-checks the role server side, so hiding a link
 * hides a link and nothing more.
 */
function tabsFor(role) {
  // A signed-out visitor has nowhere to go but the catalogue: Progress,
  // Certificates and Profile all belong to an account that does not
  // exist yet. Showing them as dead ends that bounce back to sign-in
  // is worse than not showing them at all.
  if (!role) {
    return [{ to: '/', label: 'Discover', end: true }];
  }

  const base = [
    { to: '/', label: 'Discover', end: true },
    { to: '/progress', label: 'Progress' },
    { to: '/certificates', label: 'Certificates' }
  ];

  if (role === 'facilitator' || role === 'mentor' || role === 'admin' || role === 'super_admin') {
    base.push({ to: '/manage', label: 'Manage' });
  }
  if (role === 'admin' || role === 'super_admin') {
    base.push({ to: '/admin', label: 'Admin' });
  }

  base.push({ to: '/profile', label: 'Profile' });
  return base;
}

export default function Layout() {
  const { user, signOut } = useAuth();
  const connection = useConnection();
  const pending = usePendingWrites();
  const navigate = useNavigate();
  const TABS = tabsFor(user?.role);

  async function handleSignOut() {
    await signOut();
    navigate('/signin');
  }

  const initials = (user?.fullName ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>

      {/*
        Connection state is surfaced, not hidden. Someone whose signal
        just dropped needs to know why the page stopped updating, and
        needs to know their work is not lost.
      */}
      {!connection.online && (
        <div className="banner banner-offline" role="status">
          Offline. You can keep reading what has loaded
          {pending > 0 && `, and ${pending} change${pending === 1 ? '' : 's'} will send when you reconnect`}.
        </div>
      )}
      {connection.online && pending > 0 && (
        <div className="banner banner-sync" role="status">
          Sending {pending} saved change{pending === 1 ? '' : 's'}
        </div>
      )}
      {connection.online && connection.slow && (
        <div className="banner" role="status">
          Slow connection. Heavy activities will ask before loading.
        </div>
      )}

      <header className="masthead">
        <div className="masthead-inner">
          <Link to="/" className="brand-link" aria-label="YouthConnect home">
            <Brand size={30} />
          </Link>

          {/* Navigation sits inside the header on desktop rather than
              floating in its own container below it, which read as a
              detached element with no relationship to anything. */}
          {/*
            Profile is deliberately left out of the top nav on desktop,
            Coursera-style: it lives in the account dropdown below,
            reached through the avatar initials, rather than sitting as
            its own tab. It stays in the mobile bottom tabs (TABS,
            unfiltered) because a dropdown menu is a worse fit for a
            thumb-driven small screen than one more tab.
          */}
          <nav className="nav-inline" aria-label="Main">
            {TABS.filter((tab) => tab.label !== 'Profile').map((tab) => (
              <NavLink key={tab.to} to={tab.to} end={tab.end} className="nav-link">
                {tab.label}
              </NavLink>
            ))}
          </nav>

          {/* Coursera-style search pill. Points at Discover, which
              already has its own search field, so this is a real
              shortcut into it rather than a decoration. */}
          <Link to="/" className="nav-search" aria-label="Search activities">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <span>What do you want to learn?</span>
          </Link>

          <div className="masthead-end">
            {user ? (
              <details className="account">
                <summary className="avatar" aria-label="Account menu">{initials}</summary>
                <div className="account-menu">
                  <p className="account-name">{user?.fullName}</p>
                  <p className="account-role">{user?.role}</p>
                  {/* Profile lives here, Coursera-style, instead of as its
                      own top-level nav tab. */}
                  <nav className="account-menu-links">
                    <Link to="/profile" className="account-menu-link">Your profile</Link>
                  </nav>
                  <button type="button" className="btn btn-plain btn-block" onClick={handleSignOut}>
                    Sign out
                  </button>
                </div>
              </details>
            ) : (
              // The whole point of a public catalogue is that it is the
              // first thing anyone sees, signed in or not, so the entry
              // points into an account have to live right here rather
              // than past a wall this page no longer puts up.
              <div className="cluster" style={{ gap: '.5rem' }}>
                <Link to="/signin" className="btn btn-plain">Sign in</Link>
                <Link to="/register" className="btn">Join for free</Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="main" id="main">
        <Outlet />
      </main>

      {/* Bottom tabs on phones: thumb reach beats elegance on a 5 inch
          screen held one-handed. Hidden on desktop where the header nav
          takes over. */}
      <nav className="tabs" aria-label="Sections">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className="tab">
            <TabIcon name={tab.label} />
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function TabIcon({ name }) {
  const common = {
    width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true
  };

  if (name === 'Discover') {
    return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
  }
  if (name === 'Progress') {
    return <svg {...common}><path d="M4 19V10" /><path d="M10 19V5" /><path d="M16 19v-6" /><path d="M22 19H2" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></svg>;
}
