import { useState, useEffect } from 'react';
import { api, setAccessToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useResource } from '../lib/hooks.js';
import { Loading, Problem, Field, Progress } from '../components/ui.jsx';
import { PasswordField } from '../components/PasswordField.jsx';
import { AvatarPicker } from '../components/AvatarPicker.jsx';
import { DisciplinePicker } from '../components/DisciplinePicker.jsx';

const LITERACY = [
  ['beginner', 'New to online learning tools'],
  ['intermediate', 'Reasonably comfortable'],
  ['advanced', 'Very comfortable']
];

const COUNTRIES = [
  ['UG', 'Uganda'], ['KE', 'Kenya'], ['TZ', 'Tanzania'], ['RW', 'Rwanda'],
  ['BI', 'Burundi'], ['SS', 'South Sudan'], ['ET', 'Ethiopia'], ['SO', 'Somalia']
];

/**
 * The profile screen carries three unrelated jobs: presenting yourself,
 * your picture, and your account security. Stacking them in one long
 * form made the page feel endless and buried the security controls at
 * the bottom where nobody scrolled.
 *
 * Tabs, not an accordion: only one of these is ever being worked on at
 * a time, and a tab makes the other two discoverable without them
 * taking vertical space.
 */
export default function Profile() {
  const { user, patchUser } = useAuth();
  const [tab, setTab] = useState('details');

  const { status, data, error, reload } = useResource(
    () => api.profile(user.id),
    [user.id]
  );

  if (status === 'loading') return <Loading rows={3} label="Loading your profile" />;
  if (status === 'error' && !data) return <Problem error={error} onRetry={reload} />;
  if (!data) return null;

  const profile = data.profile;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Your profile</h1>
        <p>This is what facilitators and future teammates see.</p>
      </header>

      <div className="panel">
        <Progress done={profile.completeness} total={100} label="Profile completeness" />
        {profile.completeness < 70 && (
          <p className="muted" style={{ margin: '.75rem 0 0', fontSize: '.875rem' }}>
            Teams are formed from these profiles. Adding your disciplines
            and skills makes you easier to find.
          </p>
        )}
      </div>

      <div className="segmented" role="tablist" aria-label="Profile sections">
        {[
          ['details', 'Details'],
          ['picture', 'Picture'],
          ['security', 'Security']
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`segment${tab === key ? ' segment-on' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'details' && (
        <DetailsForm profile={profile} userId={user.id} onSaved={reload} patchUser={patchUser} />
      )}
      {tab === 'picture' && (
        <PictureSection profile={profile} userId={user.id} onSaved={reload} />
      )}
      {tab === 'security' && <SecuritySection />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function DetailsForm({ profile, userId, onSaved, patchUser }) {
  const [form, setForm] = useState(() => ({
    fullName: profile.full_name ?? '',
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
    country: profile.country ?? '',
    phone: profile.phone ?? '',
    skills: (profile.skills ?? []).join(', '),
    languages: (profile.languages ?? []).join(', '),
    disciplines: profile.disciplines ?? [],
    digitalLiteracy: profile.digital_literacy ?? 'intermediate',
    lowBandwidthMode: Boolean(profile.low_bandwidth_mode)
  }));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const update = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm({ ...form, [key]: value });
    setSaved(false);
  };

  const toList = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);

  async function handleSave(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateProfile(userId, {
        fullName: form.fullName,
        headline: form.headline || undefined,
        bio: form.bio || undefined,
        country: form.country || undefined,
        phone: form.phone || undefined,
        skills: toList(form.skills),
        languages: toList(form.languages),
        disciplines: form.disciplines,
        digitalLiteracy: form.digitalLiteracy,
        lowBandwidthMode: form.lowBandwidthMode
      });
      patchUser({ fullName: result.profile.full_name });
      setSaved(true);
      await onSaved();
    } catch (saveError) {
      setError(saveError.details ? Object.values(saveError.details)[0] : saveError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSave}>
      {saved && <div className="notice notice-good" role="status">Profile saved.</div>}
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <Field label="Full name" id="fullName">
        <input id="fullName" className="input" value={form.fullName} onChange={update('fullName')} required />
      </Field>

      <Field label="Headline" id="headline" hint="One line on what you do or are working towards.">
        <input
          id="headline" className="input" maxLength={140}
          placeholder="Agricultural science graduate interested in data"
          value={form.headline} onChange={update('headline')}
        />
      </Field>

      <Field label="About you" id="bio">
        <textarea id="bio" className="textarea" maxLength={2000} value={form.bio} onChange={update('bio')} />
      </Field>

      <Field label="Country" id="country">
        <select id="country" className="select" value={form.country} onChange={update('country')}>
          <option value="">Select your country</option>
          {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
      </Field>

      <Field label="Phone" id="phone" hint="Only you and programme staff can see this.">
        <input id="phone" className="input" type="tel" inputMode="tel"
               value={form.phone} onChange={update('phone')} />
      </Field>

      <DisciplinePicker
        selected={form.disciplines}
        onChange={(disciplines) => { setForm({ ...form, disciplines }); setSaved(false); }}
      />

      <Field label="Skills" id="skills" hint="Separate with commas.">
        <input
          id="skills" className="input"
          placeholder="data analysis, facilitation, Python"
          value={form.skills} onChange={update('skills')}
        />
      </Field>

      <Field label="Languages" id="languages" hint="Separate with commas.">
        <input
          id="languages" className="input"
          placeholder="English, Swahili, Luganda"
          value={form.languages} onChange={update('languages')}
        />
      </Field>

      <Field
        label="How comfortable are you with online learning tools?"
        id="literacy"
        hint="We show more guidance if you are still getting used to them."
      >
        <select id="literacy" className="select" value={form.digitalLiteracy} onChange={update('digitalLiteracy')}>
          {LITERACY.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>

      <label className="choice" style={{ marginBottom: '1.5rem' }}>
        <input type="checkbox" checked={form.lowBandwidthMode} onChange={update('lowBandwidthMode')} />
        <span>
          <strong style={{ display: 'block' }}>Use less data</strong>
          <span className="muted">
            Hides images and large downloads, and warns you before opening
            anything heavy.
          </span>
        </span>
      </label>

      <button type="submit" className="btn btn-block btn-lg" disabled={busy}>
        {busy ? 'Saving' : 'Save changes'}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */

function PictureSection({ profile, userId, onSaved }) {
  return (
    <div className="panel">
      <AvatarPicker
        userId={userId}
        currentUrl={profile.avatar_url}
        fullName={profile.full_name}
        onChange={() => onSaved()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SecuritySection() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  const update = (key) => (event) => {
    setForm({ ...form, [key]: event.target.value });
    setDone(null);
    setError(null);
  };

  async function handleSubmit(event) {
    event.preventDefault();

    if (form.newPassword !== form.confirm) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword
      });
      // The server re-issues this device's session, since every session
      // including this one was just revoked.
      if (result.accessToken) setAccessToken(result.accessToken);
      setDone(result.message);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (changeError) {
      setError(changeError.details
        ? Object.values(changeError.details)[0]
        : changeError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h2 style={{ fontSize: '1.125rem', marginBottom: '.5rem' }}>Change your password</h2>
      <p className="muted" style={{ fontSize: '.875rem' }}>
        Changing your password signs you out everywhere else. Do this if
        you think someone else has used your account.
      </p>

      {done && <div className="notice notice-good" role="status">{done}</div>}
      {error && <div className="notice notice-bad" role="alert">{error}</div>}

      <PasswordField
        id="current-password"
        label="Current password"
        value={form.currentPassword}
        onChange={update('currentPassword')}
        autoComplete="current-password"
      />

      <PasswordField
        id="new-password"
        label="New password"
        hint="At least 10 characters, with upper case, lower case and a number."
        value={form.newPassword}
        onChange={update('newPassword')}
        autoComplete="new-password"
      />

      <PasswordField
        id="confirm-password"
        label="Confirm new password"
        value={form.confirm}
        onChange={update('confirm')}
        autoComplete="new-password"
      />

      <button type="submit" className="btn btn-block btn-lg" disabled={busy}>
        {busy ? 'Changing' : 'Change password'}
      </button>
    </form>
  );
}
