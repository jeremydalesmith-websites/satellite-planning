import type { PlanInputs, PlanResult } from '../planner.ts';
import type { Ms } from '../domain/types.ts';
import { ACTIVITIES } from '../catalog/catalog.ts';
import { DataFreshness } from './DataFreshness.tsx';
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
  const { windows, diagnosis } = result;
  const names = (id: number) => ACTIVITIES.find((a) => a.noradId === id)?.name ?? String(id);

  return (
    <section aria-labelledby="results-title" className="results">
      <h2 id="results-title" tabIndex={-1}>
        {windows.length > 0
          ? `${windows.length} promising event window${windows.length === 1 ? '' : 's'}`
          : 'No qualifying event windows'}
      </h2>
      <p className="hint">
        {criteria.durationMin / 60}-hour events with at least {criteria.minOpportunities} separate passes reaching {criteria.minElevationDeg}° or higher, inside your available times. Ranked by number of passes, then total usable time, then peak elevations.
      </p>

      <div className="card">
        <DataFreshness meta={result.meta} tz={tz} nowMs={nowMs} />
        {statusProblem && <p className="notice warn" role="note">{statusProblem}</p>}
        {result.skipped.length > 0 && (
          <p className="notice" role="note">
            <strong>Not included:</strong> {result.skipped.map((s) => `${s.name} (${s.reason})`).join(' ')}
          </p>
        )}
        {result.predictionErrors.length > 0 && (
          <p className="notice warn" role="note">
            Prediction failed for {result.predictionErrors.map((e) => names(e.noradId)).join(', ')}.
          </p>
        )}
      </div>

      {windows.length === 0 && diagnosis && (
        <div className="card no-results" role="region" aria-label="Why there are no results">
          <h3>Why nothing qualified</h3>
          <ul>
            {diagnosis.availabilityBlocks === 0 && <li>Your selected days and times leave no available time inside the search dates.</li>}
            {diagnosis.availabilityBlocks > 0 && diagnosis.blocksLongEnough === 0 && (
              <li>None of your available blocks is long enough for a {criteria.durationMin / 60}-hour event. Tick adjacent periods (for example Midday and Evening) so they merge into longer blocks.</li>
            )}
            <li>
              In your search there are {diagnosis.eligiblePasses} passes that count (reaching {criteria.minElevationDeg}° with a repeater recently reported active) and {diagnosis.conditionalPasses} conditional passes with unconfirmed status.
              No {criteria.durationMin / 60}-hour window inside your availability holds {criteria.minOpportunities} separate, non-overlapping ones.
            </li>
          </ul>
          {diagnosis.suggestions.length > 0 ? (
            <>
              <h4>What you could relax (nothing has been changed for you)</h4>
              <ul>{diagnosis.suggestions.map((s) => <li key={s.kind}>{s.text}</li>)}</ul>
            </>
          ) : (
            <p>Even relaxing the elevation, the number of passes, or the hours would not help for these dates. Try a different date range or check again after the next data refresh.</p>
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
    </section>
  );
}
