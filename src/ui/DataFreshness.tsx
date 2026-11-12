import type { Ms } from '../domain/types.ts';
import { fmtDateTime, tzAbbrev } from './format.ts';

interface Props {
  /** When the orbital elements were downloaded (ISO). */
  orbitalDownloadedAt: string;
  /** Epoch of each satellite's elements. */
  epochs: readonly Ms[];
  /** When the status reports were downloaded (ISO), or null if unavailable. */
  statusDownloadedAt: string | null;
  /** The current-time snapshot against which eligibility was last checked (existing reports; nothing re-downloaded). */
  eligibilityCheckedAtMs: Ms;
  /** When predictions were last calculated, or null before the first search. */
  predictionsCalculatedAtMs: Ms | null;
  tz: string;
}

/**
 * Routine data timestamps. Shown ONLY inside the collapsed "About this planner" footer, never in the results.
 * It keeps the distinctions that matter: when data was downloaded, how old the orbital elements are, when
 * eligibility was last checked (against existing reports, with no new download), and when predictions were calculated.
 */
export function DataFreshness({ orbitalDownloadedAt, epochs, statusDownloadedAt, eligibilityCheckedAtMs, predictionsCalculatedAtMs, tz }: Props) {
  const oldest = epochs.length ? Math.min(...epochs) : null;
  const newest = epochs.length ? Math.max(...epochs) : null;
  const z = (ms: Ms) => `${fmtDateTime(ms, tz)} ${tzAbbrev(ms, tz)}`;
  return (
    <dl className="fresh" aria-label="Data and timing">
      <div>
        <dt>Orbital data downloaded</dt>
        <dd>{z(Date.parse(orbitalDownloadedAt))}</dd>
      </div>
      <div>
        <dt>Orbital elements dated (epoch)</dt>
        <dd>{oldest !== null && newest !== null ? (oldest === newest ? z(oldest) : `${z(oldest)} to ${z(newest)}`) : 'n/a'}</dd>
      </div>
      <div>
        <dt>Status reports downloaded</dt>
        <dd>{statusDownloadedAt ? z(Date.parse(statusDownloadedAt)) : 'unavailable: no satellite can be confirmed'}</dd>
      </div>
      <div>
        <dt>Eligibility last checked</dt>
        <dd>{z(eligibilityCheckedAtMs)} (existing reports; nothing is re-downloaded by searching)</dd>
      </div>
      <div>
        <dt>Predictions calculated</dt>
        <dd>{predictionsCalculatedAtMs !== null ? z(predictionsCalculatedAtMs) : 'not yet (run a search)'}</dd>
      </div>
    </dl>
  );
}
