import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource, useConnection } from '../lib/hooks.js';
import { Loading, Problem, Empty, Weight } from '../components/ui.jsx';
import { useReveal } from '../lib/motion.js';

const TYPES = [
  ['', 'All activities'],
  ['course', 'Courses'],
  ['workshop', 'Workshops'],
  ['discussion', 'Discussions'],
  ['challenge', 'Challenges']
];

export default function Discover() {
  const connection = useConnection();
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [lightOnly, setLightOnly] = useState(false);

  // Debounce the search so typing does not fire a request per keystroke.
  // On a metered connection that difference is real money.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  // On a 2G connection, default to hiding heavy activities. The
  // participant can turn it off, but the sensible default is chosen for
  // them rather than leaving them to discover a 4 MB download.
  useEffect(() => {
    if (connection.slow || connection.saveData) setLightOnly(true);
  }, [connection.slow, connection.saveData]);

  const { status, data, error, reload } = useResource(
    () => api.activities({
      q: query || undefined,
      type: type || undefined,
      maxKb: lightOnly ? 300 : undefined,
      limit: 20
    }),
    [query, type, lightOnly]
  );

  const activities = data?.data ?? [];

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Discover activities</h1>
        <p>Learn at your own pace. Every activity shows what it costs in data before you open it.</p>
      </header>

      <div className="panel">
        <label className="field" htmlFor="search" style={{ marginBottom: '.75rem' }}>
          <span className="field-label">Search</span>
          <input
            id="search" className="input" type="search"
            placeholder="Try: AI, employability, collaboration"
            value={search} onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="cluster">
          <label className="field" htmlFor="type" style={{ marginBottom: 0, flex: '1 1 12rem' }}>
            <span className="field-label">Type</span>
            <select id="type" className="select" value={type} onChange={(event) => setType(event.target.value)}>
              {TYPES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="cluster" style={{ marginTop: '.75rem', cursor: 'pointer' }}>
          <input
            type="checkbox" checked={lightOnly} style={{ width: 18, height: 18, accentColor: 'var(--primary)' }}
            onChange={(event) => setLightOnly(event.target.checked)}
          />
          <span className="muted">Only show activities under 300 KB</span>
        </label>
      </div>

      {status === 'loading' && <Loading rows={4} label="Loading activities" />}
      {status === 'error' && <Problem error={error} onRetry={reload} />}

      {status !== 'loading' && activities.length === 0 && (
        <Empty
          title="Nothing matches that"
          action={
            <button type="button" className="btn btn-plain" onClick={() => { setSearch(''); setType(''); setLightOnly(false); }}>
              Clear filters
            </button>
          }
        >
          Try a different search, or clear the filters to see everything available.
        </Empty>
      )}

      {activities.length > 0 && (
        <div className="course-grid">
          {activities.map((activity, index) => (
            <ActivityCard key={activity.id} activity={activity} index={index} />
          ))}
        </div>
      )}

      {data?.page?.hasMore && (
        <p className="muted">More activities are available. Refine your search to narrow the list.</p>
      )}
    </div>
  );
}

/**
 * Each activity type gets its own color so the list is scannable by
 * shape of color rather than reading every label. This is the only
 * place four extra accent colors appear at once in the whole app; it is
 * deliberately not reused as a status language anywhere else, so a
 * workshop being gold never gets confused with anything the base
 * palette's gold otherwise means.
 */
function typeTagClass(type) {
  return `tag tag-type-${type}`;
}

/**
 * Card thumbnails stand in for a course image, which nothing in this
 * data model uploads. A colour band per type plus a simple icon reads
 * as a Coursera-style catalogue card without inventing artwork or,
 * worse, a fabricated star rating this platform has no data to back.
 */
function TypeIcon({ type }) {
  const common = {
    width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    className: 'course-card-banner-icon'
  };
  if (type === 'workshop') {
    return <svg {...common}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2.6 2.6 6-6a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.6-2.6z" /></svg>;
  }
  if (type === 'challenge') {
    return <svg {...common}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>;
  }
  if (type === 'discussion') {
    return <svg {...common}><path d="M21 12a8 8 0 0 1-11.3 7.3L3 21l1.7-6.7A8 8 0 1 1 21 12z" /></svg>;
  }
  return <svg {...common}><path d="M4 5h16" /><path d="M4 10h16" /><path d="M4 15h11" /><path d="M4 20h8" /></svg>;
}

function ActivityCard({ activity, index }) {
  const [ref, visible] = useReveal();
  // Staggered by list position, capped so a long results page settles
  // together rather than trickling in one row at a time.
  const delay = Math.min(index, 8) * 45;

  return (
    <Link
      to={`/courses/${activity.slug}`}
      className={`course-card reveal${visible ? ' reveal-in' : ''}`}
      style={{ '--reveal-delay': `${delay}ms` }}
      ref={ref}
    >
      <div className={`course-card-banner course-card-banner-${activity.type}`}>
        <TypeIcon type={activity.type} />
      </div>
      <div className="course-card-body">
        <p className="course-card-org">YouthConnect Programme</p>
        <h3 className="course-card-title">{activity.title}</h3>
        <p className="course-card-summary">{activity.summary}</p>
        <div className="course-card-foot">
          <span className={typeTagClass(activity.type)}>{activity.type}</span>
          {activity.is_enrolled && <span className="tag tag-live">Enrolled</span>}
          <span className="muted numeric">{activity.estimated_minutes} min</span>
        </div>
        <div className="course-card-foot">
          <Weight kb={activity.payload_kb} />
        </div>
      </div>
    </Link>
  );
}
