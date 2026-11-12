import type { Ms } from '../domain/types.ts';
import { predictAll } from '../orbit/predict.ts';
import { assessAll, predictionThresholds, statusMap, usableElements } from '../planner.ts';
import type { LoadedData } from '../planner.ts';
import { recheckEvent } from './saved.ts';
import type { Recheck, SavedEvent } from './saved.ts';

export type RecheckOutcome =
  | { ok: true; recheck: Recheck; passed: boolean; nowMs: Ms; skippedNote: string | null }
  | { ok: false; message: string };

/**
 * Recompute a saved event against current data. The window is short (hours), so this
 * runs inline: it is a few milliseconds of work, unlike a 42-day search.
 */
export function recheckSavedEvent(saved: SavedEvent, data: LoadedData | null, nowMs: Ms): RecheckOutcome {
  if (!data) return { ok: false, message: 'Current orbital data is unavailable, so this event cannot be re-checked right now. Showing what was saved.' };
  const { usable, skipped } = usableElements(data.elements, nowMs);
  if (usable.length === 0) return { ok: false, message: 'No usable orbital data is available for a re-check.' };
  const margin = 60 * 60_000;
  const run = predictAll(
    usable,
    { latDeg: saved.location.latDeg, lonDeg: saved.location.lonDeg, heightKm: 0 },
    saved.window.start - margin,
    saved.window.end + margin,
    { thresholdsDeg: predictionThresholds(saved.criteria.minElevationDeg) },
  );
  const assessments = assessAll(run.passes, statusMap(data, nowMs), saved.criteria.minElevationDeg);
  return {
    ok: true,
    recheck: recheckEvent(saved, assessments),
    passed: saved.window.end < nowMs,
    nowMs,
    skippedNote: skipped.length ? `Not included in this re-check: ${skipped.map((s) => s.name).join(', ')} (orbital data too old or missing).` : null,
  };
}
