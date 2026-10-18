import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty } from '../components/ui.jsx';

export default function Admin() {
  const [tab, setTab] = useState('overview');

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Administration</h1>
        <p>Platform health, accounts and access.</p>
      </header>

      <div className="segmented" role="tablist" aria-label="Admin sections">
        {[
          ['overview', 'Overview'],
          ['reports', 'Reports'],
          ['users', 'People'],
          ['security', 'Security']
        ].map(([key, label]) => (
          <button
            key={key} type="button" role="tab"
            aria-selected={tab === key}
            className={`segment${tab === key ? ' segment-on' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'reports' && <Reports />}
      {tab === 'users' && <People />}
      {tab === 'security' && <Security />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Overview() {
  const { status, data, error, reload } = useResource(() => api.adminOverview(), []);

  if (status === 'loading') return <Loading rows={3} label="Loading overview" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { people, activities, learning, security, countries } = data;

  const completionRate = learning.enrolments
    ? Math.round((learning.completions / learning.enrolments) * 100)
    : 0;

  return (
    <div className="stack">
      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>People</h2>
        <div className="cluster" style={{ gap: '1.5rem' }}>
          <Stat value={people.total} label="Accounts" />
          <Stat value={people.participants} label="Participants" />
          <Stat value={people.facilitators} label="Facilitators" />
          <Stat value={people.mentors} label="Mentors" />
          <Stat value={people.joined_this_week} label="Joined this week" />
          {people.suspended > 0 && <Stat value={people.suspended} label="Suspended" urgent />}
        </div>
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Learning</h2>
        <div className="cluster" style={{ gap: '1.5rem' }}>
          <Stat value={activities.published} label="Published" />
          <Stat value={activities.drafts} label="Drafts" />
          <Stat value={learning.enrolments} label="Enrolments" />
          <Stat value={`${completionRate}%`} label="Completion rate" />
          <Stat
            value={learning.awaiting_grading}
            label="Awaiting grading"
            urgent={learning.awaiting_grading > 0}
          />
        </div>
      </section>

      {/*
        Country spread is specific to this programme. The brief is about
        cross-border exchange, so an admin needs to see whether one
        country dominates rather than only a headline total.
      */}
      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>Reach across the region</h2>
        {countries.length === 0
          ? <p className="muted">No participants yet.</p>
          : (
            <div className="stack">
              {countries.map((row) => {
                const share = people.participants
                  ? Math.round((row.participants / people.participants) * 100)
                  : 0;
                return (
                  <div key={row.country}>
                    <div className="between" style={{ marginBottom: '.25rem' }}>
                      <span>{row.country}</span>
                      <span className="muted numeric">{row.participants} ({share}%)</span>
                    </div>
                    <div className="progress-rail">
                      <div className="progress-fill" style={{ width: `${share}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </section>

      {security.denied_today > 0 && (
        <div className="notice notice-bad" role="status">
          {security.denied_today} access attempt{security.denied_today === 1 ? '' : 's'} refused
          in the last 24 hours, across {security.actors_denied_today} account
          {security.actors_denied_today === 1 ? '' : 's'}. Check the Security tab.
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Per-course engagement and outcomes.
 *
 * The Overview tab answers "is the platform healthy". This answers the
 * question a coordinator actually has to act on: which specific course
 * is working, and which one is quietly losing people or grading slowly.
 */
function Reports() {
  const { status, data, error, reload } = useResource(() => api.adminReports(), []);

  if (status === 'loading') return <Loading rows={3} label="Loading reports" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { activities, feedbackTurnaround } = data;

  return (
    <div className="stack">
      {feedbackTurnaround.sampled > 0 && (
        <div className="notice" role="status">
          Feedback reaches a participant in <strong>{feedbackTurnaround.avgHours}h</strong> on
          average, across {feedbackTurnaround.sampled} graded submission
          {feedbackTurnaround.sampled === 1 ? '' : 's'}.
        </div>
      )}

      {activities.length === 0 && (
        <Empty title="No activities yet">Publish a course to see engagement data here.</Empty>
      )}

      {activities.length > 0 && (
        <div className="rows">
          {activities.map((row) => (
            <div className="row" key={row.id}>
              <div className="between" style={{ alignItems: 'flex-start', marginBottom: '.5rem' }}>
                <div>
                  <h3 className="row-title" style={{ fontSize: '1rem' }}>{row.title}</h3>
                  <div className="cluster">
                    <span className="tag">{row.type}</span>
                    <span className={`tag${row.status === 'draft' ? ' tag-urgent' : ''}`}>
                      {row.status}
                    </span>
                  </div>
                </div>
                <div className="cluster" style={{ gap: '1.25rem' }}>
                  <Stat value={row.enrolments} label="Enrolled" />
                  <Stat value={row.inProgress} label="In progress" />
                  <Stat value={`${row.completionRate}%`} label="Completed" />
                </div>
              </div>

              <div style={{ marginBottom: row.assessment ? '.75rem' : 0 }}>
                <div className="between" style={{ marginBottom: '.25rem' }}>
                  <span className="muted" style={{ fontSize: '.8125rem' }}>Average progress</span>
                  <span className="muted numeric" style={{ fontSize: '.8125rem' }}>{row.avgProgress}%</span>
                </div>
                <div className="progress-rail">
                  <div className="progress-fill" style={{ width: `${row.avgProgress}%` }} />
                </div>
              </div>

              {row.assessment && (row.assessment.graded > 0 || row.assessment.awaitingGrading > 0) && (
                <div className="cluster">
                  {row.assessment.avgScore !== null && (
                    <span className="muted numeric">Avg score {row.assessment.avgScore}</span>
                  )}
                  {row.assessment.passRate !== null && (
                    <span className="muted numeric">{row.assessment.passRate}% pass rate</span>
                  )}
                  {row.assessment.awaitingGrading > 0 && (
                    <span className="tag tag-urgent">
                      {row.assessment.awaitingGrading} awaiting grading
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function People() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const { status, data, error: loadError, reload } = useResource(
    () => api.adminUsers({ q: search || undefined, role: role || undefined, limit: 30 }),
    [search, role]
  );

  async function change(userId, changes) {
    setBusyId(userId);
    setError(null);
    try {
      await api.adminUpdateUser(userId, changes);
      await reload();
    } catch (changeError) {
      setError(changeError.message);
    } finally {
      setBusyId(null);
    }
  }

  const users = data?.data ?? [];

  return (
    <div className="stack">
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <div className="panel">
        <label className="field" htmlFor="user-search" style={{ marginBottom: '.75rem' }}>
          <span className="field-label">Search</span>
          <input
            id="user-search" className="input" type="search"
            placeholder="Name or email"
            value={search} onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="field" htmlFor="user-role" style={{ marginBottom: 0 }}>
          <span className="field-label">Role</span>
          <select id="user-role" className="select" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">All roles</option>
            <option value="participant">Participants</option>
            <option value="facilitator">Facilitators</option>
            <option value="mentor">Mentors</option>
            <option value="admin">Administrators</option>
            <option value="super_admin">Super administrators</option>
            <option value="stakeholder">Stakeholders</option>
          </select>
        </label>
      </div>

      {status === 'loading' && <Loading rows={4} label="Loading people" />}
      {status === 'error' && <Problem error={loadError} onRetry={reload} />}

      {status !== 'loading' && users.length === 0 && (
        <Empty title="Nobody matches that">Try a different search.</Empty>
      )}

      {users.length > 0 && (
        <div className="rows">
          {users.map((person) => {
            const isSelf = person.id === user.id;
            const callerIsSuperAdmin = user.role === 'super_admin';
            const targetIsAdminTier = person.role === 'admin' || person.role === 'super_admin';

            // ADR-028: the server refuses anything touching the admin
            // tier from a plain admin, whether that is a target who
            // already holds admin-tier access or a role change that
            // would grant it. The controls mirror that here so a plain
            // admin sees why a row is locked rather than hitting a 403
            // on a button that looked like it would work.
            const locked = !callerIsSuperAdmin && targetIsAdminTier;

            return (
              <div className="row" key={person.id}>
                <div className="between" style={{ alignItems: 'flex-start', marginBottom: '.5rem' }}>
                  <div>
                    <h3 className="row-title" style={{ fontSize: '1rem' }}>
                      {person.full_name ?? person.email}
                      {isSelf && <span className="tag" style={{ marginLeft: '.5rem' }}>you</span>}
                      {person.role === 'super_admin' && (
                        <span className="tag tag-live" style={{ marginLeft: '.5rem' }}>super admin</span>
                      )}
                      {person.role === 'admin' && (
                        <span className="tag" style={{ marginLeft: '.5rem' }}>admin</span>
                      )}
                    </h3>
                    <p className="row-summary" style={{ marginBottom: '.25rem' }}>{person.email}</p>
                    <div className="cluster">
                      {person.country && <span className="muted">{person.country}</span>}
                      <span className="muted numeric">{person.enrolments} enrolments</span>
                      {person.last_login_at && (
                        <span className="muted">
                          Last seen {new Date(person.last_login_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`tag${person.status === 'suspended' ? ' tag-urgent' : ''}`}>
                    {person.status}
                  </span>
                </div>

                {/*
                  Controls are hidden for your own account. The server
                  refuses a self-change anyway, but offering a control
                  that always fails is a trap rather than a safeguard.
                */}
                {!isSelf && (
                  <div className="cluster" style={{ alignItems: 'center' }}>
                    <select
                      className="select"
                      style={{ maxWidth: '12rem' }}
                      value={person.role}
                      disabled={busyId === person.id || locked}
                      onChange={(event) => change(person.id, { role: event.target.value })}
                      aria-label={`Role for ${person.full_name ?? person.email}`}
                    >
                      <option value="participant">Participant</option>
                      <option value="facilitator">Facilitator</option>
                      <option value="mentor">Mentor</option>
                      <option value="stakeholder">Stakeholder</option>
                      {/*
                        A plain admin never sees these as choices to
                        pick for someone else, not just a disabled
                        select: granting admin-tier access is exactly
                        the action ADR-028 reserves for a super admin.
                        The row's own current value is always included
                        though, so a locked, disabled select still
                        displays the truth rather than an empty box.
                      */}
                      {(callerIsSuperAdmin || person.role === 'admin') && (
                        <option value="admin">Administrator</option>
                      )}
                      {(callerIsSuperAdmin || person.role === 'super_admin') && (
                        <option value="super_admin">Super administrator</option>
                      )}
                    </select>

                    <button
                      type="button"
                      className="btn btn-plain"
                      disabled={busyId === person.id || locked}
                      onClick={() => change(person.id, {
                        status: person.status === 'suspended' ? 'active' : 'suspended'
                      })}
                    >
                      {person.status === 'suspended' ? 'Restore' : 'Suspend'}
                    </button>

                    {locked && (
                      <span className="muted" style={{ fontSize: '.8rem' }}>
                        Only a super admin can change this account
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The security console.
 *
 * This is the screen to have open during the CAT 2 defence. Perform the
 * URL-tampering attack from the brief in one browser, refresh this in
 * another, and the attempt is listed with the account that made it.
 */
function Security() {
  const { status, data, error, reload } = useResource(() => api.adminSecurity(), []);

  if (status === 'loading') return <Loading rows={3} label="Loading security events" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { suspects, denials, passwordChanges } = data;

  return (
    <div className="stack">
      <div className="between">
        <h2 style={{ fontSize: '1.125rem' }}>Refused access attempts</h2>
        <button type="button" className="btn btn-quiet" onClick={reload}>Refresh</button>
      </div>

      {suspects.length > 0 && (
        <div className="notice notice-bad" role="alert">
          <strong>Possible enumeration.</strong>
          <p style={{ margin: '.5rem 0 0' }}>
            {suspects.length} account{suspects.length === 1 ? '' : 's'} refused access
            to several different records in a short window. That pattern
            is someone trying identifiers rather than making mistakes.
          </p>
          <ul style={{ margin: '.5rem 0 0', paddingLeft: '1.25rem' }}>
            {suspects.map((suspect, index) => (
              <li key={index} className="numeric">
                {suspect.distinct_targets} distinct {suspect.resource_type} targets,
                {' '}{suspect.denied_attempts} attempts
              </li>
            ))}
          </ul>
        </div>
      )}

      {denials.length === 0 && (
        <Empty title="No refused attempts recorded">
          Every authorisation decision is logged. Nothing has been refused
          recently.
        </Empty>
      )}

      {denials.length > 0 && (
        <div className="rows">
          {denials.map((event, index) => (
            <div className="row" key={index}>
              <div className="between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <h3 className="row-title" style={{ fontSize: '.9375rem' }}>
                    {event.actor_name ?? event.actor_email ?? 'Unauthenticated'}
                  </h3>
                  <p className="row-summary" style={{ marginBottom: '.25rem' }}>
                    Tried <strong>{event.action}</strong> on {event.resource_type}
                  </p>
                  <div className="cluster">
                    <span className="tag tag-urgent">{event.reason}</span>
                    {event.ip_address && <span className="muted numeric">{event.ip_address}</span>}
                  </div>
                </div>
                <span className="muted numeric" style={{ fontSize: '.75rem' }}>
                  {new Date(event.created_at).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {passwordChanges.length > 0 && (
        <section>
          <h2 style={{ fontSize: '1.125rem', marginBottom: '.75rem' }}>Recent password changes</h2>
          <div className="rows">
            {passwordChanges.map((change, index) => (
              <div className="row" key={index}>
                <div className="between">
                  <span>{change.full_name ?? change.email}</span>
                  <span className="muted numeric" style={{ fontSize: '.75rem' }}>
                    {new Date(change.changed_at).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ value, label, urgent }) {
  return (
    <div>
      <div
        className="numeric"
        style={{
          fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.1,
          color: urgent ? 'var(--alert)' : 'inherit'
        }}
      >
        {value}
      </div>
      <div className="muted" style={{ fontSize: '.75rem' }}>{label}</div>
    </div>
  );
}
