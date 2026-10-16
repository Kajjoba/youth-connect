import { useState } from 'react';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty } from './ui.jsx';

/**
 * The course timeline.
 *
 * Studied from Coursera, adapted for this population (ADR-020). Their
 * deadlines are personalised and soft, and copying that is deliberate:
 * a fixed cohort date punishes a participant for their electricity
 * supply, not their effort.
 *
 * So the language here is careful. Never "late", which is a verdict on
 * the person. "Behind schedule" is a fact about a suggestion, and it
 * comes with the offer to move the suggestion.
 */
export function CourseTimeline({ activityId }) {
  const [resetting, setResetting] = useState(false);
  const { status, data, error, reload } = useResource(
    () => api.schedule(activityId),
    [activityId]
  );

  if (status === 'loading') return <Loading rows={2} label="Loading your timeline" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { schedule, summary } = data;
  if (!schedule.length) return null;

  const dated = schedule.filter((row) => row.due_at);
  if (!dated.length) {
    return (
      <div className="panel">
        <h3 className="timeline-head">Your pace</h3>
        <p className="muted" style={{ margin: 0, fontSize: '.875rem' }}>
          This course has no set schedule. Work through it whenever suits you.
        </p>
      </div>
    );
  }

  async function reset() {
    setResetting(true);
    try {
      await api.resetSchedule(activityId);
      await reload();
    } finally {
      setResetting(false);
    }
  }

  return (
    <section className="panel timeline">
      <div className="between" style={{ alignItems: 'baseline', marginBottom: '.75rem' }}>
        <h3 className="timeline-head">Your timeline</h3>
        <span className="muted numeric">
          {summary.completed} of {summary.total} done
        </span>
      </div>

      {summary.behind > 0 && (
        <div className="notice" role="status" style={{ marginBottom: '.75rem' }}>
          <strong>You are behind your suggested pace.</strong>
          <p style={{ margin: '.375rem 0 .625rem', fontSize: '.875rem' }}>
            Nothing is locked and nothing is lost. These dates are a
            plan, not a rule. If the plan no longer fits, start it again
            from today.
          </p>
          <button type="button" className="btn btn-plain" onClick={reset} disabled={resetting}>
            {resetting ? 'Resetting' : 'Restart my schedule from today'}
          </button>
        </div>
      )}

      <ol className="timeline-list">
        {schedule.map((row) => (
          <li key={row.module_id} className={rowClass(row)}>
            <span className="timeline-dot" aria-hidden="true" />
            <span className="timeline-body">
              <span className="timeline-title">{row.title}</span>
              <span className="timeline-meta">
                {row.status === 'completed'
                  ? `Completed${row.completed_at ? ` ${shortDate(row.completed_at)}` : ''}`
                  : row.due_at
                    ? `${row.is_overdue ? 'Was suggested for' : 'Suggested by'} ${shortDate(row.due_at)}`
                    : 'No set date'}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function rowClass(row) {
  if (row.status === 'completed') return 'timeline-item timeline-done';
  if (row.is_overdue) return 'timeline-item timeline-behind';
  return 'timeline-item';
}

function shortDate(value) {
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * The grades table.
 *
 * Lists every assessment in the course, attempted or not. The
 * unattempted rows are the reason this exists: a page that shows only
 * what you have done cannot tell you what you still owe, which is the
 * question someone opens a grades page to answer.
 */
export function GradeBook({ activityId }) {
  const { status, data, error, reload } = useResource(
    () => api.grades(activityId),
    [activityId]
  );

  if (status === 'loading') return <Loading rows={3} label="Loading your grades" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { grades, summary, activity } = data;

  if (!grades.length) {
    return <Empty title="No assessments in this course">
      There is nothing to be graded on here.
    </Empty>;
  }

  return (
    <div className="stack">
      <div className="panel">
        <div className="cluster" style={{ gap: '1.5rem' }}>
          <Stat value={summary.overall === null ? '—' : `${summary.overall}%`} label="Overall" />
          <Stat value={`${summary.passed}/${summary.total}`} label="Passed" />
          {summary.outstanding > 0 && (
            <Stat value={summary.outstanding} label="Not attempted" urgent />
          )}
        </div>

        {activity?.awards_certificate && (
          <p className="muted" style={{ margin: '.75rem 0 0', fontSize: '.875rem' }}>
            {summary.allPassed
              ? 'You have passed everything this course requires.'
              : activity.requires_pass
                ? 'Every assessment must be passed before the certificate is issued.'
                : 'This course awards a certificate on completion.'}
          </p>
        )}
      </div>

      <table className="grades">
        <thead>
          <tr>
            <th scope="col">Assessment</th>
            <th scope="col">Due</th>
            <th scope="col" className="numeric">Score</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {grades.map((row) => (
            <tr key={row.assessment_id}>
              <td>
                <span className="grade-title">{row.title}</span>
                <span className="grade-sub">
                  {row.type}
                  {row.submission_count > 0 && ` · ${row.submission_count} attempt${row.submission_count === 1 ? '' : 's'}`}
                </span>
              </td>
              <td className="muted">
                {row.due_at ? shortDate(row.due_at) : '—'}
              </td>
              <td className="numeric">
                {row.best_score === null
                  ? '—'
                  : `${Number(row.best_score)} / ${Number(row.max_score)}`}
              </td>
              <td>
                {row.passed === true && <span className="tag tag-live">Passed</span>}
                {row.passed === false && <span className="tag tag-urgent">Not yet</span>}
                {row.passed === null && row.submission_count > 0 && (
                  <span className="tag">Awaiting marking</span>
                )}
                {row.passed === null && row.submission_count === 0 && (
                  <span className="muted">Not attempted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ value, label, urgent }) {
  return (
    <div>
      <div className="numeric" style={{
        fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.1,
        color: urgent ? 'var(--alert)' : 'inherit'
      }}>{value}</div>
      <div className="muted" style={{ fontSize: '.75rem' }}>{label}</div>
    </div>
  );
}
