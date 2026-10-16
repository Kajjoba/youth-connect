import { api } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';

/**
 * Discipline picker.
 *
 * A free-text box produced "Software Development", "software dev" and
 * "coding" as three unrelated values, which makes the Level Two job of
 * assembling multidisciplinary teams impossible: you cannot query for
 * complementary skills across strings that do not match.
 *
 * Presented as grouped toggles rather than a <select multiple>, which
 * is close to unusable on a phone and invisible about what is chosen.
 * Checkboxes styled as chips stay keyboard accessible and readable by a
 * screen reader for free.
 */
export function DisciplinePicker({ selected = [], onChange, max = 8 }) {
  const { status, data } = useResource(() => api.disciplines(), []);

  if (status === 'loading') {
    return <p className="muted">Loading disciplines</p>;
  }

  const groups = data?.disciplines ?? [];
  const atLimit = selected.length >= max;

  function toggle(slug) {
    if (selected.includes(slug)) {
      onChange(selected.filter((entry) => entry !== slug));
    } else if (!atLimit) {
      onChange([...selected, slug]);
    }
  }

  return (
    <fieldset className="picker">
      <legend className="field-label">Disciplines</legend>
      <p className="field-hint">
        Choose up to {max}. Level Two teams are built by pairing people
        whose disciplines complement each other, so this is what makes
        you findable.
      </p>

      <p className="picker-count" aria-live="polite">
        {selected.length} of {max} selected
        {atLimit && ' — remove one to choose another'}
      </p>

      {groups.map((group) => (
        <div className="picker-group" key={group.category}>
          <h4 className="picker-heading">{group.category}</h4>
          <div className="chips">
            {group.items.map((item) => {
              const isOn = selected.includes(item.slug);
              return (
                <label
                  key={item.slug}
                  className={`chip${isOn ? ' chip-on' : ''}${!isOn && atLimit ? ' chip-off' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="visually-hidden"
                    checked={isOn}
                    disabled={!isOn && atLimit}
                    onChange={() => toggle(item.slug)}
                  />
                  {item.label}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
