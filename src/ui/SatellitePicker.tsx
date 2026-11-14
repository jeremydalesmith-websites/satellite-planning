import { ACTIVITIES, compactBands } from '../catalog/catalog.ts';
import type { SatelliteEligibility } from '../eligibility/eligibility.ts';

interface Props {
  /** null while data is loading or could not be loaded. */
  eligibility: SatelliteEligibility[] | null;
  /** The user's EFFECTIVE selection (stored choice, or the defaults when nothing was chosen yet). */
  selected: readonly number[];
  onToggle: (noradId: number) => void;
}

/**
 * Compact selection of the satellites heard in the status window. Each row shows the report tally, so the evidence is in
 * front of the person; a satellite whose newest reports are corroborated misses carries a warning and is used only if
 * its box is ticked. The selection itself is never edited by eligibility: a selected satellite that is not eligible
 * right now is only mentioned here, and is used again automatically if it becomes eligible.
 */
function tally(s: SatelliteEligibility['status']): string {
  const parts = [`${s.positives} heard`];
  if (s.notHeard > 0) parts.push(`${s.notHeard} not heard`);
  if (s.beaconOnly > 0) parts.push(`${s.beaconOnly} beacon only`);
  return parts.join(' · ');
}

export function SatellitePicker({ eligibility, selected, onToggle }: Props) {
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
                  <span className="muted small"> {tally(e.status)}</span>
                  {e.status.warning && (
                    <span className="tag warn-tag" title={e.status.explanation}>
                      {' '}⚠ newest {e.status.newerNegatives} reports are misses
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {eligible.length > 0 && (
        <p className="hint small">
          Listed: FM repeaters heard in the last 72 hours, with their report counts. ⚠ means the newest reports, from two or more
          stations, are misses, so it may be off; it is planned only if you tick it.
        </p>
      )}
      {heldBack.length > 0 && (
        <p className="hint small">
          Still selected, but not eligible right now: {heldBack.map((e) => e.name).join(', ')}. They stay out of results until they have a “heard” report, then return automatically.
        </p>
      )}
    </fieldset>
  );
}
