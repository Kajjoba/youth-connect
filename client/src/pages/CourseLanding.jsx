import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Weight } from '../components/ui.jsx';
import { Brand } from '../components/Brand.jsx';
import { Footer } from '../components/Footer.jsx';

/**
 * The course landing page.
 *
 * Reachable signed out, because a catalogue that needs an account
 * cannot be shared, and being shared is how this programme reaches
 * people. See ADR-018.
 *
 * The page answers, in this order, the questions someone actually asks:
 * what is this, what will I be able to do afterwards, how long will it
 * take me, who is teaching it, and what exactly is inside. Anything
 * that does not answer one of those is not on the page.
 */
export default function CourseLanding() {
  const { slug } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const { status, data, error: loadError, reload } = useResource(
    () => api.course(slug),
    [slug]
  );

  if (status === 'loading') return <div className="landing"><Loading rows={4} label="Loading course" /></div>;
  if (status === 'error') return <div className="landing"><Problem error={loadError} onRetry={reload} /></div>;
  if (!data) return null;

  const { course, syllabus, viewer } = data;

  async function enrol() {
    // Someone signed out who taps Enrol should land back here after
    // registering, not on a generic home page having lost the thread.
    if (!user) {
      navigate('/register', { state: { from: `/courses/${slug}` } });
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.enrol(course.id);
      navigate(`/learn/${course.id}`);
    } catch (enrolError) {
      setError(enrolError.message);
      setBusy(false);
    }
  }

  const pace = course.weeks && course.hours_per_week
    ? `${course.weeks} week${course.weeks === 1 ? '' : 's'}, about ${fmt(course.hours_per_week)} hour${course.hours_per_week === 1 ? '' : 's'} a week`
    : `About ${Math.round(course.totalMinutes / 60)} hours in total`;

  return (
    <div className="landing">
      {/* Signed-out visitors get a minimal header: this page may be the
          first thing they ever see of the platform. */}
      {!user && (
        <header className="landing-bar">
          <Link to="/signin" className="brand-link"><Brand size={26} /></Link>
          <Link to="/signin" className="btn btn-quiet">Sign in</Link>
        </header>
      )}

      {/* Coursera's dark navy intro band: full width of the viewport,
          holding just the title, tags and key facts. The rest of the
          content stays on the plain light background below it. */}
      <div className="hero-band">
        <div className="hero-band-inner">
          <div className="cluster" style={{ marginBottom: '.75rem' }}>
            <span className={`tag tag-type-${course.type}`}>{course.type}</span>
            <span className="tag">{course.level}</span>
            {course.awards_certificate && (
              <span className="tag tag-live">Certificate</span>
            )}
          </div>

          <h1>{course.title}</h1>
          <p className="landing-summary">{course.summary}</p>

          <div className="cluster landing-facts">
            <Fact value={pace} label="Pace" />
            <Fact value={`${course.itemCount}`} label="Items" />
            <Fact value={`${course.enrolled_count}`} label="Enrolled" />
            {course.payload_kb > 0 && (
              <div>
                <Weight kb={course.payload_kb} />
                <div className="landing-fact-label">Data to complete</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="landing-body">
        <article className="landing-main">
          {course.outcomes?.length > 0 && (
            <section className="landing-section">
              <h2>What you will learn</h2>
              <ul className="outcomes">
                {course.outcomes.map((outcome, index) => (
                  <li key={index}>
                    <CheckMark />
                    <span>{outcome}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {course.skills?.length > 0 && (
            <section className="landing-section">
              <h2>Skills you will gain</h2>
              {/*
                Skills, not tags. Tags are topical and used for
                browsing; these are what a participant can put in front
                of an employer, and what Level Two team matching
                queries against to build complementary teams.
              */}
              <div className="chips">
                {course.skills.map((skill) => (
                  <span className="chip chip-static" key={skill}>{skill}</span>
                ))}
              </div>
            </section>
          )}

          {course.description && (
            <section className="landing-section">
              <h2>About this course</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{course.description}</p>
            </section>
          )}

          {course.prerequisites?.length > 0 && (
            <section className="landing-section">
              <h2>Before you start</h2>
              <ul className="plain-list">
                {course.prerequisites.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </section>
          )}

          <section className="landing-section">
            <div className="between" style={{ alignItems: 'baseline' }}>
              <h2>Syllabus</h2>
              <span className="muted numeric">
                {syllabus.length} section{syllabus.length === 1 ? '' : 's'}
                {' · '}{describeBreakdown(course.breakdown)}
              </span>
            </div>

            {syllabus.map((module) => (
              <SyllabusModule key={module.id} module={module} />
            ))}

            {syllabus.length === 0 && (
              <p className="muted">The facilitator is still preparing the content.</p>
            )}
          </section>

          {(course.instructor_name || course.instructor_note) && (
            <section className="landing-section">
              <h2>Your facilitator</h2>
              <div className="instructor">
                <div className="instructor-avatar">
                  {course.instructor_avatar
                    ? <img src={course.instructor_avatar} alt="" width="56" height="56" loading="lazy" />
                    : <span>{initials(course.instructor_name)}</span>}
                </div>
                <div>
                  <strong>{course.instructor_name}</strong>
                  {course.instructor_headline && (
                    <p className="muted" style={{ margin: '.125rem 0 0', fontSize: '.875rem' }}>
                      {course.instructor_headline}
                    </p>
                  )}
                  {course.instructor_note && (
                    <p style={{ margin: '.5rem 0 0' }}>{course.instructor_note}</p>
                  )}
                </div>
              </div>
            </section>
          )}
        </article>

        {/* The enrol panel sticks on a laptop and sits at the top on a
            phone, because on a small screen the decision should not be
            eight scrolls away from the thing it decides about. */}
        <aside className="landing-aside">
          <div className="enrol-card">
            {error && <div className="notice notice-bad" role="alert">{error}</div>}

            {viewer.completed ? (
              <>
                <p className="enrol-state">You completed this course.</p>
                <Link className="btn btn-block btn-lg" to="/certificates">
                  View your certificate
                </Link>
                <Link className="btn btn-plain btn-block" to={`/learn/${course.id}`}
                      style={{ marginTop: '.5rem' }}>
                  Review the material
                </Link>
              </>
            ) : viewer.enrolled ? (
              <>
                <p className="enrol-state">You are enrolled.</p>
                <Link className="btn btn-block btn-lg" to={`/learn/${course.id}`}>
                  Continue learning
                </Link>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-block btn-lg"
                        onClick={enrol} disabled={busy}>
                  {busy ? 'Enrolling' : user ? 'Enrol for free' : 'Create an account to enrol'}
                </button>
                {!user && (
                  <p className="muted" style={{ fontSize: '.8125rem', marginTop: '.5rem' }}>
                    Already have one? <Link to="/signin">Sign in</Link>
                  </p>
                )}
              </>
            )}

            <dl className="enrol-facts">
              <div><dt>Level</dt><dd>{course.level}</dd></div>
              {course.weeks && <div><dt>Length</dt><dd>{course.weeks} weeks</dd></div>}
              {course.hours_per_week && (
                <div><dt>Effort</dt><dd>{fmt(course.hours_per_week)} hrs/week</dd></div>
              )}
              <div><dt>Language</dt><dd>{(course.languages ?? ['English']).join(', ')}</dd></div>
              {course.awards_certificate && (
                <div><dt>On finishing</dt><dd>Verifiable certificate</dd></div>
              )}
            </dl>

            {/*
              The data cost sits inside the decision panel, not buried in
              the detail. For someone on prepaid mobile data this is not
              a footnote, it is one of the two or three facts that
              decides whether they start at all.
            */}
            {course.payload_kb > 0 && (
              <p className="enrol-data">
                Completing this course downloads roughly{' '}
                <strong>{course.payload_kb < 1024
                  ? `${course.payload_kb} KB`
                  : `${(course.payload_kb / 1024).toFixed(1)} MB`}</strong> of material.
              </p>
            )}
          </div>
        </aside>
      </div>

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SyllabusModule({ module }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="syllabus-module">
      <button
        type="button"
        className="syllabus-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="syllabus-chevron" data-open={open} aria-hidden="true">›</span>
        <span className="syllabus-title">
          {module.week_offset ? `Week ${module.week_offset}: ` : ''}{module.title}
        </span>
        {/*
          Coursera writes "20 videos, 1 reading, 3 assignments · 7
          hours" per module rather than a bare item count, because that
          is what tells someone whether a week is heavy or light.
        */}
        <span className="muted numeric">
          {describeItems(module.items)}
          {module.totalMinutes > 0 && ` · ${module.totalMinutes} min`}
        </span>
      </button>

      {open && module.objectives?.length > 0 && (
        <div className="module-objectives">
          <h4>In this section you will</h4>
          <ul>
            {module.objectives.map((objective, index) => (
              <li key={index}>{objective}</li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <ul className="syllabus-items">
          {module.items.map((item) => (
            <li key={item.id}>
              <KindIcon kind={item.kind} />
              <span className="syllabus-item-title">{item.title}</span>
              <span className="muted numeric syllabus-item-meta">
                {labelFor(item.kind)} · {item.estimatedMinutes} min
                {item.materialBytes > 0 && ` · ${Math.round(item.materialBytes / 1024)} KB`}
                {item.hasTranscript && ' · transcript'}
              </span>
            </li>
          ))}
          {module.items.length === 0 && (
            <li className="muted">Nothing here yet</li>
          )}
        </ul>
      )}
    </section>
  );
}

function Fact({ value, label }) {
  return (
    <div>
      <div className="landing-fact-value">{value}</div>
      <div className="landing-fact-label">{label}</div>
    </div>
  );
}

function CheckMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="var(--primary)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12 5 5L20 6" />
    </svg>
  );
}

function KindIcon({ kind }) {
  const common = {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    className: 'syllabus-icon'
  };

  if (kind === 'video' || kind === 'audio') {
    return <svg {...common}><path d="M10 8.5v7l6-3.5z" /><rect x="3" y="4" width="18" height="16" rx="2" /></svg>;
  }
  if (kind === 'quiz' || kind === 'assignment') {
    return <svg {...common}><path d="M9 11l2 2 4-4" /><rect x="4" y="3" width="16" height="18" rx="2" /></svg>;
  }
  if (kind === 'document') {
    return <svg {...common}><path d="M14 3v5h5" /><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /></svg>;
  }
  if (kind === 'discussion') {
    return <svg {...common}><path d="M21 12a8 8 0 0 1-11.3 7.3L3 21l1.7-6.7A8 8 0 1 1 21 12z" /></svg>;
  }
  return <svg {...common}><path d="M4 5h16" /><path d="M4 10h16" /><path d="M4 15h11" /><path d="M4 20h8" /></svg>;
}

function labelFor(kind) {
  const labels = {
    reading: 'Reading', video: 'Video', audio: 'Audio', document: 'Document',
    link: 'Link', quiz: 'Quiz', assignment: 'Assignment', discussion: 'Discussion'
  };
  return labels[kind] ?? kind;
}

/** Per-module counts, the way Coursera writes them. */
function describeItems(items = []) {
  if (!items.length) return 'nothing yet';
  const counts = items.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${labelFor(kind).toLowerCase()}${n === 1 ? '' : 's'}`)
    .join(', ');
}

/** "6 readings, 2 quizzes" rather than "8 items". */
function describeBreakdown(breakdown = {}) {
  const parts = Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, count]) => `${count} ${labelFor(kind).toLowerCase()}${count === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function fmt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function initials(name) {
  return (name ?? '?').split(' ').slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}
