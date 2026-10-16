import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty, Field, Progress } from '../components/ui.jsx';
import { ItemEditor, MaterialUploader } from '../components/ItemEditor.jsx';
import { AssessmentPanel } from '../components/AssessmentEditor.jsx';

/**
 * The activity editor.
 *
 * Three tabs because three different jobs happen here and only one is
 * ever in progress: writing the content, watching who is doing it, and
 * grading what they produced.
 */
export default function ManageActivity() {
  const { id } = useParams();
  const [tab, setTab] = useState('content');

  const { status, data, error, reload } = useResource(() => api.activity(id), [id]);
  const {
    data: assessmentData, reload: reloadAssessments
  } = useResource(() => api.activityAssessments(id), [id]);

  if (status === 'loading') return <Loading rows={3} label="Loading activity" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const { activity, modules } = data;
  const assessments = assessmentData?.assessments ?? [];

  async function refreshAll() {
    await Promise.all([reload(), reloadAssessments()]);
  }

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/manage">Manage</Link> / {activity.type}
      </p>

      <header className="page-head">
        <div className="between" style={{ alignItems: 'flex-start' }}>
          <h1>{activity.title}</h1>
          <span className={`tag${activity.status === 'published' ? ' tag-live' : ''}`}>
            {activity.status}
          </span>
        </div>
        <p>{activity.summary}</p>
      </header>

      <div className="segmented" role="tablist" aria-label="Activity sections">
        {[
          ['content', 'Content'],
          ['quizzes', 'Quizzes'],
          ['participants', 'Participants'],
          ['grading', 'Grading']
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

      {tab === 'content' && (
        <ContentTab
          activityId={id} activity={activity} modules={modules}
          assessments={assessments} onChange={refreshAll}
        />
      )}
      {tab === 'quizzes' && (
        <AssessmentPanel activityId={id} assessments={assessments} onChange={reloadAssessments} />
      )}
      {tab === 'participants' && <ParticipantsTab activityId={id} />}
      {tab === 'grading' && <GradingTab activityId={id} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ContentTab({ activityId, activity, modules, assessments, onChange }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', estimatedMinutes: 15 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [publishing, setPublishing] = useState(false);

  async function addModule(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createModule(activityId, {
        title: draft.title,
        body: draft.body || undefined,
        estimatedMinutes: Number(draft.estimatedMinutes)
      });
      setDraft({ title: '', body: '', estimatedMinutes: 15 });
      setAdding(false);
      await onChange();
    } catch (addError) {
      setError(addError.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeModule(moduleId) {
    setBusy(true);
    try {
      await api.deleteModule(activityId, moduleId);
      await onChange();
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setBusy(false);
    }
  }

  async function togglePublished() {
    setPublishing(true);
    setError(null);
    try {
      await api.updateActivity(activityId, {
        status: activity.status === 'published' ? 'draft' : 'published'
      });
      await onChange();
    } catch (publishError) {
      setError(publishError.message);
    } finally {
      setPublishing(false);
    }
  }

  const canPublish = modules.length > 0;

  return (
    <div className="stack">
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <div className="panel">
        <div className="between">
          <div>
            <strong>{activity.status === 'published' ? 'Published' : 'Draft'}</strong>
            <p className="muted" style={{ margin: '.25rem 0 0', fontSize: '.875rem' }}>
              {activity.status === 'published'
                ? 'Participants can find and enrol in this activity.'
                : canPublish
                  ? 'Only you can see this. Publish it when you are ready.'
                  : 'Add at least one section before publishing.'}
            </p>
          </div>
          <button
            type="button"
            className={activity.status === 'published' ? 'btn btn-plain' : 'btn'}
            onClick={togglePublished}
            disabled={publishing || (!canPublish && activity.status !== 'published')}
          >
            {publishing ? 'Working' : activity.status === 'published' ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </div>

      <div className="between">
        <h2 style={{ fontSize: '1.125rem' }}>Sections</h2>
        <button type="button" className="btn btn-quiet" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : 'Add section'}
        </button>
      </div>

      {adding && (
        <form className="panel" onSubmit={addModule}>
          <Field label="Section title" id="module-title">
            <input
              id="module-title" className="input" required minLength={3}
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </Field>
          <Field label="Content" id="module-body" hint="Text first, so it loads on a slow connection.">
            <textarea
              id="module-body" className="textarea"
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            />
          </Field>
          <Field label="Estimated minutes" id="module-minutes">
            <input
              id="module-minutes" className="input" type="number" min={1} max={600}
              value={draft.estimatedMinutes}
              onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })}
            />
          </Field>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Adding' : 'Add section'}
          </button>
        </form>
      )}

      {modules.length === 0 && !adding && (
        <Empty title="No sections yet">
          Sections are what participants work through. Add at least one
          before publishing.
        </Empty>
      )}

      {modules.length > 0 && (
        <div className="stack">
          {modules.map((module) => (
            <ModuleEditor
              key={module.id}
              activityId={activityId}
              module={module}
              assessments={assessments}
              onChange={onChange}
              onRemove={() => removeModule(module.id)}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ParticipantsTab({ activityId }) {
  const { status, data, error, reload } = useResource(
    () => api.activityParticipants(activityId),
    [activityId]
  );

  if (status === 'loading') return <Loading rows={3} label="Loading participants" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;

  const participants = data?.participants ?? [];

  if (!participants.length) {
    return <Empty title="Nobody has enrolled yet">
      Participants appear here once they enrol.
    </Empty>;
  }

  const stalled = participants.filter(
    (person) => person.percent === 0 && person.enrolment_status !== 'completed'
  );

  return (
    <div className="stack">
      {stalled.length > 0 && (
        <div className="notice" role="status">
          {stalled.length} participant{stalled.length === 1 ? ' has' : 's have'} enrolled
          but not started. They may need a nudge, or the first section may
          be too heavy for their connection.
        </div>
      )}

      <div className="rows">
        {participants.map((person) => (
          <div className="row" key={person.id}>
            <div className="between" style={{ alignItems: 'flex-start', marginBottom: '.5rem' }}>
              <div>
                <h3 className="row-title" style={{ fontSize: '1rem' }}>{person.full_name}</h3>
                <span className="muted">{person.country}</span>
              </div>
              <span className={`tag${person.enrolment_status === 'completed' ? ' tag-live' : ''}`}>
                {person.enrolment_status.replace('_', ' ')}
              </span>
            </div>
            <Progress
              done={person.modules_done}
              total={person.modules_total}
              label="Sections completed"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function GradingTab({ activityId }) {
  const [open, setOpen] = useState(null);
  const { status, data, error, reload } = useResource(
    () => api.activitySubmissions(activityId),
    [activityId]
  );

  if (status === 'loading') return <Loading rows={3} label="Loading submissions" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;

  const submissions = data?.data ?? [];

  if (!submissions.length) {
    return <Empty title="Nothing submitted yet">
      Participant submissions appear here for review.
    </Empty>;
  }

  return (
    <div className="rows">
      {submissions.map((submission) => (
        <div className="row" key={submission.id}>
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h3 className="row-title" style={{ fontSize: '1rem' }}>
                {submission.participant_name}
              </h3>
              <p className="row-summary" style={{ marginBottom: '.25rem' }}>
                {submission.assessment_title}
              </p>
              <div className="cluster">
                <span className="muted numeric">Attempt {submission.attempt}</span>
                {submission.score !== null && (
                  <span className="muted numeric">
                    {submission.score} / {submission.max_score}
                  </span>
                )}
                <span className={`tag${submission.status === 'submitted' ? ' tag-urgent' : ''}`}>
                  {submission.status.replace('_', ' ')}
                </span>
              </div>
            </div>
            <button
              type="button" className="btn btn-quiet"
              onClick={() => setOpen(open === submission.id ? null : submission.id)}
            >
              {open === submission.id ? 'Close' : submission.feedback_count > 0 ? 'Revise' : 'Give feedback'}
            </button>
          </div>

          {open === submission.id && (
            <FeedbackForm
              submission={submission}
              onDone={async () => { setOpen(null); await reload(); }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function FeedbackForm({ submission, onDone }) {
  const [body, setBody] = useState('');
  const [score, setScore] = useState(submission.score ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.giveFeedback(submission.id, {
        body,
        score: score === '' ? undefined : Number(score)
      });
      await onDone();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ marginTop: '.75rem' }} onSubmit={handleSubmit}>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <Field
        label="Feedback"
        id={`feedback-${submission.id}`}
        hint="Revising existing feedback resurfaces it as new for the participant."
      >
        <textarea
          id={`feedback-${submission.id}`} className="textarea" required minLength={5}
          value={body} onChange={(event) => setBody(event.target.value)}
        />
      </Field>

      <Field label={`Score out of ${submission.max_score}`} id={`score-${submission.id}`}>
        <input
          id={`score-${submission.id}`} className="input" type="number"
          min={0} max={submission.max_score} step="0.5"
          value={score} onChange={(event) => setScore(event.target.value)}
        />
      </Field>

      <button type="submit" className="btn" disabled={busy}>
        {busy ? 'Sending' : 'Send feedback'}
      </button>
    </form>
  );
}


/* ------------------------------------------------------------------ */

/**
 * One module and the items inside it.
 *
 * Collapsed by default. A course with eight modules of six items each
 * is forty-eight rows, and an editor that shows them all at once is
 * unusable on a laptop, let alone a phone.
 */
function ModuleEditor({ activityId, module, assessments, onChange, onRemove, busy }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const items = module.items ?? [];
  const weightKb = items
    .flatMap((item) => item.materials ?? [])
    .reduce((sum, material) => sum + material.byteSize, 0) / 1024;

  async function removeItem(itemId) {
    await api.deleteItem(activityId, itemId);
    await onChange();
  }

  return (
    <section className="panel">
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <button
          type="button"
          className="module-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="muted numeric">{module.position}.</span>
          <span className="module-title">{module.title}</span>
          <span className="muted numeric">
            {items.length} item{items.length === 1 ? '' : 's'}
            {weightKb > 0 && ` · ${weightKb.toFixed(0)} KB`}
          </span>
        </button>
        <button type="button" className="btn btn-plain" onClick={onRemove} disabled={busy}>
          Remove
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '1rem' }}>
          {items.length === 0 && (
            <p className="muted">
              Nothing in this section yet. Add a reading, a document or a quiz.
            </p>
          )}

          {items.map((item) => (
            <div className="item-row" key={item.id}>
              <div className="between" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="cluster" style={{ marginBottom: '.25rem' }}>
                    <span className="tag">{item.kind}</span>
                    {!item.is_required && <span className="tag">optional</span>}
                    <span className="muted numeric">{item.estimated_minutes} min</span>
                  </div>
                  <strong>{item.title}</strong>
                  {item.kind === 'video' && !item.transcript && (
                    <p className="field-error" style={{ marginTop: '.25rem' }}>
                      No transcript. Participants on slow connections cannot use this.
                    </p>
                  )}
                </div>
                <button type="button" className="btn btn-quiet" onClick={() => removeItem(item.id)}>
                  Remove
                </button>
              </div>

              <MaterialUploader
                activityId={activityId}
                itemId={item.id}
                materials={item.materials ?? []}
                onChange={onChange}
              />
            </div>
          ))}

          {adding ? (
            <ItemEditor
              activityId={activityId}
              moduleId={module.id}
              assessments={assessments}
              onDone={async () => { setAdding(false); await onChange(); }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="btn btn-quiet" onClick={() => setAdding(true)}>
              Add item
            </button>
          )}
        </div>
      )}
    </section>
  );
}
