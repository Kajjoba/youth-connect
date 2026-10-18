import { useState } from 'react';
import { api } from '../lib/api.js';
import { Field } from './ui.jsx';

/**
 * Quiz authoring.
 *
 * The server stores each option as { key, text } and the correct
 * answer as the matching key. The editor hides that shape entirely: a
 * facilitator sees lettered options (A, B, C...) and picks the correct
 * one with a radio button. Keys are assigned from the option's
 * position, not typed by hand, so there is no way to end up with two
 * options sharing a key or a correct answer that points at a key that
 * does not exist, the one thing assessmentSchema on the server refuses
 * outright.
 */

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

function blankQuestion() {
  return {
    prompt: '',
    options: [{ key: 'a', text: '' }, { key: 'b', text: '' }],
    correctKey: 'a',
    points: 1
  };
}

function blankAssessment() {
  return {
    title: '',
    instructions: '',
    type: 'quiz',
    maxScore: 100,
    passScore: 50,
    maxAttempts: 1,
    questions: [blankQuestion()]
  };
}

/** Converts a saved assessment (server shape) into editable form state. */
function toForm(assessment) {
  return {
    title: assessment.title,
    instructions: assessment.instructions ?? '',
    type: assessment.type,
    maxScore: Number(assessment.max_score),
    passScore: Number(assessment.pass_score),
    maxAttempts: Number(assessment.max_attempts),
    questions: assessment.questions.length
      ? assessment.questions.map((q) => ({
          prompt: q.prompt,
          options: q.options,
          correctKey: q.correct_key ?? q.options[0]?.key ?? 'a',
          points: Number(q.points)
        }))
      : [blankQuestion()]
  };
}

