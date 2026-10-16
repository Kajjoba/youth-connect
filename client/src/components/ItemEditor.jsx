import { useState, useRef } from 'react';
import { api } from '../lib/api.js';
import { Field } from './ui.jsx';

/**
 * Authoring a lesson item.
 *
 * The kind is chosen first and the form changes to suit it, rather than
 * showing every field for every kind. A facilitator writing a reading
 * should not be looking at a duration field.
 *
 * Note the ordering of the kind list: reading is first and is the
 * default. Video sits below it and carries a warning. That is ADR-016
 * expressed in the interface, not just in a comment: the platform makes
 * the cheap option the easy one.
 */

const KINDS = [
  { value: 'reading', label: 'Reading', hint: 'Text held in the platform. Cheapest to open.' },
  { value: 'document', label: 'Document', hint: 'A file to download, up to 5 MB.' },
  { value: 'quiz', label: 'Quiz', hint: 'Points at an assessment.' },
  { value: 'assignment', label: 'Assignment', hint: 'Work a participant submits.' },
  { value: 'discussion', label: 'Discussion', hint: 'A prompt for the activity forum.' },
  { value: 'audio', label: 'Audio link', hint: 'External. Far cheaper than video.' },
  { value: 'link', label: 'External link', hint: 'Somewhere else on the web.' },
  { value: 'video', label: 'Video link', hint: 'External only. Always add a transcript.' }
];

const BLANK = {
  kind: 'reading', title: '', body: '', externalUrl: '',
  transcript: '', durationSeconds: '', assessmentId: '',
  estimatedMinutes: 10, isRequired: true
};

