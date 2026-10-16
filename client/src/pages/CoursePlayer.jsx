import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource, useConnection } from '../lib/hooks.js';
import { Loading, Problem, Empty, Weight, Progress } from '../components/ui.jsx';
import { CourseTimeline, GradeBook } from '../components/Pacing.jsx';
import { confettiBurst } from '../lib/motion.js';

/**
 * The course player.
 *
 * Layout borrowed from Coursera and the platforms that copied it: a
 * persistent list of modules on the left, one item in the main pane.
 * It works because a learner's two questions are always "where am I"
 * and "what is next", and both are answered without navigating away.
 *
 * On a phone the sidebar becomes a collapsible drawer. A fixed sidebar
 * on a 360px screen leaves roughly 140px for the content, which is not
 * a layout, it is a compromise nobody asked for.
 */
export default function CoursePlayer() {
  const { id } = useParams();
  const connection = useConnection();
  const [activeId, setActiveId] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Coursera puts Grades beside Course Material in the same sidebar.
  // Same idea here, as a tab rather than a separate page, so a learner
  // checking a mark does not lose their place in the course.
  const [view, setView] = useState('content');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  const { status, data, error, reload } = useResource(() => api.activity(id), [id]);

  // Flatten to a single ordered list so "next" and "previous" are one
  // index step rather than a nested search every time.
  const sequence = useMemo(() => {
    if (!data?.modules) return [];
    return data.modules.flatMap((module) =>
      (module.items ?? []).map((item) => ({ ...item, moduleTitle: module.title }))
    );
  }, [data]);

  // Open where the participant left off, not at the beginning. Someone
  // returning on a slow connection should not have to scroll to find
  // their place.
  useEffect(() => {
    if (activeId || sequence.length === 0) return;
    const next = sequence.find((item) => item.progress_status !== 'completed');
    setActiveId((next ?? sequence[0]).id);
  }, [sequence, activeId]);

  if (status === 'loading') return <Loading rows={4} label="Loading course" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { activity, modules, enrolment, permissions } = data;

  if (!enrolment) {
    return (
      <div className="stack">
        <header className="page-head">
          <h1>{activity.title}</h1>
          <p>{activity.summary}</p>
        </header>
        <Empty
          title="You are not enrolled"
          action={<Link className="btn" to={`/activities/${id}`}>Go to the activity page</Link>}
        >
          Enrol first to open the course content.
        </Empty>
      </div>
    );
  }

  const active = sequence.find((item) => item.id === activeId);
  const activeIndex = sequence.findIndex((item) => item.id === activeId);
  const done = sequence.filter((item) => item.progress_status === 'completed').length;

  async function markDone(item, advance = true) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.setItemProgress(id, item.id, { status: 'completed' });
      if (result?.queued) {
        setMessage({ tone: 'good', text: 'Saved on your device. It will sync when you reconnect.' });
      } else {
        await reload();
      }
      if (advance && activeIndex < sequence.length - 1) {
        setActiveId(sequence[activeIndex + 1].id);
      }
    } catch (markError) {
      setMessage({ tone: 'bad', text: markError.message });
    } finally {
      setBusy(false);
    }
  }

  function choose(itemId) {
    setActiveId(itemId);
    setDrawerOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="player">
      <button
        type="button"
        className="btn btn-plain player-drawer-toggle"
        onClick={() => setDrawerOpen(!drawerOpen)}
        aria-expanded={drawerOpen}
      >
        {drawerOpen ? 'Hide course content' : 'Course content'}
        <span className="muted numeric">{done}/{sequence.length}</span>
      </button>

      <aside className={`player-sidebar${drawerOpen ? ' player-sidebar-open' : ''}`}>
        <div className="player-sidebar-head">
          <Link to={`/activities/${id}`} className="muted" style={{ fontSize: '.75rem' }}>
            Back to activity
          </Link>
          <h2 className="player-course-title">{activity.title}</h2>
          <Progress done={done} total={sequence.length} label="Course progress" />

          <div className="segmented" style={{ marginTop: 'var(--space-3)' }} role="tablist">
            {[['content', 'Content'], ['grades', 'Grades']].map(([key, label]) => (
              <button
                key={key} type="button" role="tab"
                aria-selected={view === key}
                className={`segment${view === key ? ' segment-on' : ''}`}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {view === 'content' && <nav aria-label="Course content">
          {modules.map((module) => {
            const items = module.items ?? [];
            const moduleDone = items.filter((i) => i.progress_status === 'completed').length;
            const complete = items.length > 0 && moduleDone === items.length;

            return (
              <div className="player-module" key={module.id}>
                <h3 className="player-module-head">
                  <Tick done={complete} />
                  <span>{module.title}</span>
                </h3>
                <ul className="player-items">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`player-item${item.id === activeId ? ' player-item-active' : ''}`}
                        onClick={() => choose(item.id)}
                        aria-current={item.id === activeId ? 'true' : undefined}
                      >
                        <Tick done={item.progress_status === 'completed'} small />
                        <span className="player-item-text">
                          <span className="player-item-title">{item.title}</span>
                          <span className="player-item-meta">
                            {labelFor(item.kind)} · {item.estimated_minutes} min
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                  {items.length === 0 && (
                    <li className="muted" style={{ padding: '.25rem 0 .25rem 1.75rem', fontSize: '.8125rem' }}>
                      Nothing here yet
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </nav>}

        {view === 'content' && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <CourseTimeline activityId={id} />
          </div>
        )}
      </aside>

      <main className="player-main">
        {view === 'grades' ? (
          <>
            <h1 style={{ marginBottom: '1rem' }}>Grades</h1>
            <GradeBook activityId={id} />
          </>
        ) : (
        <>
        {message && (
          <div className={`notice notice-${message.tone}`} role="status">{message.text}</div>
        )}

        {!active && (
          <Empty title="No content yet">
            The facilitator has not added anything to this course.
          </Empty>
        )}

        {active && (
          <article>
            <p className="muted" style={{ margin: 0, fontSize: '.8125rem' }}>
              {active.moduleTitle}
            </p>
            <h1 style={{ margin: '.25rem 0 .5rem' }}>{active.title}</h1>

            <div className="cluster" style={{ marginBottom: '1.5rem' }}>
              <span className="tag">{labelFor(active.kind)}</span>
              {!active.is_required && <span className="tag">optional</span>}
              <span className="muted numeric">{active.estimated_minutes} min</span>
              {(active.materials ?? []).length > 0 && (
                <Weight kb={Math.round(
                  active.materials.reduce((sum, m) => sum + m.byteSize, 0) / 1024
                )} />
              )}
            </div>

            <ItemBody item={active} slowConnection={connection.slow} />

            <LessonComments itemId={active.id} />

            <div className="player-nav">
              <button
                type="button"
                className="btn btn-plain"
                disabled={activeIndex <= 0}
                onClick={() => choose(sequence[activeIndex - 1].id)}
              >
                Previous
              </button>

              {active.progress_status === 'completed' ? (
                <button
                  type="button"
                  className="btn"
                  disabled={activeIndex >= sequence.length - 1}
                  onClick={() => choose(sequence[activeIndex + 1].id)}
                >
                  Next
                </button>
              ) : (
                <button type="button" className="btn" disabled={busy} onClick={() => markDone(active)}>
                  {busy ? 'Saving' : 'Mark complete and continue'}
                </button>
              )}
            </div>

            {done === sequence.length && sequence.length > 0 && (
              <CertificateBanner activityId={id} activityTitle={activity.title} />
            )}
          </article>
        )}
        </>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ItemBody({ item, slowConnection }) {
  const [showTranscript, setShowTranscript] = useState(slowConnection);

  return (
    <div className="stack">
      {item.kind === 'reading' && item.body && (
        <div className="reading" style={{ whiteSpace: 'pre-wrap' }}>{item.body}</div>
      )}

      {item.kind === 'video' && (
        <div className="video-placeholder" aria-hidden="true">
          <span className="video-placeholder-play">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
      )}

      {['video', 'audio'].includes(item.kind) && (
        <div className="panel">
          <p style={{ marginBottom: '.75rem' }}>
            This {item.kind} is hosted outside YouthConnect.
            {item.duration_seconds && ` It runs ${Math.round(item.duration_seconds / 60)} minutes.`}
          </p>

          {/*
            The cost warning is not a disclaimer. Ten minutes of video is
            roughly 50 MB, which on prepaid mobile data can exceed a
            week's bundle. Saying so before the tap is the difference
            between a choice and a surprise.
          */}
          {item.kind === 'video' && (
            <p className="notice" style={{ margin: '0 0 .75rem' }}>
              Video uses roughly 5 MB per minute. On a metered connection
              this {item.duration_seconds ? `costs about ${Math.round(item.duration_seconds / 60 * 5)} MB` : 'can be expensive'}.
              {item.transcript && ' The transcript below covers the same material for a few kilobytes.'}
            </p>
          )}

          <div className="cluster">
            <a className="btn" href={item.external_url} target="_blank" rel="noreferrer">
              Open {item.kind}
            </a>
            {item.transcript && (
              <button type="button" className="btn btn-plain" onClick={() => setShowTranscript(!showTranscript)}>
                {showTranscript ? 'Hide transcript' : 'Read transcript instead'}
              </button>
            )}
          </div>
        </div>
      )}

      {item.kind === 'link' && item.external_url && (
        <a className="btn" href={item.external_url} target="_blank" rel="noreferrer">
          Open resource
        </a>
      )}

      {showTranscript && item.transcript && (
        <div className="reading" style={{ whiteSpace: 'pre-wrap' }}>{item.transcript}</div>
      )}

      {['quiz', 'assignment'].includes(item.kind) && item.assessment_id && (
        <Link className="btn" to={`/assessments/${item.assessment_id}`}>
          {item.kind === 'quiz' ? 'Start the quiz' : 'Open the assignment'}
        </Link>
      )}

      {(item.materials ?? []).length > 0 && (
        <section>
          <h2 style={{ fontSize: '1rem', marginBottom: '.5rem' }}>Files</h2>
          <ul className="material-list">
            {item.materials.map((material) => (
              <li key={material.id}>
                <a href={`/api/materials/${material.id}`} className="material-name">
                  {material.filename}
                </a>
                <span className="muted numeric">{(material.byteSize / 1024).toFixed(0)} KB</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Shown the moment a course is finished.
 *
 * The certificate is issued automatically on completion, so this is a
 * prompt to collect it rather than a request to award it. Making
 * someone hunt through a menu for the thing they just earned is the
 * most common way platforms waste the moment.
 */
function CertificateBanner({ activityId, activityTitle }) {
  const [state, setState] = useState({ status: 'idle' });
  const bannerRef = useRef(null);

  async function claim() {
    setState({ status: 'working' });
    try {
      const result = await api.claimCertificate(activityId);
      setState({ status: 'ready', certificate: result.certificate });
    } catch (error) {
      setState({ status: 'blocked', message: error.message });
    }
  }

  useEffect(() => { claim(); /* eslint-disable-next-line */ }, [activityId]);

  // This is the actual moment of issue, not just a later sighting of the
  // certificate, so it is the right place for the one celebratory effect
  // in the app. Fires once, right after the banner renders.
  useEffect(() => {
    if (state.status === 'ready' && bannerRef.current) {
      confettiBurst(bannerRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  if (state.status === 'blocked') {
    return (
      <div className="notice" role="status" style={{ marginTop: '2rem' }}>
        <strong>Course complete.</strong>
        <p style={{ margin: '.5rem 0 0' }}>{state.message}</p>
      </div>
    );
  }

  if (state.status !== 'ready') return null;

  return (
    <div className="certificate-banner" ref={bannerRef}>
      <h2>You finished {activityTitle}</h2>
      <p>
        Your certificate is ready. It carries verification code
        {' '}<strong>{state.certificate.verification_code}</strong>, which anyone
        can check without an account.
      </p>
      <div className="cluster">
        <a className="btn" href={`/api/certificates/${state.certificate.id}/download`}>
          Download certificate
        </a>
        <Link className="btn btn-plain" to="/certificates">All my certificates</Link>
      </div>
    </div>
  );
}

/**
 * Comments scoped to this one lesson item, Coursera's per-lecture
 * discussion rather than a whole-activity forum topic. Deliberately
 * flat (no titles, no nested replies): a question under a reading is
 * a comment, not a thread someone has to name first.
 */
function LessonComments({ itemId }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const { status, data, error, reload } = useResource(() => api.itemComments(itemId), [itemId]);
  const comments = data?.comments ?? [];

  async function post(event) {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.postItemComment(itemId, draft.trim());
      setDraft('');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lesson-comments" style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1rem', marginBottom: '.75rem' }}>
        Comments{comments.length > 0 && ` (${comments.length})`}
      </h2>

      <form className="cluster" style={{ alignItems: 'flex-start', marginBottom: '1rem' }} onSubmit={post}>
        <textarea
          className="textarea"
          style={{ flex: 1, minHeight: '2.5rem' }}
          placeholder="Ask a question about this section"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Write a comment"
        />
        <button type="submit" className="btn btn-quiet" disabled={busy || !draft.trim()}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </form>

      {status === 'loading' && <Loading rows={1} label="Loading comments" />}
      {status === 'error' && <Problem error={error} onRetry={reload} />}

      {status === 'loaded' && comments.length === 0 && (
        <p className="muted" style={{ fontSize: '.875rem' }}>
          No comments yet. Be the first to ask something here.
        </p>
      )}

      {comments.length > 0 && (
        <ul className="plain-list" style={{ display: 'grid', gap: '.75rem' }}>
          {comments.map((comment) => (
            <li key={comment.id} className="panel" style={{ padding: '.75rem 1rem' }}>
              <div className="between" style={{ marginBottom: '.25rem' }}>
                <strong style={{ fontSize: '.875rem' }}>{comment.author_name ?? 'Someone'}</strong>
                <span className="muted numeric" style={{ fontSize: '.75rem' }}>
                  {new Date(comment.created_at).toLocaleDateString()}
                </span>
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tick({ done, small }) {
  const size = small ? 16 : 18;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      className={done ? 'tick tick-done' : 'tick'}
    >
      <circle cx="12" cy="12" r="10" fill={done ? 'var(--primary)' : 'none'}
              stroke={done ? 'var(--primary)' : 'var(--line)'} strokeWidth="2"
              className={done ? 'tick-circle tick-circle-pop' : 'tick-circle'} />
      {/*
        This path only exists in the DOM at all once `done` is true, so
        it mounts fresh at the exact moment something is marked complete
        and never again while it stays complete. A CSS draw-in animation
        on mount (not on every render) is what that buys: it plays once,
        the moment it is earned, and a page refresh showing an already
        completed item sees it settled, not replaying a tick it did not
        just finish.
      */}
      {done && (
        <path d="m8 12 3 3 5-6" fill="none" stroke="#fff" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" className="tick-mark" />
      )}
    </svg>
  );
}

function labelFor(kind) {
  const labels = {
    reading: 'Reading', video: 'Video', audio: 'Audio', document: 'Document',
    link: 'Link', quiz: 'Quiz', assignment: 'Assignment', discussion: 'Discussion'
  };
  return labels[kind] ?? kind;
}
