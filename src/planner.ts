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
import { consideredIds, evaluateEligibility } from './eligibility/eligibility.ts';
import type { SatelliteEligibility } from './eligibility/eligibility.ts';
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
  /**
   * The single current-time snapshot against which the 72-hour eligibility rule was evaluated.
   * Existing reports were re-checked against this time; NO new reports were downloaded then.
   */
  eligibilityCheckedAtMs?: Ms;
  /** Epoch of each satellite's elements. */
  epochs: Record<number, Ms>;
}

export interface Suggestion {
  kind: 'lower-elevation' | 'fewer-opportunities' | 'longer-span' | 'more-availability';
  text: string;
  windows: number;
}

export interface Diagnosis {
  availabilityBlocks: number;
  /** Availability blocks that can hold at least one qualifying pass from AOS to LOS. */
  blocksHoldingAPass: number;
  eligiblePasses: number;
  suggestions: Suggestion[];
}

export interface PlanInputs {
  observer: Observer;
  timeZone: string;
  criteria: Criteria;
  availability: AvailabilitySettings;
  range: Interval;
  /**
   * The user's selected satellites (NORAD IDs). Eligibility is applied on top: a selected but
   * currently ineligible satellite is excluded here without altering the stored selection.
   * undefined = the defaults (ISS, SO-50, AO-91).
   */
  selectedNoradIds?: readonly number[];
}

export interface PlanResult {
  /** Eligibility of every catalog repeater at this search's single time snapshot. */
  eligibility: SatelliteEligibility[];
  /** Satellites that were both eligible and selected, i.e. the only ones that can appear below. */
  consideredNoradIds: number[];
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
  // ONE time snapshot (nowMs) for the whole search: eligibility, element age and metadata.
  const eligibility = evaluateEligibility(data.status, nowMs);
  const considered = consideredIds(eligibility, inputs.selectedNoradIds);
  const statuses = new Map(eligibility.map((e) => [e.noradId, e.status]));
  // Defence in depth: only eligible AND selected satellites ever reach assessment.
  const planned = passes.filter((p) => considered.has(p.noradId));
  const assessments = assessAll(planned, statuses, criteria.minElevationDeg);
  const availabilityIntervals = expandAvailability(inputs.availability, inputs.timeZone, inputs.range);
  const windows = findEventWindows(assessments, availabilityIntervals, criteria);
  const diagnosis =
    windows.length === 0
      ? diagnose(inputs, planned, statuses, assessments, availabilityIntervals)
      : null;
  return {
    eligibility,
    consideredNoradIds: [...considered],
    windows,
    assessments,
    availabilityIntervals,
    skipped: skipped.filter((s) => considered.has(s.noradId)),
    predictionErrors: predictionErrors.filter((e) => considered.has(e.noradId)),
    diagnosis,
    meta: {
      generatedAtMs,
      eligibilityCheckedAtMs: nowMs,
      elementsDownloadedAt: data.elements.downloadedAt,
      statusDownloadedAt: data.status?.downloadedAt ?? null,
      epochs: Object.fromEntries(data.elements.sets.map((s) => [s.noradId, s.epochMs])),
    },
  };
}

/**
 * Explain an empty result and suggest which input could be relaxed.
 * Suggestions are only ever TEXT: nothing is applied automatically
 * (no silent lowering of elevation, no added hours, no counting unconfirmed satellites).
 */
export function diagnose(
  inputs: PlanInputs,
  passes: readonly PassGeometry[],
  statuses: ReadonlyMap<number, OperationalStatus>,
  assessments: readonly PassAssessment[],
  blocks: readonly Interval[],
): Diagnosis {
  const { criteria } = inputs;
  const suggestions: Suggestion[] = [];
  const count = (as: readonly PassAssessment[], av: readonly Interval[], spanMin: number, min: number) =>
    findEventWindows(as, av, { maxSpanMin: spanMin, minOpportunities: min }).length;
  const eligible = assessments.filter((a) => a.verdict === 'eligible');

  if (criteria.minOpportunities > 2) {
    const n = count(assessments, blocks, criteria.maxSpanMin, criteria.minOpportunities - 1);
    if (n > 0) suggestions.push({ kind: 'fewer-opportunities', windows: n, text: `Requiring ${criteria.minOpportunities - 1} passes instead of ${criteria.minOpportunities} would give ${n} cluster${n === 1 ? '' : 's'}.` });
  }
  const lower = Math.max(MIN_ELEVATION_INPUT_DEG, criteria.minElevationDeg - 10);
  if (lower < criteria.minElevationDeg) {
    const lowAs = assessAll(passes, statuses, lower);
    const n = count(lowAs, blocks, criteria.maxSpanMin, criteria.minOpportunities);
    if (n > 0) suggestions.push({ kind: 'lower-elevation', windows: n, text: `Lowering the minimum peak elevation to ${lower}° would give ${n} cluster${n === 1 ? '' : 's'}.` });
  }
  const longest = Math.max(...EVENT_DURATIONS_MIN);
  if (criteria.maxSpanMin < longest) {
    const n = count(assessments, blocks, longest, criteria.minOpportunities);
    if (n > 0) suggestions.push({ kind: 'longer-span', windows: n, text: `A ${longest / 60}-hour maximum cluster span would give ${n} cluster${n === 1 ? '' : 's'}.` });
  }
  const everything: Interval[] = [inputs.range];
  const nAll = count(assessments, everything, criteria.maxSpanMin, criteria.minOpportunities);
  if (nAll > 0) suggestions.push({ kind: 'more-availability', windows: nAll, text: `The passes exist (${nAll} cluster${nAll === 1 ? '' : 's'} at some hour), but not entirely inside your selected availability. Adding more days or periods would help.` });

  return {
    availabilityBlocks: blocks.length,
    blocksHoldingAPass: blocks.filter((b) => eligible.some((a) => a.riseMs >= b.start && a.setMs <= b.end)).length,
    eligiblePasses: eligible.length,
    suggestions,
  };
}
