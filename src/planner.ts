/**
 * Orchestration of the planning pipeline (pure functions; no DOM, no worker).
 *
 *   elements ──► [orbit/predict] ──► passes (geometry)
 *   status   ──► [eligibility/status] ─┐
 *   catalog  ───────────────────────────┴► [eligibility/assess] ──► assessments
 *   availability settings ──► [availability] ──► intervals ─┐
 *   assessments + intervals ──► [cluster] ──► ranked event windows
 *
 * The prediction step runs in a Web Worker in the browser (see orbit/client.ts),
 * so this module takes its result as an argument.
 */
import { ACTIVITIES } from './catalog/catalog.ts';
import type { FmActivity } from './catalog/catalog.ts';
import type { ElementsFile, StatusFile } from './data/ingest.ts';
import { EVENT_DURATIONS_MIN, MAX_ELEMENT_AGE_DAYS, MIN_ELEVATION_INPUT_DEG } from './domain/policy.ts';
import type { Criteria, ElementSet, Interval, Ms, Observer, PassGeometry } from './domain/types.ts';
import { expandAvailability } from './availability/availability.ts';
import type { AvailabilitySettings } from './availability/availability.ts';
import { assessPass } from './eligibility/assess.ts';
import type { PassAssessment } from './eligibility/assess.ts';
import { classifyStatus } from './eligibility/status.ts';
import type { OperationalStatus } from './eligibility/status.ts';
import { findEventWindows } from './cluster/cluster.ts';
import type { EventWindow } from './cluster/cluster.ts';

export interface LoadedData {
  elements: ElementsFile;
  /** null when no status data could be loaded: every repeater is then "unknown". */
  status: StatusFile | null;
}

export interface SkippedSatellite {
  noradId: number;
  name: string;
  reason: string;
}

/** Drop element sets that are too old to trust; say why. Never substitutes data. */
export function usableElements(
  elements: ElementsFile,
  nowMs: Ms,
  activities: readonly FmActivity[] = ACTIVITIES,
): { usable: ElementSet[]; skipped: SkippedSatellite[] } {
  const usable: ElementSet[] = [];
  const skipped: SkippedSatellite[] = [];
  const have = new Set(elements.sets.map((s) => s.noradId));
  for (const a of activities) {
    if (!have.has(a.noradId)) skipped.push({ noradId: a.noradId, name: a.name, reason: 'No orbital data was available for this satellite.' });
  }
  for (const s of elements.sets) {
    const act = activities.find((a) => a.noradId === s.noradId);
    if (!act) continue;
    const ageDays = (nowMs - s.epochMs) / 86_400_000;
    if (ageDays > MAX_ELEMENT_AGE_DAYS) {
      skipped.push({
        noradId: s.noradId,
        name: act.name,
        reason: `Orbital data is ${Math.round(ageDays)} days old (limit ${MAX_ELEMENT_AGE_DAYS}), so predictions would not be trustworthy.`,
      });
    } else usable.push(s);
  }
  return { usable, skipped };
}

export function statusMap(
  data: LoadedData,
  nowMs: Ms,
  activities: readonly FmActivity[] = ACTIVITIES,
): Map<number, OperationalStatus> {
  return new Map(activities.map((a) => [a.noradId, classifyStatus(a, data.status, nowMs)]));
}

export function assessAll(
  passes: readonly PassGeometry[],
  statuses: ReadonlyMap<number, OperationalStatus>,
  thresholdDeg: number,
  activities: readonly FmActivity[] = ACTIVITIES,
): PassAssessment[] {
  const out: PassAssessment[] = [];
  for (const p of passes) {
    const act = activities.find((a) => a.noradId === p.noradId);
    const st = statuses.get(p.noradId);
    if (!act || !st) continue;
    out.push(assessPass(p, act, st, thresholdDeg));
  }
  return out;
}

export interface PredictionMeta {
  /** When this result was calculated in the browser. */
  generatedAtMs: Ms;
  /** When the refresh job downloaded the orbital elements. */
  elementsDownloadedAt: string;
  /** When the refresh job downloaded status reports; null if unavailable. */
  statusDownloadedAt: string | null;
  /** Epoch of each satellite's elements. */
  epochs: Record<number, Ms>;
}

export interface Suggestion {
  kind: 'lower-elevation' | 'fewer-opportunities' | 'count-conditional' | 'longer-event' | 'more-availability';
  text: string;
  windows: number;
}

export interface Diagnosis {
  availabilityBlocks: number;
  blocksLongEnough: number;
  eligiblePasses: number;
  conditionalPasses: number;
  suggestions: Suggestion[];
}

export interface PlanInputs {
  observer: Observer;
  timeZone: string;
  criteria: Criteria;
  availability: AvailabilitySettings;
  range: Interval;
}

export interface PlanResult {
  windows: EventWindow[];
  assessments: PassAssessment[];
  availabilityIntervals: Interval[];
  skipped: SkippedSatellite[];
  predictionErrors: Array<{ noradId: number; message: string }>;
  diagnosis: Diagnosis | null;
  meta: PredictionMeta;
}

