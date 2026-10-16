import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Empty, Field } from '../components/ui.jsx';
import { Brand } from '../components/Brand.jsx';

/**
 * A participant's credentials.
 */
export function Certificates() {
  const { status, data, error, reload } = useResource(() => api.myCertificates(), []);

  if (status === 'loading') return <Loading rows={2} label="Loading your certificates" />;
  if (status === 'error') return <Problem error={error} onRetry={reload} />;

  const certificates = data?.certificates ?? [];
  const live = certificates.filter((c) => !c.revoked_at);

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Your certificates</h1>
        <p>
          Each one carries a code anyone can verify without an account,
          which is what makes it useful to an employer.
        </p>
      </header>

      {live.length === 0 && (
        <Empty
          title="No certificates yet"
          action={<Link className="btn" to="/">Find an activity</Link>}
        >
          Complete a course and pass its assessments to earn one.
        </Empty>
      )}

      {certificates.map((cert) => (
        <article className={`cert-card${cert.revoked_at ? ' cert-card-revoked' : ''}`} key={cert.id}>
          <div className="between" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ fontSize: '1.125rem', marginBottom: '.25rem' }}>
                {cert.activity_title}
              </h2>
              <p className="muted" style={{ fontSize: '.875rem', margin: 0 }}>
                Awarded to {cert.recipient_name}
              </p>
            </div>
            {cert.revoked_at && <span className="tag tag-urgent">revoked</span>}
          </div>

          <div className="cluster" style={{ margin: '.75rem 0' }}>
            <span className="muted numeric">
              {new Date(cert.completed_at ?? cert.issued_at).toLocaleDateString()}
            </span>
            {cert.hours && <span className="muted numeric">{Number(cert.hours)} hours</span>}
            {cert.score !== null && cert.score !== undefined && (
              <span className="muted numeric">Score {Number(cert.score).toFixed(0)}%</span>
            )}
          </div>

          <div className="cert-code">
            <span className="muted" style={{ fontSize: '.6875rem', letterSpacing: '.08em' }}>
              VERIFICATION CODE
            </span>
            <strong className="numeric">{cert.verification_code}</strong>
          </div>

          {cert.revoked_at ? (
            <p className="field-error" style={{ marginTop: '.75rem' }}>
              {cert.revoked_reason ?? 'This certificate was withdrawn.'}
            </p>
          ) : (
            <div className="cluster" style={{ marginTop: '1rem' }}>
              <a className="btn" href={`/api/certificates/${cert.id}/download`}>
                Download PDF
              </a>
              <Link className="btn btn-plain" to={`/verify/${cert.verification_code}`}>
                See what an employer sees
              </Link>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

/**
 * Public verification.
 *
 * DELIBERATELY OUTSIDE THE AUTHENTICATED SHELL. An employer in Kampala
 * with a printed certificate needs to check it in ten seconds without
 * creating an account, and a credential that requires a login to verify
 * is not a credential.
 *
 * It shows the achievement and nothing else: no email, no location, no
 * other awards, no internal identifier. Someone holding one code learns
 * about one achievement.
 */
export function Verify() {
  const { code: codeParam } = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState(codeParam ?? '');

  const { status, data, error } = useResource(
    () => (codeParam ? api.verifyCertificate(codeParam) : Promise.resolve(null)),
    [codeParam]
  );

  function handleSubmit(event) {
    event.preventDefault();
    const cleaned = code.trim().toUpperCase();
    if (cleaned) navigate(`/verify/${cleaned}`);
  }

  return (
    <div className="verify-page">
      <div className="verify-card">
        <header className="auth-head">
          <Brand size={40} stacked />
          <h1>Verify a certificate</h1>
          <p>Check any YouthConnect credential. No account needed.</p>
        </header>

        <form onSubmit={handleSubmit}>
          <Field label="Verification code" id="verify-code" hint="Printed on the certificate, for example YCP-A4KP-9MTX-2QRD.">
            <input
              id="verify-code" className="input" required
              placeholder="YCP-XXXX-XXXX-XXXX"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.05em' }}
            />
          </Field>
          <button type="submit" className="btn btn-block btn-lg">Verify</button>
        </form>

        {codeParam && status === 'loading' && (
          <p className="muted" style={{ marginTop: '1.5rem', textAlign: 'center' }}>Checking</p>
        )}

        {codeParam && status !== 'loading' && (
          <VerifyResult result={data} error={error} code={codeParam} />
        )}
      </div>

      <p className="auth-foot">
        <Link to="/signin">Sign in to YouthConnect</Link>
      </p>
    </div>
  );
}

function VerifyResult({ result, error, code }) {
  // A 404 from this endpoint is a valid answer, not a failure: it means
  // no certificate matches. Only treat other errors as errors.
  const payload = result ?? error?.payload ?? null;
  const valid = payload?.valid ?? (error?.status === 404 ? false : null);

  if (valid === null) {
    return (
      <div className="notice notice-bad" role="alert" style={{ marginTop: '1.5rem' }}>
        Could not check that code just now. Try again shortly.
      </div>
    );
  }

  if (!valid) {
    return (
      <div className="verify-result verify-invalid" role="status">
        <h2>Not valid</h2>
        <p>
          {payload?.reason ?? 'No certificate matches that code.'}
        </p>
        <p className="muted numeric" style={{ fontSize: '.8125rem' }}>{code}</p>
      </div>
    );
  }

  const cert = payload.certificate;

  return (
    <div className="verify-result verify-valid" role="status">
      <h2>Verified</h2>
      <p className="verify-name">{cert.recipientName}</p>
      <p className="verify-course">completed <strong>{cert.courseTitle}</strong></p>

      <dl className="verify-facts">
        <div>
          <dt>Completed</dt>
          <dd>{new Date(cert.completedAt ?? cert.issuedAt).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric'
          })}</dd>
        </div>
        {cert.hours && (
          <div><dt>Learning hours</dt><dd>{Number(cert.hours)}</dd></div>
        )}
        {cert.score !== null && cert.score !== undefined && (
          <div><dt>Assessment</dt><dd>{Number(cert.score).toFixed(0)}%</dd></div>
        )}
        <div>
          <dt>Issued</dt>
          <dd>{new Date(cert.issuedAt).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric'
          })}</dd>
        </div>
      </dl>

      <p className="muted" style={{ fontSize: '.75rem', marginTop: '1rem' }}>
        Issued by the YouthConnect Programme. This page shows only the
        achievement associated with this code.
      </p>
    </div>
  );
}
