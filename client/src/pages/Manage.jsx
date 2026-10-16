import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty } from '../components/ui.jsx';

/**
 * The facilitator's home.
 *
 * Ordered by what needs attention rather than alphabetically: the whole
 * reason a facilitator opens this page is to find out what is waiting
 * for them, and a list sorted by title makes them hunt for it.
 */
export default function Manage() {
  const { status, data, error, reload } = useResource(() => api.facilitatorActivities(), []);

  if (status === 'loading') return <Loading rows={3} label="Loading your activities" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { summary, activities } = data;

  // Anything with work waiting comes first, then drafts, then the rest.
  const sorted = [...activities].sort((a, b) =>
    (b.awaiting_grading - a.awaiting_grading)
    || (a.status === 'draft' ? -1 : 0) - (b.status === 'draft' ? -1 : 0)
  );

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Manage activities</h1>
        <p>Author programme content and review participant work.</p>
      </header>

      <div className="panel">
        <div className="cluster" style={{ gap: '1.5rem' }}>
          <Stat value={summary.total} label="Activities" />
          <Stat value={summary.published} label="Published" />
          <Stat value={summary.drafts} label="Drafts" />
          <Stat value={summary.participants} label="Participants" />
          <Stat value={summary.awaitingGrading} label="To grade" urgent={summary.awaitingGrading > 0} />
        </div>
      </div>

      {summary.awaitingGrading > 0 && (
        <div className="notice notice-good" role="status">
          {summary.awaitingGrading} submission{summary.awaitingGrading === 1 ? '' : 's'}
          {' '}waiting for your feedback.
        </div>
      )}

      {activities.length === 0 && (
        <Empty
          title="You have not created any activities yet"
          action={<Link className="btn" to="/manage/new">Create your first activity</Link>}
        >
          Activities are the learning units participants enrol in.
        </Empty>
      )}

      {activities.length > 0 && (
        <>
          <div className="between">
            <h2 style={{ fontSize: '1.125rem' }}>Your activities</h2>
            <Link className="btn btn-quiet" to="/manage/new">New activity</Link>
          </div>

          <div className="rows">
            {sorted.map((activity) => (
              <Link key={activity.id} to={`/manage/${activity.id}`} className="row">
                <div className="between" style={{ alignItems: 'flex-start' }}>
                  <h3 className="row-title">{activity.title}</h3>
                  <span className={`tag${activity.status === 'published' ? ' tag-live' : ''}`}>
                    {activity.status}
                  </span>
                </div>
                <p className="row-summary">{activity.summary}</p>
                <div className="row-foot">
                  <span className="muted numeric">{activity.module_count} sections</span>
                  <span className="muted numeric">{activity.enrolled_count} enrolled</span>
                  <span className="muted numeric">{activity.completed_count} completed</span>
                  {activity.awaiting_grading > 0 && (
                    <span className="tag tag-urgent">
                      {activity.awaiting_grading} to grade
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </>
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