export function AssessmentPanel({ activityId, assessments, onChange }) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);

  return (
    <div className="stack">
      <div className="between">
        <h2 style={{ fontSize: '1.125rem' }}>Quizzes and assignments</h2>
        <button
          type="button" className="btn btn-quiet"
          onClick={() => { setCreating(!creating); setEditingId(null); }}
        >
          {creating ? 'Cancel' : 'Add quiz'}
        </button>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: '.875rem' }}>
        Create a quiz here first, then point a "Quiz" item at it from any
        section below. Revising one here updates it for everyone who
        takes it next; attempts already scored keep their original score.
      </p>

      {creating && (
        <AssessmentForm
          activityId={activityId}
          onDone={async () => { setCreating(false); await onChange(); }}
          onCancel={() => setCreating(false)}
        />
      )}

      {assessments.length === 0 && !creating && (
        <p className="muted">No quizzes yet.</p>
      )}

      {assessments.length > 0 && (
        <div className="rows">
          {assessments.map((assessment) => (
            <div className="row" key={assessment.id}>
              <div className="between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <h3 className="row-title" style={{ fontSize: '1rem' }}>{assessment.title}</h3>
                  <span className="muted">
                    {assessment.questions.length} question{assessment.questions.length === 1 ? '' : 's'}
                    {' · '}pass {assessment.pass_score}/{assessment.max_score}
                    {' · '}{assessment.max_attempts} attempt{assessment.max_attempts === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  type="button" className="btn btn-quiet"
                  onClick={() => { setEditingId(editingId === assessment.id ? null : assessment.id); setCreating(false); }}
                >
                  {editingId === assessment.id ? 'Close' : 'Edit'}
                </button>
              </div>

              {editingId === assessment.id && (
                <AssessmentForm
                  activityId={activityId}
                  assessment={assessment}
                  onDone={async () => { setEditingId(null); await onChange(); }}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssessmentForm({ activityId, assessment, onDone, onCancel }) {
  const [form, setForm] = useState(() => assessment ? toForm(assessment) : blankAssessment());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function updateField(key, value) {
    setForm({ ...form, [key]: value });
  }

  function updateQuestion(index, patch) {
    const questions = form.questions.map((q, i) => (i === index ? { ...q, ...patch } : q));
    setForm({ ...form, questions });
  }

  function addQuestion() {
    setForm({ ...form, questions: [...form.questions, blankQuestion()] });
  }

  function removeQuestion(index) {
    setForm({ ...form, questions: form.questions.filter((_, i) => i !== index) });
  }

  function addOption(qIndex) {
    const question = form.questions[qIndex];
    if (question.options.length >= 6) return;
    const nextKey = LETTERS[question.options.length];
    updateQuestion(qIndex, { options: [...question.options, { key: nextKey, text: '' }] });
  }

  function removeOption(qIndex, oIndex) {
    const question = form.questions[qIndex];
    if (question.options.length <= 2) return;
    const options = question.options
      .filter((_, i) => i !== oIndex)
      .map((option, i) => ({ ...option, key: LETTERS[i] }));
    const correctKey = options.some((o) => o.key === question.correctKey)
      ? question.correctKey
      : options[0].key;
    updateQuestion(qIndex, { options, correctKey });
  }

  function updateOptionText(qIndex, oIndex, text) {
    const question = form.questions[qIndex];
    const options = question.options.map((o, i) => (i === oIndex ? { ...o, text } : o));
    updateQuestion(qIndex, { options });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: form.title,
        instructions: form.instructions || undefined,
        type: form.type,
        maxScore: Number(form.maxScore),
        passScore: Number(form.passScore),
        maxAttempts: Number(form.maxAttempts),
        questions: form.questions.map((q) => ({
          prompt: q.prompt,
          options: q.options,
          correctKey: q.correctKey,
          points: Number(q.points)
        }))
      };
      if (assessment) {
        await api.updateAssessment(activityId, assessment.id, body);
      } else {
        await api.createAssessment(activityId, body);
      }
      await onDone();
    } catch (submitError) {
      setError(submitError.details
        ? Object.values(submitError.details).join(' ')
        : submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ marginTop: '.75rem' }} onSubmit={handleSubmit}>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <Field label="Quiz title" id="asm-title">
        <input
          id="asm-title" className="input" required minLength={3}
          value={form.title} onChange={(e) => updateField('title', e.target.value)}
        />
      </Field>

      <Field label="Instructions" id="asm-instructions" hint="Shown above the first question.">
        <textarea
          id="asm-instructions" className="textarea"
          value={form.instructions} onChange={(e) => updateField('instructions', e.target.value)}
        />
      </Field>

      <div className="cluster">
        <Field label="Pass score" id="asm-pass">
          <input
            id="asm-pass" className="input" type="number" min={0} max={form.maxScore} step="1"
            value={form.passScore} onChange={(e) => updateField('passScore', e.target.value)}
          />
        </Field>
        <Field label="Max score" id="asm-max">
          <input
            id="asm-max" className="input" type="number" min={1} max={1000} step="1"
            value={form.maxScore} onChange={(e) => updateField('maxScore', e.target.value)}
          />
        </Field>
        <Field label="Attempts allowed" id="asm-attempts">
          <input
            id="asm-attempts" className="input" type="number" min={1} max={10} step="1"
            value={form.maxAttempts} onChange={(e) => updateField('maxAttempts', e.target.value)}
          />
        </Field>
      </div>

      <h3 style={{ fontSize: '1rem', margin: '1rem 0 0' }}>Questions</h3>

      {form.questions.map((question, qIndex) => (
        <div className="panel" key={qIndex} style={{ background: 'var(--paper)' }}>
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <Field label={`Question ${qIndex + 1}`} id={`q-${qIndex}-prompt`}>
              <textarea
                id={`q-${qIndex}-prompt`} className="textarea" required minLength={3}
                value={question.prompt}
                onChange={(e) => updateQuestion(qIndex, { prompt: e.target.value })}
              />
            </Field>
            {form.questions.length > 1 && (
              <button
                type="button" className="btn btn-quiet" style={{ marginTop: '1.75rem' }}
                onClick={() => removeQuestion(qIndex)}
              >
                Remove
              </button>
            )}
          </div>

          <p className="field-label" style={{ marginTop: '.5rem' }}>
            Options <span className="muted">(pick the correct one)</span>
          </p>
          {question.options.map((option, oIndex) => (
            <div className="cluster" key={oIndex} style={{ alignItems: 'center', marginBottom: '.5rem' }}>
              <input
                type="radio"
                name={`q-${qIndex}-correct`}
                aria-label={`Option ${option.key.toUpperCase()} is correct`}
                checked={question.correctKey === option.key}
                onChange={() => updateQuestion(qIndex, { correctKey: option.key })}
              />
              <span className="muted numeric" style={{ width: '1.25rem' }}>
                {option.key.toUpperCase()}
              </span>
              <input
                className="input" style={{ flex: 1 }} required
                placeholder={`Option ${option.key.toUpperCase()}`}
                value={option.text}
                onChange={(e) => updateOptionText(qIndex, oIndex, e.target.value)}
              />
              {question.options.length > 2 && (
                <button
                  type="button" className="btn btn-plain"
                  onClick={() => removeOption(qIndex, oIndex)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {question.options.length < 6 && (
            <button type="button" className="btn btn-plain" onClick={() => addOption(qIndex)}>
              Add option
            </button>
          )}

          <Field label="Points for this question" id={`q-${qIndex}-points`}>
            <input
              id={`q-${qIndex}-points`} className="input" type="number" min={0.5} max={100} step="0.5"
              value={question.points}
              onChange={(e) => updateQuestion(qIndex, { points: e.target.value })}
            />
          </Field>
        </div>
      ))}

      <div className="cluster" style={{ marginTop: '.5rem' }}>
        <button type="button" className="btn btn-plain" onClick={addQuestion}>
          Add question
        </button>
      </div>

      <div className="cluster" style={{ marginTop: '1rem' }}>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Saving' : assessment ? 'Save changes' : 'Create quiz'}
        </button>
        <button type="button" className="btn btn-plain" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
