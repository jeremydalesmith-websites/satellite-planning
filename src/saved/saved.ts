/**
 * Saved events: a FIXED event window plus a snapshot of why it was chosen.
 *
 * When data refreshes, `recheckEvent` re-evaluates the SAME window with the
 * SAME criteria against newly computed passes and reports what changed. It
 * never moves, resizes or deletes the event: the gathering is a human
 * commitment, so only the evidence is recomputed.
 */
import { SAVED_ELEVATION_REPORT_DEG, SAVED_MATCH_TOLERANCE_MIN, SAVED_SHIFT_REPORT_SEC } from '../domain/policy.ts';
import type { Criteria, Interval, Ms } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import type { StatusState } from '../eligibility/status.ts';
import { evaluateWindow } from '../cluster/cluster.ts';
import type { EventWindow, WindowEvaluation } from '../cluster/cluster.ts';
import type { PredictionMeta } from '../planner.ts';

export interface SavedOpportunity {
  noradId: number;
  name: string;
  riseMs: Ms;
  peakMs: Ms;
  setMs: Ms;
  operating: Interval;
  fullMaxElevationDeg: number;
  eligibleMaxElevationDeg: number | null;
  statusState: StatusState;
}

export interface SavedEvent {
  schema: 1;
  id: string;
  savedAtMs: Ms;
  window: Interval;
  location: { latDeg: number; lonDeg: number };
  timeZone: string;
  criteria: Criteria;
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
    operating: { ...a.operating! },
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
): SavedEvent {
  return {
    schema: 1,
    id,
    savedAtMs: nowMs,
    window: { ...w.window },
    location: { ...location },
    timeZone,
    criteria: { ...criteria },
    original: {
      counted: w.counted.map(toSaved),
      distinctSatellites: w.distinctSatellites,
      totalOperatingMs: w.totalOperatingMs,
      meta,
    },
  };
}

export type ChangeKind = 'lost' | 'added' | 'shifted' | 'elevation' | 'status';

export interface Change {
  kind: ChangeKind;
  /** Plain-language description of one meaningful change. */
  text: string;
}

export interface Recheck {
  evaluation: WindowEvaluation;
  changes: Change[];
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
  const evaluation = evaluateWindow(saved.window, assessments);
  const tolerance = SAVED_MATCH_TOLERANCE_MIN * 60_000;
  const universe: Array<{ a: PassAssessment; where: 'counted' | 'alternative' | 'conditional' | 'edge' | 'excluded' }> = [
    ...evaluation.counted.map((a) => ({ a, where: 'counted' as const })),
    ...evaluation.alternatives.map((a) => ({ a, where: 'alternative' as const })),
    ...evaluation.conditional.map((a) => ({ a, where: 'conditional' as const })),
    ...evaluation.edge.map((a) => ({ a, where: 'edge' as const })),
    ...evaluation.excluded.map((a) => ({ a, where: 'excluded' as const })),
  ];
  const changes: Change[] = [];
  const matchedNow = new Set<string>();

  for (const old of saved.original.counted) {
    const m = universe.find((u) => u.a.noradId === old.noradId && Math.abs(u.a.peakMs - old.peakMs) <= tolerance && !matchedNow.has(u.a.passId));
    if (!m) {
      changes.push({ kind: 'lost', text: `${old.name} pass no longer appears: it no longer reaches ${saved.criteria.minElevationDeg}° within this event.` });
      continue;
    }
    matchedNow.add(m.a.passId);
    if (m.where !== 'counted') {
      const why: Record<string, string> = {
        alternative: 'it now overlaps another counted pass',
        conditional: `its repeater status is now unconfirmed (${m.a.status.label.toLowerCase()})`,
        edge: 'its usable part now extends past the event start or end',
        excluded: m.a.reasons[0] ?? 'it is no longer usable',
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
    countNow: evaluation.counted.length,
    countBefore: saved.original.counted.length,
    meetsMinimum: evaluation.counted.length >= saved.criteria.minOpportunities,
  };
}

/** Validate untrusted JSON from localStorage before use. */
export function isSavedEvent(x: unknown): x is SavedEvent {
  const e = x as Partial<SavedEvent> | null;
  return !!e && e.schema === 1 && typeof e.id === 'string' && !!e.window && Number.isFinite(e.window.start) &&
    Number.isFinite(e.window.end) && !!e.criteria && !!e.original && Array.isArray(e.original.counted) &&
    !!e.location && typeof e.timeZone === 'string';
}