export function ItemEditor({ activityId, moduleId, assessments = [], onDone, onCancel }) {
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const update = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm({ ...form, [key]: value });
  };

  const kind = KINDS.find((entry) => entry.value === form.kind);
  const needsUrl = ['video', 'audio', 'link'].includes(form.kind);
  const needsAssessment = ['quiz', 'assignment'].includes(form.kind);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createItem(activityId, moduleId, {
        kind: form.kind,
        title: form.title,
        body: form.body || undefined,
        externalUrl: form.externalUrl || undefined,
        transcript: form.transcript || undefined,
        durationSeconds: form.durationSeconds ? Number(form.durationSeconds) : undefined,
        assessmentId: form.assessmentId || undefined,
        estimatedMinutes: Number(form.estimatedMinutes),
        isRequired: form.isRequired
      });
      setForm(BLANK);
      await onDone(created.item);
    } catch (submitError) {
      setError(submitError.details
        ? Object.values(submitError.details).join(' ')
        : submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <Field label="Type" id="item-kind" hint={kind?.hint}>
        <select id="item-kind" className="select" value={form.kind} onChange={update('kind')}>
          {KINDS.map((entry) => (
            <option key={entry.value} value={entry.value}>{entry.label}</option>
          ))}
        </select>
      </Field>

      {form.kind === 'video' && (
        <div className="notice" role="status">
          <strong>Video is linked, never uploaded.</strong>
          <p style={{ margin: '.5rem 0 0', fontSize: '.875rem' }}>
            Ten minutes of video is roughly 50 MB, which can cost a
            participant more than a week of mobile data. A transcript is
            about 8 KB and is what most people on a slow connection will
            actually use.
          </p>
        </div>
      )}

      <Field label="Title" id="item-title">
        <input id="item-title" className="input" required minLength={3}
               value={form.title} onChange={update('title')} />
      </Field>

      {form.kind === 'reading' && (
        <Field label="Content" id="item-body" hint="Plain text. This is what participants read.">
          <textarea id="item-body" className="textarea" style={{ minHeight: '12rem' }}
                    required value={form.body} onChange={update('body')} />
        </Field>
      )}

      {needsUrl && (
        <Field label="Link" id="item-url" hint="The resource lives on the other side of this link.">
          <input id="item-url" className="input" type="url" required
                 placeholder="https://"
                 value={form.externalUrl} onChange={update('externalUrl')} />
        </Field>
      )}

      {(form.kind === 'video' || form.kind === 'audio') && (
        <>
          <Field
            label="Transcript"
            id="item-transcript"
            hint="Strongly recommended. Reading costs a fraction of watching, and it is the accessible option too."
          >
            <textarea id="item-transcript" className="textarea"
                      value={form.transcript} onChange={update('transcript')} />
          </Field>
          <Field label="Length in seconds" id="item-duration">
            <input id="item-duration" className="input" type="number" min={1}
                   value={form.durationSeconds} onChange={update('durationSeconds')} />
          </Field>
        </>
      )}

      {needsAssessment && (
        assessments.length === 0 ? (
          <div className="notice" role="status">
            No quizzes exist yet. Go to the <strong>Quizzes</strong> tab and
            create one first, then come back and add this item.
          </div>
        ) : (
          <Field label="Assessment" id="item-assessment">
            <select id="item-assessment" className="select" required
                    value={form.assessmentId} onChange={update('assessmentId')}>
              <option value="">Choose an assessment</option>
              {assessments.map((assessment) => (
                <option key={assessment.id} value={assessment.id}>{assessment.title}</option>
              ))}
            </select>
          </Field>
        )
      )}

      <Field label="Estimated minutes" id="item-minutes">
        <input id="item-minutes" className="input" type="number" min={1} max={600}
               value={form.estimatedMinutes} onChange={update('estimatedMinutes')} />
      </Field>

      <label className="choice">
        <input type="checkbox" checked={form.isRequired} onChange={update('isRequired')} />
        <span>
          <strong style={{ display: 'block' }}>Required</strong>
          <span className="muted">
            Optional items do not block someone from completing the section.
          </span>
        </span>
      </label>

      <div className="cluster" style={{ marginTop: '1rem' }}>
        <button type="submit" className="btn" disabled={busy || (needsAssessment && assessments.length === 0)}>
          {busy ? 'Adding' : 'Add item'}
        </button>
        <button type="button" className="btn btn-plain" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Material upload.
 *
 * No client-side compression here, unlike avatars: a worksheet cannot
 * be downscaled without destroying it. The honest approach is a firm
 * limit and telling the facilitator what it will cost their
 * participants, in terms they will recognise.
 */
export function MaterialUploader({ activityId, itemId, materials = [], onChange }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const LIMIT = 5 * 1024 * 1024;

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    if (file.size > LIMIT) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB. `
        + 'Anything larger should be an external link, so participants can decide '
        + 'whether to download it.'
      );
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setBusy(true);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
      });

      await api.uploadMaterial(activityId, itemId, {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: base64
      });
      await onChange();
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function remove(materialId) {
    setBusy(true);
    try {
      await api.deleteMaterial(activityId, materialId);
      await onChange();
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setBusy(false);
    }
  }

  const totalKb = materials.reduce((sum, m) => sum + m.byteSize, 0) / 1024;

  return (
    <div className="materials">
      {error && <p className="field-error" role="alert">{error}</p>}

      {materials.length > 0 && (
        <ul className="material-list">
          {materials.map((material) => (
            <li key={material.id}>
              <span className="material-name">{material.filename}</span>
              <span className="muted numeric">{(material.byteSize / 1024).toFixed(0)} KB</span>
              <button type="button" className="btn btn-quiet" onClick={() => remove(material.id)} disabled={busy}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef} type="file" className="visually-hidden"
        id={`material-${itemId}`}
        accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.md,.docx,.pptx,.xlsx"
        onChange={handleFile}
      />
      <label htmlFor={`material-${itemId}`} className="btn btn-plain">
        {busy ? 'Uploading' : 'Attach a file'}
      </label>

      <p className="muted" style={{ fontSize: '.75rem', margin: '.5rem 0 0' }}>
        {materials.length > 0
          ? `${totalKb.toFixed(0)} KB attached. Participants pay for this on mobile data.`
          : 'Up to 5 MB. PDF, images, text, Word, PowerPoint or Excel.'}
      </p>
    </div>
  );
}
