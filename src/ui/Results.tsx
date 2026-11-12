import type { PlanInputs, PlanResult } from '../planner.ts';
import type { Ms } from '../domain/types.ts';
import { ACTIVITIES } from '../catalog/catalog.ts';
import { EventCard } from './EventCard.tsx';

interface Props {
  inputs: PlanInputs;
  result: PlanResult;
  nowMs: Ms;
  isSaved: (windowStart: number, windowEnd: number) => boolean;
  onSave: (idx: number) => void;
  statusProblem: string | null;
}

/** Days after which the downloaded data gets a visible warning (actionable; routine timestamps stay in the footer). */
const STALE_DATA_NOTICE_DAYS = 3;

export function Results({ inputs, result, nowMs, isSaved, onSave, statusProblem }: Props) {
  const { criteria, timeZone: tz } = inputs;
  const { windows, diagnosis, eligibility } = result;
  const names = (id: number) => ACTIVITIES.find((a) => a.noradId === id)?.name ?? String(id);
  const considered = result.consideredNoradIds.map(names);
  const excluded = eligibility.filter((e) => !e.eligible);
  const unselected = eligibility.filter((e) => e.eligible && !result.consideredNoradIds.includes(e.noradId));
  const staleDays = (nowMs - Date.parse(result.meta.elementsDownloadedAt)) / 86_400_000;
  const diagCount = excluded.length + result.skipped.length;

  return (
    <section aria-labelledby="results-title" className="results">
      <h2 id="results-title" tabIndex={-1}>
        {windows.length > 0
          ? `${windows.length} promising event window${windows.length === 1 ? '' : 's'}`
          : 'No qualifying event windows'}
      </h2>
      <p className="hint">
        {criteria.durationMin / 60}-hour events with at least {criteria.minOpportunities} separate passes reaching {criteria.minElevationDeg}° or higher, inside your available times.
        {' '}Satellites considered: <strong>{considered.length ? considered.join(', ') : 'none (no selected satellite currently qualifies)'}</strong>.
      </p>

      {staleDays > STALE_DATA_NOTICE_DAYS && (
        <p className="notice warn" role="note">
          This copy of the data was downloaded {Math.round(staleDays)} days ago. Searching does not download newer data, and reports older than 72 hours cannot qualify a satellite.
        </p>
      )}
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
            {diagnosis.availabilityBlocks > 0 && diagnosis.blocksLongEnough === 0 && (
              <li>None of your available blocks is long enough for a {criteria.durationMin / 60}-hour event. Tick adjacent periods (for example Midday and Evening) so they merge into longer blocks.</li>
            )}
            {considered.length > 0 && (
              <li>
                {diagnosis.eligiblePasses} qualifying pass{diagnosis.eligiblePasses === 1 ? '' : 'es'} reach {criteria.minElevationDeg}° in your search.
                No {criteria.durationMin / 60}-hour window inside your availability holds {criteria.minOpportunities} separate, non-overlapping ones.
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
          key={w.window.start}
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