/** Thresholds the predictor should compute so diagnosis can test a lower elevation without re-running. */
export function predictionThresholds(minElevationDeg: number): number[] {
  const lower = Math.max(MIN_ELEVATION_INPUT_DEG, minElevationDeg - 10);
  return lower < minElevationDeg ? [minElevationDeg, lower] : [minElevationDeg];
}

export function computePlan(
  inputs: PlanInputs,
  data: LoadedData,
  passes: readonly PassGeometry[],
  predictionErrors: Array<{ noradId: number; message: string }>,
  skipped: SkippedSatellite[],
  nowMs: Ms,
  generatedAtMs: Ms = nowMs,
): PlanResult {
  const { criteria } = inputs;
  const statuses = statusMap(data, nowMs);
  const assessments = assessAll(passes, statuses, criteria.minElevationDeg);
  const availabilityIntervals = expandAvailability(inputs.availability, inputs.timeZone, inputs.range);
  const windows = findEventWindows(assessments, availabilityIntervals, criteria);
  const diagnosis =
    windows.length === 0
      ? diagnose(inputs, passes, statuses, assessments, availabilityIntervals)
      : null;
  return {
    windows,
    assessments,
    availabilityIntervals,
    skipped,
    predictionErrors,
    diagnosis,
    meta: {
      generatedAtMs,
      elementsDownloadedAt: data.elements.downloadedAt,
      statusDownloadedAt: data.status?.downloadedAt ?? null,
      epochs: Object.fromEntries(data.elements.sets.map((s) => [s.noradId, s.epochMs])),
    },
  };
}

/**
 * Explain an empty result and suggest which input could be relaxed.
 * Suggestions are only ever TEXT: nothing is applied automatically
 * (no silent lowering of elevation, no added hours, no counting conditionals).
 */
export function diagnose(
  inputs: PlanInputs,
  passes: readonly PassGeometry[],
  statuses: ReadonlyMap<number, OperationalStatus>,
  assessments: readonly PassAssessment[],
  blocks: readonly Interval[],
): Diagnosis {
  const { criteria } = inputs;
  const D = criteria.durationMin * 60_000;
  const suggestions: Suggestion[] = [];
  const count = (as: readonly PassAssessment[], av: readonly Interval[], dur: number, min: number) =>
    findEventWindows(as, av, { durationMin: dur / 60_000, minOpportunities: min }).length;

  if (criteria.minOpportunities > 2) {
    const n = count(assessments, blocks, D, criteria.minOpportunities - 1);
    if (n > 0) suggestions.push({ kind: 'fewer-opportunities', windows: n, text: `Requiring ${criteria.minOpportunities - 1} opportunities instead of ${criteria.minOpportunities} would give ${n} window${n === 1 ? '' : 's'}.` });
  }
  const asConditional = assessments.map((a) => (a.verdict === 'conditional' ? { ...a, verdict: 'eligible' as const } : a));
  const nCond = count(asConditional, blocks, D, criteria.minOpportunities);
  if (nCond > 0) suggestions.push({ kind: 'count-conditional', windows: nCond, text: `${nCond} window${nCond === 1 ? '' : 's'} would qualify if passes with unconfirmed repeater status were counted, but their operation is not established, so they are shown as conditional only.` });

  const lower = Math.max(MIN_ELEVATION_INPUT_DEG, criteria.minElevationDeg - 10);
  if (lower < criteria.minElevationDeg) {
    const lowAs = assessAll(passes, statuses, lower);
    const n = count(lowAs, blocks, D, criteria.minOpportunities);
    if (n > 0) suggestions.push({ kind: 'lower-elevation', windows: n, text: `Lowering the minimum elevation to ${lower}° would give ${n} window${n === 1 ? '' : 's'}.` });
  }
  const longest = Math.max(...EVENT_DURATIONS_MIN);
  if (criteria.durationMin < longest) {
    const n = count(assessments, blocks, longest * 60_000, criteria.minOpportunities);
    if (n > 0) suggestions.push({ kind: 'longer-event', windows: n, text: `A ${longest / 60}-hour event would give ${n} window${n === 1 ? '' : 's'}.` });
  }
  const everything: Interval[] = [inputs.range];
  const nAll = count(assessments, everything, D, criteria.minOpportunities);
  if (nAll > 0) suggestions.push({ kind: 'more-availability', windows: nAll, text: `The passes exist (${nAll} window${nAll === 1 ? '' : 's'} at some hour), but not inside your selected availability. Adding more days or periods would help.` });

  return {
    availabilityBlocks: blocks.length,
    blocksLongEnough: blocks.filter((b) => b.end - b.start >= D).length,
    eligiblePasses: assessments.filter((a) => a.verdict === 'eligible').length,
    conditionalPasses: assessments.filter((a) => a.verdict === 'conditional').length,
    suggestions,
  };
}
