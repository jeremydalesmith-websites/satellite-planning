import { ACTIVITIES, compactBands } from '../catalog/catalog.ts';
import type { SatelliteEligibility } from '../eligibility/eligibility.ts';
import { fmtDateTime, tzAbbrev } from './format.ts';

interface Props {
  /** null while data is loading or could not be loaded. */
  eligibility: SatelliteEligibility[] | null;
  /** The user's EFFECTIVE selection (stored choice, or the defaults when nothing was chosen yet). */
  selected: readonly number[];
  onToggle: (noradId: number) => void;
  tz: string;
}

/**
 * Compact selection of the satellites that currently pass the operational-eligibility rule.
 * The selection itself is never edited by eligibility: a selected satellite that is not eligible
 * right now is only mentioned here, and is used again automatically if it becomes eligible.
 */
export function SatellitePicker({ eligibility, selected, onToggle, tz }: Props) {
  if (!eligibility) {
    return (
      <fieldset className="sat-picker">
        <legend>Satellites to consider</legend>
        <p className="hint small" role="status">Satellite eligibility is shown once the data has loaded.</p>
      </fieldset>
    );
  }
  const eligible = eligibility.filter((e) => e.eligible);
  const heldBack = eligibility.filter((e) => !e.eligible && selected.includes(e.noradId));
  const downloaded = eligibility[0]?.status.dataDownloadedAt ?? null;
  const act = (id: number) => ACTIVITIES.find((a) => a.noradId === id);

  return (
    <fieldset className="sat-picker">
      <legend>Satellites to consider</legend>
      {eligible.length === 0 ? (
        <p className="hint" role="status">
          No satellite has a qualifying FM report in the last 72 hours in the loaded status data, so none can be selected right now.
        </p>
      ) : (
        <ul className="sat-list">
          {eligible.map((e) => {
            const a = act(e.noradId);
            return (
              <li key={e.noradId}>
                <label title={a?.restrictions.map((r) => r.text).join(' ')}>
                  <input type="checkbox" checked={selected.includes(e.noradId)} onChange={() => onToggle(e.noradId)} />
                  <strong>{e.name}</strong>
                  {a && <span className="muted"> {compactBands(a)}</span>}
                  {a?.sunlightRequired && <span className="tag"> sunlit only</span>}
                  {a?.interruptible && <span className="tag"> {a.interruptibleBadge ?? 'interruptible'}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {heldBack.length > 0 && (
        <p className="hint small">
          Still selected, but not eligible right now: {heldBack.map((e) => e.name).join(', ')}. They stay out of results until they have a qualifying report, then return automatically.
        </p>
      )}
      <p className="hint small">
        Only satellites with a “heard” report for their FM repeater in the last 72 hours are listed. That is evidence of operation now, not a promise for the event date.
        {' '}Eligibility is checked against the current time using status reports downloaded{' '}
        {downloaded ? `${fmtDateTime(Date.parse(downloaded), tz)} ${tzAbbrev(Date.parse(downloaded), tz)}` : '(none available)'}; searching does not download new reports.
      </p>
    </fieldset>
  );
}
