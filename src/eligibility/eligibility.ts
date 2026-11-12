/**
 * Strict operational eligibility and satellite selection.
 *
 * A satellite is eligible for planning ONLY if its exact FM repeater entry has a
 * qualifying positive report within the rolling status window (72 h), measured back
 * from the time of evaluation (now), with no newer negative report. This is evidence
 * that the repeater operates NOW. It does not imply it will operate at a predicted
 * event weeks ahead. Anything else is excluded from planning entirely: it never
 * appears in timelines, pass cards, counts or ranking. Excluded satellites are only
 * listed, with a reason, in a collapsed diagnostic area.
 *
 * Selection is a separate, user-controlled filter applied on top of eligibility.
 *
 * A recent positive report is NECESSARY, not sufficient. Besides sunlight (enforced per pass in
 * assess.ts), repeaters classified `activation-required` in the catalog (scheduled, experimental or
 * commanded activation) never qualify from reports alone: with no activation-confirmation source in this
 * iteration they are excluded and explained. `interruptible` repeaters (ISS) are normally operating and
 * qualify on recent evidence like any other.
 */
import { ACTIVITIES } from '../catalog/catalog.ts';
import type { FmActivity } from '../catalog/catalog.ts';
import type { StatusFile } from '../data/ingest.ts';
import type { Ms } from '../domain/types.ts';
import { classifyStatus, exclusionReason } from './status.ts';
import type { OperationalStatus } from './status.ts';

/** Selected by default when eligible: ISS, SO-50, AO-91. */
export const DEFAULT_SELECTED_NORAD_IDS: readonly number[] = [25544, 27607, 43017];

export interface SatelliteEligibility {
  noradId: number;
  name: string;
  eligible: boolean;
  /** Why the planner lacks the required evidence; null when eligible. */
  reason: string | null;
  /** For activation-required satellites: the cited catalog note explaining the operating pattern (diagnostics only). */
  note: string | null;
  status: OperationalStatus;
}

/** Evaluate every catalog repeater against the status data at time `nowMs`. */
export function evaluateEligibility(
  statusFile: StatusFile | null,
  nowMs: Ms,
  activities: readonly FmActivity[] = ACTIVITIES,
): SatelliteEligibility[] {
  return activities.map((a) => {
    const status = classifyStatus(a, statusFile, nowMs);
    const reason = exclusionReason(status);
    const note = a.activationRequired ? (a.restrictions.find((r) => r.kind === 'activation-required')?.text ?? null) : null;
    return { noradId: a.noradId, name: a.name, eligible: reason === null, reason, note, status };
  });
}

/** Satellites that may appear in results: eligible AND selected. `selected` undefined = the defaults. */
export function consideredIds(
  eligibility: readonly SatelliteEligibility[],
  selected: readonly number[] = DEFAULT_SELECTED_NORAD_IDS,
): Set<number> {
  const sel = new Set(selected);
  return new Set(eligibility.filter((e) => e.eligible && sel.has(e.noradId)).map((e) => e.noradId));
}
