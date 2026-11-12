/**
 * Saved events: a FIXED cluster interval plus a snapshot of why it was chosen.
 *
 * A new event stores the actual cluster interval shown in its header (earliest full-pass AOS to latest
 * full-pass LOS of the counted passes). When data refreshes, `recheckEvent` re-evaluates that SAME interval with
 * the SAME criteria against newly computed passes and reports what changed. It never moves, resizes or deletes
 * the event: the gathering is a human commitment, so only the evidence is recomputed. A pass that drifts so
 * that its full pass is no longer inside the saved interval is flagged, not followed.
 *
 * Format version: `schema: 2` marks the full-pass cluster model. Events saved under the earlier fixed-window
 * model (`schema: 1`) are NOT re-interpreted: they are left untouched in storage and are not shown or re-checked.
 */
import { SAVED_ELEVATION_REPORT_DEG, SAVED_MATCH_TOLERANCE_MIN, SAVED_SHIFT_REPORT_SEC } from '../domain/policy.ts';
import type { Criteria, Interval, Ms } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import { exclusionReason } from '../eligibility/status.ts';
import type { StatusState } from '../eligibility/status.ts';
import { evaluateFixedInterval } from '../cluster/cluster.ts';
import type { EventWindow, WindowEvaluation } from '../cluster/cluster.ts';
import type { PredictionMeta } from '../planner.ts';

export const SAVED_SCHEMA = 2 as const;

export interface SavedOpportunity {
  noradId: number;
  name: string;
  riseMs: Ms;
  peakMs: Ms;
  setMs: Ms;
  /** Permitted operating time within the pass when saved (no eclipsed time). */
  operatingMs: number;
  fullMaxElevationDeg: number;
  eligibleMaxElevationDeg: number | null;
  statusState: StatusState;
}

export interface SavedEvent {
  schema: typeof SAVED_SCHEMA;
  id: string;
  savedAtMs: Ms;
  /** The fixed cluster interval exactly as displayed in the header when saved. */
  window: Interval;
  location: { latDeg: number; lonDeg: number };
  timeZone: string;
  criteria: Criteria;
  /**
   * The satellites the user had selected when the event was saved (NORAD IDs). A re-check considers ONLY these, so an
   * unselected satellite can never appear. Absent on records saved before this field existed: see savedSatelliteIds.
   */
  selectedNoradIds?: number[];
  original: {
    counted: SavedOpportunity[];
    distinctSatellites: number;
    totalOperatingMs: number;
    meta: PredictionMeta;
  };
}

function toSaved(a: PassAssessment): SavedOpportunity {
  return {
    noradId: a.noradId,
    name: a.name,
    riseMs: a.riseMs,
    peakMs: a.peakMs,
    setMs: a.setMs,
    operatingMs: a.operatingMs,
    fullMaxElevationDeg: a.fullMaxElevationDeg,
    eligibleMaxElevationDeg: a.eligibleMaxElevationDeg,
    statusState: a.status.state,
  };
}

