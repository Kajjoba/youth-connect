import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Field, Busy } from '../components/ui.jsx';

/**
 * =====================================================================
 * CREATE A COURSE
 *
 * DEFECT FOUND 2026-09-27 by clicking the button.
 *
 * /manage had two links to /manage/new, and that route rendered the
 * activity EDITOR, which loads a course by the id in the URL. The id was
 * the literal string "new", so it fetched /api/activities/new, got a 404,
 * and showed the facilitator "That page is not available to you."
 *
 * There was therefore no way to create a course in the interface at all.
 * The endpoint existed and was tested; the route into it was a dead end,
 * which no API test could have caught.
 * =====================================================================
 * WHAT THIS ASKS FOR, AND WHAT IT DOES NOT
 *
 * Only what a course cannot exist without: a title, a one-line summary,
 * a type, and a rough length. Everything else, the outcomes, the
 * prerequisites, the weeks, the skills, the modules and their content,
 * is edited afterwards in the editor, where the facilitator can see the
 * course taking shape.
 *
 * A create form that asks for twenty fields before it will accept
 * anything is how courses end up never being created. This asks for four
 * and gets out of the way.
 *
 * It is created as a DRAFT, always, with no option to publish here.
 * Publishing a course with no modules in it would put an empty shell in
 * front of participants, and migration 008 means an empty course cannot
 * be completed anyway. Publishing belongs in the editor, once there is
 * something to publish.
 * =====================================================================
 */

const TYPES = [
  ['course', 'Course', 'Structured, module by module, worked through in order.'],
  ['workshop', 'Workshop', 'Shorter and hands-on, usually run once.'],
  ['challenge', 'Challenge', 'A problem to solve, with a deliverable at the end.'],
  ['discussion', 'Discussion', 'Led by conversation rather than content.']
];

export default function NewActivity() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    title: '',
    summary: '',
    type: 'course',
    estimatedMinutes: 120
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // The server validates these too, and it is the authority. Checking
  // here as well means the facilitator finds out before spending a
  // request, which on a metered connection is the point.
  const problems = {
    title: form.title.length > 0 && form.title.trim().length < 4
      ? 'At least 4 characters.'
      : null,
    summary: form.summary.length > 0 && form.summary.trim().length < 10
      ? 'At least 10 characters. One sentence is plenty.'
      : null
  };
  const ready =
    form.title.trim().length >= 4 &&
    form.summary.trim().length >= 10 &&
    !problems.title && !problems.summary;

  function set(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    if (!ready || saving) return;

    setSaving(true);
    setError(null);
    try {
      const result = await api.createActivity({
        title: form.title.trim(),
        summary: form.summary.trim(),
        type: form.type,
        estimatedMinutes: Number(form.estimatedMinutes) || 60,
        status: 'draft'
      });
      // Straight into the editor for the course that now exists, rather
      // than back to a list where the facilitator has to find it.
      navigate(`/manage/${result.activity.id}`, { replace: true });
    } catch (caught) {
      setError(caught);
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        <Link to="/manage">Manage</Link> / new
      </p>

      <header className="page-head">
        <h1>Create an activity</h1>
        <p>
          Four things now, the rest in the editor. It is saved as a draft,
          so nobody sees it until you publish it.
        </p>
      </header>

      {error && (
        <div className="notice notice-bad" role="alert">
          <p style={{ margin: 0 }}>
            {error.status === 422
              ? 'Something in the form was refused. Check the title and summary.'
              : error.message || 'It could not be created. Try again.'}
          </p>
          {error.requestId && (
            <p className="muted numeric" style={{ margin: '.25rem 0 0', fontSize: '.75rem' }}>
              Reference {error.requestId.slice(0, 8)}
            </p>
          )}
        </div>
      )}

      <form className="card stack" onSubmit={submit} noValidate>
        <Field
          id="new-title"
          label="Title"
          hint="What a participant will see first."
          error={problems.title}
        >
          <input
            id="new-title"
            className="input"
            value={form.title}
            maxLength={160}
            autoFocus
            onChange={(event) => set('title', event.target.value)}
            placeholder="Digital Skills for Remote Work"
          />
        </Field>

        <Field
          id="new-summary"
          label="Summary"
          hint="One sentence on who it is for and what they will be able to do."
          error={problems.summary}
        >
          <textarea
            id="new-summary"
            className="input"
            rows={3}
            maxLength={400}
            value={form.summary}
            onChange={(event) => set('summary', event.target.value)}
            placeholder="Positioning your skills for remote and regional opportunities across East Africa."
          />
          <span className="muted numeric" style={{ fontSize: '.75rem' }}>
            {form.summary.length} / 400
          </span>
        </Field>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label">Type</legend>
          <div className="stack" style={{ gap: '.4rem' }}>
            {TYPES.map(([value, label, note]) => (
              <label
                key={value}
                className={`row row-pick${form.type === value ? ' row-on' : ''}`}
              >
                <input
                  type="radio"
                  name="type"
                  value={value}
                  checked={form.type === value}
                  onChange={() => set('type', value)}
                />
                <span>
                  <strong>{label}</strong>
                  <span className="muted" style={{ display: 'block', fontSize: '.8rem' }}>
                    {note}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          id="new-minutes"
          label="Rough length in minutes"
          hint="An estimate is fine. Participants on a data bundle use it to decide."
        >
          <input
            id="new-minutes"
            className="input numeric"
            type="number"
            min={5}
            max={10000}
            step={15}
            value={form.estimatedMinutes}
            onChange={(event) => set('estimatedMinutes', event.target.value)}
          />
        </Field>

        <div className="between">
          <Link className="btn btn-quiet" to="/manage">Cancel</Link>
          <button className="btn" type="submit" disabled={!ready || saving}>
            <Busy busy={saving}>{saving ? 'Creating' : 'Create draft'}</Busy>
          </button>
        </div>
      </form>
    </div>
  );
}
