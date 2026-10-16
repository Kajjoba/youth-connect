import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem } from '../components/ui.jsx';
import { confettiBurst } from '../lib/motion.js';

export default function Assessment() {
  const { id } = useParams();
  const [answers, setAnswers] = useState({});
  const [checks, setChecks] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const { status, data, error: loadError, reload } = useResource(() => api.assessment(id), [id]);

  if (status === 'loading') return <Loading rows={3} label="Loading assessment" />;
  if (status === 'error' && !data) return <Problem error={loadError} onRetry={reload} />;
  if (!data) return null;

  const { assessment, questions, attempts, attemptsRemaining } = data;
  const answered = Object.keys(answers).length;

  /**
   * Instant per-question checking, Coursera's "Check answer" button.
   *
   * See ADR-026 on the server (POST .../questions/:id/check): this is a
   * deliberate, requested trade-off against the assessment's own answer
   * key, kept honest rather than hidden. It never touches a submission:
   * the real grade below still comes only from the server's marking in
   * POST /submissions, counted against the same attempt limit whether or
   * not a participant used this button.
   */
  async function checkQuestion(questionId) {
    const selected = answers[questionId];
    if (!selected) return;
    setChecks({ ...checks, [questionId]: { checking: true } });
    try {
      const response = await api.checkAnswer(id, questionId, selected);
      setChecks((prev) => ({ ...prev, [questionId]: { checking: false, correct: response.correct, selected } }));
    } catch (checkError) {
      setChecks((prev) => ({ ...prev, [questionId]: { checking: false, error: checkError.message } }));
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await api.submit(id, { answers });
      setResult(response);
      await reload();
    } catch (submitError) {
      setError(submitError);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const scored = result.submission.score !== null;
    return (
      <div className="stack">
        <h1>{assessment.title}</h1>
        <div className={`notice notice-${result.passed === false ? 'bad' : 'good'}`}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {scored
              ? `You scored ${result.submission.score} out of ${assessment.max_score}.`
              : 'Your work has been submitted for review.'}
          </p>
          <p style={{ margin: '.5rem 0 0' }}>
            {result.passed === true && 'That is a pass. Your facilitator may still add comments.'}
            {result.passed === false && `The pass mark is ${assessment.pass_score}. ${attemptsRemaining > 0 ? 'You can try again.' : 'No attempts remain.'}`}
            {result.passed === null && 'Your facilitator will review it and send feedback.'}
          </p>
        </div>
        {/*
          If passing this was the last thing the course needed, the
          certificate has already been issued by the time this screen
          renders. Showing it here matters: someone who finishes a
          course by taking its final quiz should not have to work out
          for themselves that a credential now exists somewhere in a
          menu.
        */}
        <CertificateIfEarned activityId={assessment.activity_id} />

        <FeedbackPanel submissionId={result.submission.id} />
        <Link to={`/activities/${assessment.activity_id}`} className="btn btn-plain">
          Back to {assessment.activity_title}
        </Link>
      </div>
    );
  }

  const latest = attempts.find((attempt) => attempt.status !== 'draft');

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        <Link to={`/activities/${assessment.activity_id}`}>{assessment.activity_title}</Link>
      </p>

      <div>
        <h1>{assessment.title}</h1>
        {assessment.instructions && <p className="muted">{assessment.instructions}</p>}
        <div className="cluster">
          <span className="muted numeric">
            {attemptsRemaining} of {assessment.max_attempts} attempt
            {assessment.max_attempts === 1 ? '' : 's'} left
          </span>
          {assessment.due_at && (
            <span className="muted">
              Due {new Date(assessment.due_at).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {latest && <FeedbackPanel submissionId={latest.id} />}

      {error && <Problem error={error} />}

      {attemptsRemaining === 0 ? (
        <div className="notice">You have used all your attempts for this assessment.</div>
      ) : (
        <form onSubmit={handleSubmit} className="stack">
          {questions.map((question, index) => {
            const check = checks[question.id];
            // A check only speaks to the answer it was taken against. If
            // the participant has since picked something else, stale
            // "Correct"/"Not quite" feedback would be actively wrong, so
            // it is treated as cleared rather than left showing.
            const checkIsCurrent = check && check.selected === answers[question.id];

            return (
              <fieldset key={question.id} className="panel" style={{ border: '1px solid var(--line)' }}>
                <legend className="field-label" style={{ padding: '0 .5rem' }}>
                  Question {index + 1}
                </legend>
                <p style={{ fontWeight: 600 }}>{question.prompt}</p>
                {question.options.map((option) => (
                  <label className="choice" key={option.key}>
                    <input
                      type="radio"
                      name={question.id}
                      value={option.key}
                      checked={answers[question.id] === option.key}
                      onChange={() => setAnswers({ ...answers, [question.id]: option.key })}
                    />
                    <span>{option.text}</span>
                  </label>
                ))}

                <div className="cluster" style={{ marginTop: '.75rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={!answers[question.id] || check?.checking}
                    onClick={() => checkQuestion(question.id)}
                  >
                    {check?.checking ? 'Checking' : 'Check answer'}
                  </button>
                  {checkIsCurrent && check.correct === true && (
                    <span className="tag tag-live" role="status">Correct</span>
                  )}
                  {checkIsCurrent && check.correct === false && (
                    <span className="tag tag-urgent" role="status">Not quite, try another option</span>
                  )}
                  {checkIsCurrent && check.error && (
                    <span className="muted" role="status">{check.error}</span>
                  )}
                </div>
              </fieldset>
            );
          })}

          <div className="between">
            <span className="muted numeric">{answered} of {questions.length} answered</span>
            <button type="submit" className="btn" disabled={busy || answered < questions.length}>
              {busy ? 'Submitting' : 'Submit answers'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Feedback display.
 *
 * Revised feedback is badged as new even when an earlier version was
 * already read, because the server tracks read receipts per version.
 * This is the visible half of the fix for the brief's first incident.
 */
function FeedbackPanel({ submissionId }) {
  const { status, data, error, reload } = useResource(
    () => api.feedback(submissionId),
    [submissionId]
  );

  const unread = (data?.feedback ?? []).some((item) => item.isUnread);

  // Record the read once the feedback has actually been displayed.
  // Doing this from the client, after render, is both more honest (a
  // response being fetched is not evidence a human read it) and what
  // keeps the GET cacheable.
  useEffect(() => {
    if (unread) api.markFeedbackRead(submissionId).catch(() => {});
  }, [unread, submissionId]);

  if (status === 'loading') return <Loading rows={1} label="Loading feedback" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;

  const feedback = data?.feedback ?? [];
  if (!feedback.length) return null;

  return (
    <section className="stack">
      <h2>Feedback</h2>
      {feedback.map((item) => (
        <div className="panel" key={item.id}>
          <div className="between" style={{ marginBottom: '.5rem' }}>
            <strong>{item.reviewerName}</strong>
            <span className="cluster">
              {item.version > 1 && <span className="tag">Revised, version {item.version}</span>}
              {item.isUnread && <span className="tag tag-live">New</span>}
            </span>
          </div>
          <p style={{ marginBottom: 0 }}>{item.body}</p>
          {Object.keys(item.rubric ?? {}).length > 0 && (
            <div className="cluster" style={{ marginTop: '.75rem' }}>
              {Object.entries(item.rubric).map(([criterion, score]) => (
                <span className="tag" key={criterion}>{criterion}: {score}</span>
              ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: '.75rem', margin: '.75rem 0 0' }}>
            Updated {new Date(item.updatedAt).toLocaleString()}
          </p>
        </div>
      ))}
    </section>
  );
}


/* ------------------------------------------------------------------ */

/**
 * Shows the certificate for this course, if one has been earned.
 *
 * Renders nothing when there is none, so it is safe to drop onto the
 * result screen of every assessment. It reads rather than claims: the
 * server issues automatically when the last requirement is met
 * (ADR-019), so by the time this runs the credential either exists or
 * has not been earned.
 */
function CertificateIfEarned({ activityId }) {
  const { status, data } = useResource(() => api.myCertificates(), [activityId]);
  const bannerRef = useRef(null);
  const celebrated = useRef(false);

  // Match on the activity, not just "any live certificate". Someone
  // with three credentials taking a fourth course must not be shown
  // an unrelated one here.
  const cert = (data?.certificates ?? []).find(
    (c) => !c.revoked_at && c.activity_id === activityId
  );

  /**
   * The one moment in this application worth a small celebration: a
   * certificate landing right after the assessment that earned it,
   * rather than being discovered later on a list page. Fires once per
   * mount, from the banner's own position, so it reads as coming from
   * the thing being celebrated rather than the top of the screen.
   */
  useEffect(() => {
    if (cert && bannerRef.current && !celebrated.current) {
      celebrated.current = true;
      confettiBurst(bannerRef.current);
    }
  }, [cert]);

  if (status !== 'loaded' || !cert) return null;

  return (
    <div className="certificate-banner" ref={bannerRef}>
      <h2>Your certificate is ready</h2>
      <p>
        You finished <strong>{cert.activity_title}</strong>. The
        verification code is <strong>{cert.verification_code}</strong>,
        which anyone can check without an account.
      </p>
      <div className="cluster">
        <a className="btn" href={`/api/certificates/${cert.id}/download`}>
          Download certificate
        </a>
        <Link className="btn btn-plain" to="/certificates">All my certificates</Link>
      </div>
    </div>
  );
}