export function snapshotEvent(
  w: Pick<EventWindow, 'window' | 'counted' | 'distinctSatellites' | 'totalOperatingMs'>,
  location: { latDeg: number; lonDeg: number },
  timeZone: string,
  criteria: Criteria,
  meta: PredictionMeta,
  nowMs: Ms,
  id: string = `ev-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  selectedNoradIds?: readonly number[],
): SavedEvent {
  return {
    schema: SAVED_SCHEMA,
    id,
    savedAtMs: nowMs,
    window: { ...w.window },
    location: { ...location },
    timeZone,
    criteria: { ...criteria },
    ...(selectedNoradIds ? { selectedNoradIds: [...selectedNoradIds] } : {}),
    original: {
      counted: w.counted.map(toSaved),
      distinctSatellites: w.distinctSatellites,
      totalOperatingMs: w.totalOperatingMs,
      meta,
    },
  };
}

/**
 * The satellites a re-check may consider: the ones selected when the event was saved. Records saved before the selection
 * was stored have no such list, so they fall back to the satellites that were originally COUNTED (conservative: a
 * re-check can never bring in a satellite that was not part of the event).
 */
export function savedSatelliteIds(saved: SavedEvent): Set<number> {
  return new Set(saved.selectedNoradIds ?? saved.original.counted.map((c) => c.noradId));
}

export type ChangeKind = 'lost' | 'added' | 'shifted' | 'elevation' | 'status' | 'eligibility';

/** A saved opportunity whose satellite no longer has the evidence the planner requires. */
export interface LostEligibility {
  noradId: number;
  name: string;
  peakMs: Ms;
  /** Why the evidence is missing, e.g. "no qualifying FM report in the last 72 hours". */
  reason: string;
}

export interface Change {
  kind: ChangeKind;
  /** Plain-language description of one meaningful change. */
  text: string;
}

export interface Recheck {
  evaluation: WindowEvaluation;
  changes: Change[];
  /** Saved opportunities flagged because eligibility can no longer be established. Never silently kept as eligible. */
  lostEligibility: LostEligibility[];
  countNow: number;
  countBefore: number;
  meetsMinimum: boolean;
}

const fmtShift = (sec: number) => {
  const a = Math.abs(sec);
  const t = a >= 90 ? `${Math.round(a / 60)} min` : `${Math.round(a)} s`;
  return `${t} ${sec > 0 ? 'later' : 'earlier'}`;
};

/**
 * Re-evaluate a saved event against freshly assessed passes.
 * `assessments` must have been computed with the event's own criteria.
 */
export function recheckEvent(saved: SavedEvent, assessments: readonly PassAssessment[]): Recheck {
  const evaluation = evaluateFixedInterval(saved.window, assessments);
  const tolerance = SAVED_MATCH_TOLERANCE_MIN * 60_000;
  const universe: Array<{ a: PassAssessment; where: 'counted' | 'alternative' | 'edge' | 'excluded' }> = [
    ...evaluation.counted.map((a) => ({ a, where: 'counted' as const })),
    ...evaluation.alternatives.map((a) => ({ a, where: 'alternative' as const })),
    ...evaluation.edge.map((a) => ({ a, where: 'edge' as const })),
    ...evaluation.excluded.map((a) => ({ a, where: 'excluded' as const })),
  ];
  // Passes of satellites that lack a qualifying recent FM report (never shown as passes).
  const ineligible = assessments.filter((a) => a.exclusion === 'status');
  const changes: Change[] = [];
  const lostEligibility: LostEligibility[] = [];
  const matchedNow = new Set<string>();

  for (const old of saved.original.counted) {
    const m = universe.find((u) => u.a.noradId === old.noradId && Math.abs(u.a.peakMs - old.peakMs) <= tolerance && !matchedNow.has(u.a.passId));
    if (!m) {
      const inel = ineligible.find((a) => a.noradId === old.noradId && Math.abs(a.peakMs - old.peakMs) <= tolerance);
      if (inel) {
        const reason = exclusionReason(inel.status) ?? 'eligibility cannot be established';
        lostEligibility.push({ noradId: old.noradId, name: old.name, peakMs: old.peakMs, reason });
        changes.push({ kind: 'eligibility', text: `${old.name} pass no longer counts: ${reason}. The saved date and time have not moved.` });
        continue;
      }
      changes.push({ kind: 'lost', text: `${old.name} pass no longer appears: it no longer reaches ${saved.criteria.minElevationDeg}° near this time.` });
      continue;
    }
    matchedNow.add(m.a.passId);
    if (m.where !== 'counted') {
      const why: Record<string, string> = {
        alternative: 'it now overlaps another counted pass',
        edge: 'its full pass now extends outside the saved interval',
        excluded: m.a.reasons[0] ?? 'it no longer qualifies',
      };
      changes.push({ kind: 'lost', text: `${old.name} pass no longer counts: ${why[m.where]}` });
      continue;
    }
    const dt = (m.a.peakMs - old.peakMs) / 1000;
    if (Math.abs(dt) >= SAVED_SHIFT_REPORT_SEC) {
      changes.push({ kind: 'shifted', text: `${old.name} pass moved ${fmtShift(dt)}.` });
    }
    const oldEl = old.eligibleMaxElevationDeg ?? old.fullMaxElevationDeg;
    const newEl = m.a.eligibleMaxElevationDeg ?? m.a.fullMaxElevationDeg;
    if (Math.abs(newEl - oldEl) >= SAVED_ELEVATION_REPORT_DEG) {
      changes.push({ kind: 'elevation', text: `${old.name} maximum elevation changed from ${oldEl.toFixed(0)}° to ${newEl.toFixed(0)}°.` });
    }
    if (m.a.status.state !== old.statusState) {
      changes.push({ kind: 'status', text: `${old.name} status changed: now "${m.a.status.label.toLowerCase()}".` });
    }
  }
  for (const c of evaluation.counted) {
    if (!matchedNow.has(c.passId)) {
      changes.push({ kind: 'added', text: `New opportunity: ${c.name}, peaking at ${c.fullMaxElevationDeg.toFixed(0)}°.` });
    }
  }
  return {
    evaluation,
    changes,
    lostEligibility,
    countNow: evaluation.counted.length,
    countBefore: saved.original.counted.length,
    meetsMinimum: evaluation.counted.length >= saved.criteria.minOpportunities,
  };
}

const hasBasics = (e: Partial<SavedEvent> | null): e is Partial<SavedEvent> =>
  !!e && typeof e.id === 'string' && !!e.window && Number.isFinite(e.window.start) && Number.isFinite(e.window.end) &&
  !!e.criteria && !!e.original && Array.isArray(e.original.counted) && !!e.location && typeof e.timeZone === 'string';

/** Validate untrusted JSON from localStorage before use. Only the current (schema 2) format is accepted. */
export function isSavedEvent(x: unknown): x is SavedEvent {
  const e = x as Partial<SavedEvent> | null;
  return hasBasics(e) && e.schema === SAVED_SCHEMA && typeof e.criteria!.maxSpanMin === 'number' &&
    (e.selectedNoradIds === undefined || (Array.isArray(e.selectedNoradIds) && e.selectedNoradIds.every((n) => Number.isInteger(n))));
}

/** An event saved under the earlier fixed-window model (schema 1). Recognised only so it can be left alone and counted. */
export function isLegacySavedEvent(x: unknown): boolean {
  const e = x as { schema?: unknown } | null;
  return !!e && typeof e === 'object' && e.schema === 1;
}
