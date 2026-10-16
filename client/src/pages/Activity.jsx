import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource, useConnection } from '../lib/hooks.js';
import { Loading, Problem, Empty, Weight, Progress } from '../components/ui.jsx';

export default function Activity() {
  const { id } = useParams();
  const connection = useConnection();
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const { status, data, error, reload } = useResource(() => api.activity(id), [id]);

  if (status === 'loading') return <Loading rows={3} label="Loading activity" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { activity, modules, enrolment, permissions } = data;
  const done = modules.filter((module) => module.progress_status === 'completed').length;

  async function handleEnrol() {
    setBusy('enrol');
    setMessage(null);
    try {
      await api.enrol(id);
      await reload();
      setMessage({ tone: 'good', text: 'You are enrolled. Start with the first section below.' });
    } catch (enrolError) {
      setMessage({ tone: 'bad', text: enrolError.message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Optimistic progress.
   *
   * The checkbox updates immediately and the write goes out behind it.
   * If the network is down the API client queues it and this still looks
   * instant, which is the point: a participant on a train through a dead
   * zone should not be blocked from marking a section read.
   */
  async function toggleModule(module) {
    const next = module.progress_status === 'completed' ? 'in_progress' : 'completed';
    setBusy(module.id);
    try {
      const result = await api.setModuleProgress(id, module.id, { status: next });
      if (result?.queued) {
        setMessage({ tone: 'good', text: 'Saved on your device. It will sync when you reconnect.' });
      } else {
        await reload();
      }
    } catch (progressError) {
      setMessage({ tone: 'bad', text: progressError.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/">Discover</Link> / {activity.type}
      </p>

      <div>
        <h1>{activity.title}</h1>
        <p className="muted">{activity.summary}</p>
        <div className="cluster">
          <span className="muted numeric">{activity.estimated_minutes} min</span>
          <Weight kb={activity.payload_kb} />
          <span className="muted numeric">{activity.enrolled_count} enrolled</span>
          {activity.facilitator_name && (
            <span className="muted">Led by {activity.facilitator_name}</span>
          )}
        </div>
      </div>

      {message && (
        <div className={`notice notice-${message.tone}`} role="status">{message.text}</div>
      )}

      {connection.slow && activity.payload_kb > 300 && (
        <div className="notice" role="status">
          This activity uses about {activity.payload_kb} KB. On your current
          connection it may take a while and use noticeable data.
        </div>
      )}

      {activity.description && (
        <div className="panel">
          <p style={{ margin: 0 }}>{activity.description}</p>
        </div>
      )}

      {permissions.canEnrol && (
        <button type="button" className="btn btn-block" onClick={handleEnrol} disabled={busy === 'enrol'}>
          {busy === 'enrol' ? 'Enrolling' : 'Enrol in this activity'}
        </button>
      )}

      {enrolment && modules.length > 0 && (
        <>
          <Link className="btn btn-block btn-lg" to={`/learn/${id}`}>
            {done > 0 ? 'Continue learning' : 'Start learning'}
          </Link>

          <div className="panel">
            <Progress done={done} total={modules.length} label="Your progress" />
          </div>

          <section>
            <h2 style={{ marginBottom: '.75rem' }}>Course content</h2>
            <div className="stack">
              {modules.map((module) => (
                <ModuleView
                  key={module.id}
                  activityId={id}
                  module={module}
                  onChange={reload}
                  onLegacyToggle={toggleModule}
                  busy={busy}
                  setMessage={setMessage}
                />
              ))}
            </div>
          </section>

          <Threads activityId={id} />
        </>
      )}

      {!enrolment && !permissions.canEnrol && (
        <Empty title="Not open for enrolment">
          This activity is not currently accepting participants.
        </Empty>
      )}
    </div>
  );
}

function Threads({ activityId }) {
  const [draft, setDraft] = useState({ title: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const { status, data, error, reload } = useResource(
    () => api.threads(activityId),
    [activityId]
  );

  async function handlePost(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createThread(activityId, draft);
      setDraft({ title: '', body: '' });
      setOpen(false);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const threads = data?.data ?? [];

  return (
    <section>
      <div className="between" style={{ marginBottom: '.75rem' }}>
        <h2>Discussion</h2>
        <button type="button" className="btn btn-quiet" onClick={() => setOpen(!open)}>
          {open ? 'Cancel' : 'Start a discussion'}
        </button>
      </div>

      {open && (
        <form className="panel" onSubmit={handlePost}>
          <label className="field" htmlFor="thread-title">
            <span className="field-label">Topic</span>
            <input
              id="thread-title" className="input" required minLength={4}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </label>
          <label className="field" htmlFor="thread-body">
            <span className="field-label">What do you want to discuss?</span>
            <textarea
              id="thread-body" className="textarea" required
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </label>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Posting' : 'Post topic'}
          </button>
        </form>
      )}

      {status === 'loading' && <Loading rows={2} label="Loading discussion" />}
      {status === 'error' && <Problem error={error} onRetry={reload} />}

      {status === 'loaded' && threads.length === 0 && (
        <Empty title="No discussions yet">
          Be the first to ask a question or share what you are working on.
        </Empty>
      )}

      {threads.length > 0 && (
        <div className="rows">
          {threads.map((thread) => (
            <div className="row" key={thread.id}>
              <h3 className="row-title" style={{ fontSize: '1rem' }}>{thread.title}</h3>
              <div className="row-foot">
                <span className="muted">{thread.author_name}</span>
                <span className="muted numeric">
                  {thread.reply_count} {thread.reply_count === 1 ? 'reply' : 'replies'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


/* ------------------------------------------------------------------ */

/**
 * A module as a participant sees it.
 *
 * Every item states what it costs before it is opened. That is the
 * whole point of the content model: someone on prepaid mobile data
 * should never be surprised by a download.
 */
function ModuleView({ activityId, module, onChange, onLegacyToggle, busy, setMessage }) {
  const [open, setOpen] = useState(false);
  const items = module.items ?? [];
  const done = items.filter((item) => item.progress_status === 'completed').length;

  async function complete(item) {
    const next = item.progress_status === 'completed' ? 'in_progress' : 'completed';
    try {
      const result = await api.setItemProgress(activityId, item.id, { status: next });
      if (result?.queued) {
        setMessage({ tone: 'good', text: 'Saved on your device. It will sync when you reconnect.' });
      } else {
        await onChange();
      }
    } catch (error) {
      setMessage({ tone: 'bad', text: error.message });
    }
  }

  // A module created before items existed still works exactly as it did.
  if (items.length === 0) {
    const complete = module.progress_status === 'completed';
    return (
      <div className="panel">
        <div className="between" style={{ alignItems: 'flex-start' }}>
          <div>
            <strong>{module.title}</strong>
            <div className="muted numeric">{module.estimated_minutes} min</div>
          </div>
          <button
            type="button"
            className={complete ? 'btn btn-plain' : 'btn btn-quiet'}
            onClick={() => onLegacyToggle(module)}
            disabled={busy === module.id}
            aria-pressed={complete}
          >
            {complete ? 'Done' : 'Mark done'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="panel">
      <button
        type="button" className="module-toggle" onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="muted numeric">{module.position}.</span>
        <span className="module-title">{module.title}</span>
        <span className="muted numeric">{done} of {items.length}</span>
      </button>

      {open && (
        <div style={{ marginTop: '1rem' }}>
          {items.map((item) => (
            <ItemView
              key={item.id}
              item={item}
              onComplete={() => complete(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ItemView({ item, onComplete }) {
  const [expanded, setExpanded] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const complete = item.progress_status === 'completed';

  const materialKb = (item.materials ?? [])
    .reduce((sum, material) => sum + material.byteSize, 0) / 1024;

  return (
    <article className="item-row">
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="cluster" style={{ marginBottom: '.25rem' }}>
            <span className="tag">{item.kind}</span>
            {!item.is_required && <span className="tag">optional</span>}
            <span className="muted numeric">{item.estimated_minutes} min</span>
            {materialKb > 0 && (
              <span className="muted numeric">{materialKb.toFixed(0)} KB to download</span>
            )}
          </div>
          <strong>{item.title}</strong>
        </div>
        <button
          type="button"
          className={complete ? 'btn btn-plain' : 'btn btn-quiet'}
          onClick={onComplete}
          aria-pressed={complete}
        >
          {complete ? 'Done' : 'Mark done'}
        </button>
      </div>

      {item.kind === 'reading' && item.body && (
        <>
          <button type="button" className="btn btn-quiet" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Collapse' : 'Read'}
          </button>
          {expanded && <p style={{ marginTop: '.75rem', whiteSpace: 'pre-wrap' }}>{item.body}</p>}
        </>
      )}

      {['video', 'audio', 'link'].includes(item.kind) && item.external_url && (
        <div className="cluster" style={{ marginTop: '.5rem' }}>
          <a className="btn btn-plain" href={item.external_url} target="_blank" rel="noreferrer">
            Open {item.kind === 'link' ? 'link' : item.kind}
          </a>
          {/*
            The transcript is offered alongside the video, not hidden
            behind it. Reading costs roughly 8 KB against about 50 MB
            for ten minutes of video, and it is the accessible option
            as well as the affordable one.
          */}
          {item.transcript && (
            <button type="button" className="btn btn-quiet" onClick={() => setShowTranscript(!showTranscript)}>
              {showTranscript ? 'Hide transcript' : 'Read transcript instead'}
            </button>
          )}
        </div>
      )}

      {showTranscript && item.transcript && (
        <p style={{ marginTop: '.75rem', whiteSpace: 'pre-wrap' }}>{item.transcript}</p>
      )}

      {(item.materials ?? []).length > 0 && (
        <ul className="material-list" style={{ marginTop: '.5rem' }}>
          {item.materials.map((material) => (
            <li key={material.id}>
              <a href={`/api/materials/${material.id}`} className="material-name">
                {material.filename}
              </a>
              <span className="muted numeric">{(material.byteSize / 1024).toFixed(0)} KB</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
