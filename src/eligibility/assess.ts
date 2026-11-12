/**
 * Operational eligibility and sunlight for ONE pass.
 *
 * Definitions (see README "How passes are counted"):
 *  - "Time above the selected elevation": when elevation >= the user's threshold.
 *  - "Eligible portion": for sunlight-dependent repeaters, only the sunlit parts;
 *    otherwise the whole pass.
 *  - "Operating interval" (what the planner schedules): the longest contiguous
 *    stretch that is BOTH above the threshold AND in the eligible portion.
 *    A pass qualifies only if such an interval exists, i.e. the threshold is
 *    reached during an operationally eligible portion.
 *
 * Local darkness is irrelevant here: only sunlight AT THE SATELLITE matters.
 */
import type { FmActivity } from '../catalog/catalog.ts';
import { duration, intersect } from '../domain/intervals.ts';
import type { Interval, Ms, PassGeometry } from '../domain/types.ts';
import { exclusionReason } from './status.ts';
import type { OperationalStatus } from './status.ts';

export type Verdict = 'eligible' | 'excluded';
/** 'status' = the repeater lacks a qualifying recent FM report; such passes never appear in results. */
export type ExclusionReason = 'below-threshold' | 'eclipse' | 'status' | null;
export type SunlightState = 'illuminated' | 'partly-eclipsed' | 'eclipsed';

export interface PassAssessment {
  passId: string;
  noradId: number;
  activityId: string;
  name: string;
  riseMs: Ms;
  peakMs: Ms;
  setMs: Ms;
  riseAzDeg: number;
  setAzDeg: number;
  /** Maximum elevation of the whole pass. */
  fullMaxElevationDeg: number;
  /** Maximum elevation within the eligible portion (differs for eclipse-limited passes). */
  eligibleMaxElevationDeg: number | null;
  /** Time the pass spends at or above the user's threshold (ignores eclipse). */
  aboveThreshold: Interval | null;
  /** The interval the planner schedules; null if the pass does not qualify. */
  operating: Interval | null;
  sunlightRestricted: boolean;
  /** Sunlight at the satellite over the whole pass. */
  sunlight: SunlightState;
  /** Milliseconds of the pass spent in Earth's shadow (or penumbra). */
  shadowMs: number;
  status: OperationalStatus;
  verdict: Verdict;
  exclusion: ExclusionReason;
  /** Plain-language reasons; first one is the headline. */
  reasons: string[];
  thresholdDeg: number;
}

function sunlightOf(pass: PassGeometry): { state: SunlightState; shadowMs: number } {
  const shadowMs = pass.sunSegments.filter((s) => !s.lit).reduce((a, s) => a + duration(s), 0);
  const litMs = pass.sunSegments.filter((s) => s.lit).reduce((a, s) => a + duration(s), 0);
  return {
    shadowMs,
    state: shadowMs === 0 ? 'illuminated' : litMs === 0 ? 'eclipsed' : 'partly-eclipsed',
  };
}

export function assessPass(
  pass: PassGeometry,
  activity: FmActivity,
  status: OperationalStatus,
  thresholdDeg: number,
): PassAssessment {
  const above = pass.aboveThreshold[String(thresholdDeg)] ?? null;
  const { state: sunlight, shadowMs } = sunlightOf(pass);
  const restricted = activity.sunlightRequired;
  const litSegs = pass.sunSegments.filter((s) => s.lit);

  // Operating pieces: above-threshold ∩ eligible portion.
  let pieces: Interval[] = [];
  if (above) {
    pieces = restricted
      ? litSegs.map((s) => intersect(above, s)).filter((x): x is Interval => x !== null)
      : [above];
  }
  const operating = pieces.length ? pieces.reduce((a, b) => (duration(b) > duration(a) ? b : a)) : null;
  const eligibleMax = restricted
    ? litSegs.length
      ? Math.max(...litSegs.map((s) => s.maxElevationDeg))
      : null
    : pass.maxElevationDeg;

  const reasons: string[] = [];
  let exclusion: ExclusionReason = null;
  let verdict: Verdict;

  if (status.state !== 'recently-reported-active') {
    exclusion = 'status';
    verdict = 'excluded';
    reasons.push(`${activity.name}: ${exclusionReason(status) ?? 'no qualifying FM report'}.`);
  } else if (!above) {
    exclusion = 'below-threshold';
    verdict = 'excluded';
    reasons.push(`Peaks at ${pass.maxElevationDeg.toFixed(0)}°, below the ${thresholdDeg}° minimum.`);
  } else if (!operating) {
    exclusion = 'eclipse';
    verdict = 'excluded';
    reasons.push(
      sunlight === 'eclipsed'
        ? 'The satellite is in Earth’s shadow for the whole pass, and this repeater should not be used in eclipse.'
        : `The part of the pass above ${thresholdDeg}° is in Earth’s shadow, and this repeater should not be used in eclipse.`,
    );
  } else {
    verdict = 'eligible';
    reasons.push('Counts toward the event minimum.');
  }

  if (restricted && operating && sunlight === 'partly-eclipsed') {
    reasons.push(
      `Part of this pass is in Earth’s shadow; only the sunlit part (${Math.round(duration(operating) / 1000)} s above ${thresholdDeg}°) is used.`,
    );
  }

  return {
    passId: pass.id,
    noradId: pass.noradId,
    activityId: activity.activityId,
    name: activity.name,
    riseMs: pass.riseMs,
    peakMs: pass.peakMs,
    setMs: pass.setMs,
    riseAzDeg: pass.riseAzDeg,
    setAzDeg: pass.setAzDeg,
    fullMaxElevationDeg: pass.maxElevationDeg,
    eligibleMaxElevationDeg: above ? eligibleMax : null,
    aboveThreshold: above,
    operating,
    sunlightRestricted: restricted,
    sunlight,
    shadowMs,
    status,
    verdict,
    exclusion,
    reasons,
    thresholdDeg,
  };
}
