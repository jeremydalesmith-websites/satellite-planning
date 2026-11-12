import {
  PERIOD_IDS,
  PERIOD_LABELS,
  WEEKDAY_LABELS,
  formatMinutes,
  inputToMinutes,
  mergedDayRanges,
  minutesToInput,
} from '../availability/availability.ts';
import type { AvailabilitySettings, PeriodId } from '../availability/availability.ts';

interface Props {
  value: AvailabilitySettings;
  onChange: (v: AvailabilitySettings) => void;
  /** Kept for callers; the zone is shown once, in the form's compact "Times: ... · Change" line. */
  timeZone?: string;
  invalid?: boolean;
  describedBy?: string;
}

export function AvailabilityGrid({ value, onChange, invalid, describedBy }: Props) {
  const toggle = (p: PeriodId, d: number) => {
    const row = value.selected[p].slice();
    row[d] = !row[d];
    onChange({ ...value, selected: { ...value.selected, [p]: row } });
  };
  const setTime = (p: PeriodId, which: 'startMin' | 'endMin', text: string) => {
    const parsed = inputToMinutes(text);
    if (parsed === null) return;
    // An end time of 23:59 means "until midnight".
    const min = which === 'endMin' && parsed === 1439 ? 1440 : parsed;
    onChange({ ...value, periods: { ...value.periods, [p]: { ...value.periods[p], [which]: min } } });
  };
  const toggleDay = (d: number) => {
    const all = PERIOD_IDS.every((p) => value.selected[p][d]);
    const selected = { ...value.selected };
    for (const p of PERIOD_IDS) {
      const row = selected[p].slice();
      row[d] = !all;
      selected[p] = row;
    }
    onChange({ ...value, selected });
  };

  return (
    <fieldset className="avail" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
      <legend>Availability</legend>
      <p className="hint">Set time ranges, then check the days you’re available.</p>

      <div className="periods">
        {PERIOD_IDS.map((p) => (
          <div className="period-row" key={p}>
            <span className="period-name">{PERIOD_LABELS[p]}</span>
            <label>
              <span className="sr-only">{PERIOD_LABELS[p]} starts at</span>
              <input type="time" value={minutesToInput(value.periods[p].startMin)} onChange={(e) => setTime(p, 'startMin', e.target.value)} />
            </label>
            <span aria-hidden="true">to</span>
            <label>
              <span className="sr-only">{PERIOD_LABELS[p]} ends at</span>
              <input
                type="time"
                value={value.periods[p].endMin >= 1440 ? '23:59' : minutesToInput(value.periods[p].endMin)}
                onChange={(e) => setTime(p, 'endMin', e.target.value)}
              />
            </label>
          </div>
        ))}
        <p className="hint small">These are your availability periods, not sunrise or sunset.</p>
      </div>

      <table className="grid">
        <caption className="sr-only">Weekly availability. Each checkbox is one day and time period.</caption>
        <thead>
          <tr>
            <td />
            {WEEKDAY_LABELS.map((d, i) => (
              <th scope="col" key={d}>
                <button type="button" className="day-btn" onClick={() => toggleDay(i)} aria-label={`Toggle all of ${d}`} title={`Toggle all of ${d}`}>
                  <abbr title={d}>{d.slice(0, 3)}</abbr>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERIOD_IDS.map((p) => (
            <tr key={p}>
              <th scope="row">
                {PERIOD_LABELS[p]}
                <span className="row-times">
                  {formatMinutes(value.periods[p].startMin).replace(':00', '')}–{formatMinutes(value.periods[p].endMin).replace(':00', '').replace(' (next day)', '')}
                </span>
              </th>
              {WEEKDAY_LABELS.map((d, i) => (
                <td key={d}>
                  <label className="cell">
                    <input type="checkbox" checked={value.selected[p][i] ?? false} onChange={() => toggle(p, i)} aria-label={`${d} ${PERIOD_LABELS[p].toLowerCase()}`} />
                    <span className="box" aria-hidden="true" />
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <details className="merge-preview">
        <summary>How your selection combines</summary>
        <p className="hint small">Adjacent or overlapping periods merge into one block, so a Midday + Evening event can run across the boundary.</p>
        <ul>
          {WEEKDAY_LABELS.map((d, i) => {
            const r = mergedDayRanges(value, i);
            return (
              <li key={d}>
                <strong>{d}:</strong> {r.length ? r.map(([a, b]) => `${formatMinutes(a)}–${formatMinutes(b)}`).join(', ') : 'not available'}
              </li>
            );
          })}
        </ul>
      </details>
    </fieldset>
  );
}
