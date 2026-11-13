import type { PlanInputs, PlanResult } from '../planner.ts';
import type { Ms } from '../domain/types.ts';
import { ACTIVITIES } from '../catalog/catalog.ts';
import { STATUS_AGE_NOTICE_HOURS, STATUS_WINDOW_HOURS } from '../domain/policy.ts';
import { fmtAgo } from './format.ts';
import { EventCard } from './EventCard.tsx';

interface Props {
  inputs: PlanInputs;
  result: PlanResult;
  nowMs: Ms;
  isSaved: (windowStart: number, windowEnd: number) => boolean;
  onSave: (idx: number) => void;
  statusProblem: string | null;
}

export function Results({ inputs, result, nowMs, isSaved, onSave, statusProblem }: Props) {
  const { criteria, timeZone: tz } = inputs;
  const { windows, diagnosis, eligibility } = result;
  const names = (id: number) => ACTIVITIES.find((a) => a.noradId === id)?.name ?? String(id);
  const considered = result.consideredNoradIds.map(names);
  const excluded = eligibility.filter((e) => !e.eligible);
  const unselected = eligibility.filter((e) => e.eligible && !result.consideredNoradIds.includes(e.noradId));
  // Status freshness is judged from when the STATUS reports were downloaded (not the orbital data).
  const statusAt = result.meta.statusDownloadedAt ? Date.parse(result.meta.statusDownloadedAt) : null;
  const statusAgeHours = statusAt === null ? null : Math.max(0, nowMs - statusAt) / 3_600_000;
  const diagCount = excluded.length + result.skipped.length;
  const single = criteria.minOpportunities <= 1; // single-pass mode: each pass is its own result

  return (
    <section aria-labelledby="results-title" className="results">
      <h2 id="results-title" tabIndex={-1}>
        {single
          ? result.windowsTotal > 0
            ? `${result.windowsTotal} qualifying pass${result.windowsTotal === 1 ? '' : 'es'}`
            : 'No qualifying passes'
          : windows.length > 0
            ? `${windows.length} promising event window${windows.length === 1 ? '' : 's'}`
            : 'No qualifying event windows'}
      </h2>
      <p className="hint">
        {single ? (
          <>
            Single passes reaching a peak of {criteria.minElevationDeg}° or higher, with the whole pass (rise to set) inside your availability, ranked by maximum elevation (highest first; earlier first on a tie).
          </>
        ) : (
          <>
            Clusters of at least {criteria.minOpportunities} separate passes, each reaching a peak of {criteria.minElevationDeg}° or higher, with every full pass (rise to set) inside your availability and within a maximum span of {criteria.maxSpanMin / 60} hours.
          </>
        )}
        {' '}Satellites considered: <strong>{considered.length ? considered.join(', ') : 'none (no selected satellite currently qualifies)'}</strong>.
      </p>
      {single && windows.length < result.windowsTotal && <p className="hint small">Showing the highest {windows.length} of {result.windowsTotal}.</p>}

      {statusAt !== null && statusAgeHours !== null && statusAgeHours <= STATUS_AGE_NOTICE_HOURS && (
        <p className="hint small status-age">Status updated {fmtAgo(statusAt, nowMs)}.</p>
      )}
      {statusAt !== null && statusAgeHours !== null && statusAgeHours > STATUS_AGE_NOTICE_HOURS && statusAgeHours <= STATUS_WINDOW_HOURS && (
        <p className="notice warn" role="note">
          Status updated {fmtAgo(statusAt, nowMs)}. Reports filed since then are not included, so eligibility may be out of date; this copy of the status data needs refreshing.
        </p>
      )}
      {statusAt !== null && statusAgeHours !== null && statusAgeHours > STATUS_WINDOW_HOURS && (
        <p className="notice warn" role="note">
          Status updated {fmtAgo(statusAt, nowMs)}. Reports older than {STATUS_WINDOW_HOURS} hours cannot qualify a satellite, so few or none can be eligible until the status data is refreshed.
        </p>
      )}
      {statusAt === null && !statusProblem && <p className="hint small status-age">Status data unavailable.</p>}
      {statusProblem && <p className="notice warn" role="note">{statusProblem}</p>}
      {result.predictionErrors.length > 0 && (
        <p className="notice warn" role="note">
          Prediction failed for {result.predictionErrors.map((e) => names(e.noradId)).join(', ')}.
        </p>
      )}

      {windows.length === 0 && diagnosis && (
        <div className="card no-results" role="region" aria-label="Why there are no results">
          <h3>Why nothing qualified</h3>
          <ul>
            {considered.length === 0 && <li>No selected satellite has a qualifying FM report right now, so there is nothing to plan with. See “Satellites not considered” below.</li>}
            {diagnosis.availabilityBlocks === 0 && <li>Your selected days and times leave no available time inside the search dates.</li>}
            {diagnosis.availabilityBlocks > 0 && diagnosis.eligiblePasses > 0 && diagnosis.blocksHoldingAPass === 0 && (
              <li>None of your available time blocks can hold a whole qualifying pass from rising to setting (about 10 to 15 minutes). Tick longer or adjacent periods so they merge into longer blocks.</li>
            )}
            {considered.length > 0 && !single && (
              <li>
                {diagnosis.eligiblePasses} qualifying pass{diagnosis.eligiblePasses === 1 ? '' : 'es'} reach a peak of {criteria.minElevationDeg}° in your search.
                No cluster within a {criteria.maxSpanMin / 60}-hour maximum span, entirely inside your availability, holds {criteria.minOpportunities} separate, non-overlapping ones.
              </li>
            )}
            {considered.length > 0 && single && (
              <li>
                {diagnosis.eligiblePasses === 0
                  ? `No pass of a selected, eligible satellite reaches a peak of ${criteria.minElevationDeg}° in these dates.`
                  : `${diagnosis.eligiblePasses} qualifying pass${diagnosis.eligiblePasses === 1 ? '' : 'es'} reach a peak of ${criteria.minElevationDeg}°, but none lies entirely inside your availability.`}
              </li>
            )}
          </ul>
          {diagnosis.suggestions.length > 0 ? (
            <>
              <h4>What you could relax (nothing has been changed for you)</h4>
              <ul>{diagnosis.suggestions.map((s) => <li key={s.kind}>{s.text}</li>)}</ul>
            </>
          ) : (
            <p>Relaxing the elevation, the number of passes, or the hours would not help for these dates. Try a different date range, select more satellites, or check again after the next data refresh.</p>
          )}
        </div>
      )}

      {windows.map((w, i) => (
        <EventCard
          key={w.counted.map((c) => c.passId).join('|')} // the counted passes identify a cluster uniquely (exact duplicates are removed); a start time does not
          event={w}
          rank={i + 1}
          tz={tz}
          criteria={criteria}
          meta={result.meta}
          saved={isSaved(w.window.start, w.window.end)}
          onSave={() => onSave(i)}
        />
      ))}

      <details className="card diagnostics">
        <summary>Satellites not considered ({diagCount})</summary>
        <p className="hint small">
          Eligibility is checked against the current time using the reports already downloaded; searching does not download new reports.
          A satellite is left out when this planner lacks the required evidence, a “heard” report for its FM repeater in the last 72 hours. That does not show it is inactive.
        </p>
        {excluded.length > 0 && (
          <ul>
            {excluded.map((e) => (
              <li key={e.noradId}>
                {e.name}: {e.reason}.
                {e.note && <span className="muted"> Catalog note: {e.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {result.skipped.length > 0 && (
          <ul>
            {result.skipped.map((s) => <li key={s.noradId}>{s.name}: {s.reason}</li>)}
          </ul>
        )}
        {unselected.length > 0 && <p className="hint small">Eligible but not selected: {unselected.map((e) => e.name).join(', ')}.</p>}
      </details>
    </section>
  );
}
