import {
  PERIOD_IDS,
  PERIOD_LABELS,
  WEEKDAY_LABELS,
  formatMinutes,
  inputToMinutes,
  minutesToInput,
} from '../availability/availability.ts';
import type { AvailabilitySettings, PeriodId } from '../availability/availability.ts';

interface Props {
  value: AvailabilitySettings;
  onChange: (v: AvailabilitySettings) => void;
  /** Kept for callers; the zone is shown once, in the form's compact "Timezone: ... · Change" line. */
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
  /** Check or uncheck all 21 day x period boxes. Time-range definitions are not touched. */
  const setAll = (checked: boolean) => {
    const selected = { ...value.selected };
    for (const p of PERIOD_IDS) selected[p] = value.selected[p].map(() => checked);
    onChange({ ...value, selected });
  };
  /** Weekend shortcut: Saturday and Sunday on (all three periods), Monday to Friday off. Time ranges are untouched. */
  const isWeekend = (d: number) => d === 0 || d === 6;
  const setWeekend = () => {
    const selected = { ...value.selected };
    for (const p of PERIOD_IDS) selected[p] = value.selected[p].map((_, d) => isWeekend(d));
    onChange({ ...value, selected });
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

      <div className="grid-actions">
        <button type="button" onClick={() => setAll(true)}>Check all</button>
        <button type="button" onClick={() => setAll(false)}>Uncheck all</button>
        <button type="button" onClick={setWeekend} title="Select Saturday and Sunday, clear Monday to Friday">Weekend</button>
      </div>
    </fieldset>
  );
}
