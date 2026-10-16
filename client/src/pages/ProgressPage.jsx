import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty, Progress as Bar } from '../components/ui.jsx';
import { useCountUp, useReveal } from '../lib/motion.js';

export default function ProgressPage() {
  const { status, data, error, reload } = useResource(() => api.progress(), []);

  if (status === 'loading') return <Loading rows={3} label="Loading your progress" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { summary, enrolments } = data;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Your progress</h1>
        <p>Everything you have enrolled in, and where you stand.</p>
      </header>

      <div className="panel">
        <div className="cluster" style={{ gap: '1.5rem' }}>
          <Stat value={summary.enrolled} label="Enrolled" />
          <Stat value={summary.inProgress} label="In progress" />
          <Stat value={summary.completed} label="Completed" />
          <Stat value={summary.minutesSpent} label="Minutes" />
        </div>
      </div>

      {/*
        Unread feedback is surfaced at the top rather than buried inside
        each activity. The brief's incident was a participant who could
        not see updated feedback: the fix is partly technical, and partly
        putting it somewhere they will actually look.
      */}
      {summary.unreadFeedback > 0 && (
        <div className="notice notice-good" role="status">
          You have {summary.unreadFeedback} new piece
          {summary.unreadFeedback === 1 ? '' : 's'} of feedback to read.
        </div>
      )}

      {enrolments.length === 0 && (
        <Empty
          title="You have not enrolled in anything yet"
          action={<Link className="btn" to="/">Browse activities</Link>}
        >
          Find an activity that fits your goals and the time you have.
        </Empty>
      )}

      {enrolments.length > 0 && (
        <div className="learning-grid">
          {enrolments.map((item, index) => (
            <EnrolmentCard key={item.enrolment_id} item={item} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

function EnrolmentCard({ item, index }) {
  // Cards settle into place as they scroll into view, staggered by
  // position so a long grid does not fade in as one flat block. Capped
  // at 6 steps so card 40 does not wait behind card 39 through a visible
  // queue; past that they all arrive together.
  const [ref, visible] = useReveal();
  const delay = Math.min(index, 6) * 60;

  return (
    <div
      className={`learning-card reveal${visible ? ' reveal-in' : ''}`}
      style={{ '--reveal-delay': `${delay}ms` }}
      ref={ref}
    >
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <Link to={`/activities/${item.activity_id}`} className="learning-card-title">
          {item.title}
        </Link>
        <span className={`tag${item.enrolment_status === 'completed' ? ' tag-live' : ''}`}>
          {item.enrolment_status.replace('_', ' ')}
        </span>
      </div>

      <Bar done={item.modules_done} total={item.modules_total} label="Sections completed" />

      <div className="row-foot">
        <span className="muted numeric">
          {Math.round(item.seconds_spent / 60)} min spent
        </span>
        <span className="muted numeric">
          {item.submissions_made} submission{item.submissions_made === 1 ? '' : 's'}
        </span>
        {item.unread_feedback > 0 && (
          <span className="tag tag-live">{item.unread_feedback} new feedback</span>
        )}
      </div>

      <div className="learning-card-cta">
        <Link className="btn btn-plain" to={`/learn/${item.activity_id}`}>
          {item.enrolment_status === 'completed' ? 'Review' : 'Continue'}
        </Link>
      </div>
    </div>
  );
}

function Stat({ value, label }) {
  const shown = useCountUp(value);
  return (
    <div>
      <div className="numeric stat-value" style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.1 }}>
        {shown}
      </div>
      <div className="muted" style={{ fontSize: '.75rem' }}>{label}</div>
    </div>
  );
}
