/**
 * Operational eligibility and sunlight for ONE pass.
 *
 * Definitions (see README "How passes are counted"):
 *  - "Full pass" / "envelope": the whole stretch from AOS (rise) to LOS (set) above the 0° geometric horizon.
 *    It is what the planner uses for cluster bounds, availability fit and the one-station overlap rule.
 *  - Minimum elevation SELECTS a pass by its MAXIMUM elevation. It does not define the operable time.
 *    For a sunlight-dependent repeater the elevation must be reached DURING A SUNLIT PORTION: a high peak
 *    while the repeater may not be used does not qualify the pass.
 *  - "Operating intervals": the parts of the full pass in which operation is permitted. The whole pass for
 *    an unrestricted repeater; the sunlit portions for a sunlight-dependent one. Eclipsed time is never
 *    part of anything labelled operating time.
 *  - "Time above the selected elevation": informational only (shown in Details); it selects and schedules nothing.
 *
 * Local darkness is irrelevant here: only sunlight AT THE SATELLITE matters.
 */
import type { FmActivity } from '../catalog/catalog.ts';
import { duration } from '../domain/intervals.ts';
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
  /** Highest elevation reached while operation is permitted (differs for sunlight-limited passes); null if none. */
  eligibleMaxElevationDeg: number | null;
  /** Informational: when elevation is at or above the selected minimum (shown in Details; used for nothing else). */
  aboveThreshold: Interval | null;
  /** The full pass, AOS to LOS. */
  envelope: Interval;
  /** Parts of the full pass in which operation is permitted (no eclipsed time). Empty if the pass does not qualify. */
  operatingIntervals: Interval[];
  /** Total permitted operating time within the pass, ms. */
  operatingMs: number;
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
  const { state: sunlight, shadowMs } = sunlightOf(pass);
  const restricted = activity.sunlightRequired;
  const litSegs = pass.sunSegments.filter((s) => s.lit);
  const envelope: Interval = { start: pass.riseMs, end: pass.setMs };

  // Selection by MAXIMUM elevation; a sunlight-dependent repeater must reach it during a sunlit portion.
  const peakReached = pass.maxElevationDeg >= thresholdDeg;
  const reachedWhileSunlit = restricted ? litSegs.some((s) => s.maxElevationDeg >= thresholdDeg) : peakReached;
  const eligibleMax = restricted
    ? litSegs.length ? Math.max(...litSegs.map((s) => s.maxElevationDeg)) : null
    : pass.maxElevationDeg;

  const reasons: string[] = [];
  let exclusion: ExclusionReason = null;
  let verdict: Verdict;

  if (status.state !== 'recently-reported-active') {
    exclusion = 'status';
    verdict = 'excluded';
    reasons.push(`${activity.name}: ${exclusionReason(status) ?? 'no qualifying FM report'}.`);
  } else if (!peakReached) {
    exclusion = 'below-threshold';
    verdict = 'excluded';
    reasons.push(`Peaks at ${pass.maxElevationDeg.toFixed(0)}°, below the ${thresholdDeg}° minimum.`);
  } else if (!reachedWhileSunlit) {
    exclusion = 'eclipse';
    verdict = 'excluded';
    reasons.push(
      sunlight === 'eclipsed'
        ? 'The satellite is in Earth’s shadow for the whole pass, and this repeater should not be used in eclipse.'
        : `The pass reaches ${thresholdDeg}° only while the satellite is in Earth’s shadow, where this repeater should not be used.`,
    );
  } else {
    verdict = 'eligible';
    reasons.push('Counts toward the minimum.');
  }

  // Permitted operating intervals: the whole pass, or only its sunlit portions. Only for a qualifying pass.
  const operatingIntervals: Interval[] =
    verdict !== 'eligible' ? [] : restricted ? litSegs.map((s) => ({ start: s.start, end: s.end })) : [envelope];
  const operatingMs = operatingIntervals.reduce((t, i) => t + duration(i), 0);

  if (restricted && verdict === 'eligible' && sunlight === 'partly-eclipsed') {
    reasons.push(`Part of this pass is in Earth’s shadow; only the sunlit part (${Math.round(operatingMs / 1000)} s) is permitted operating time.`);
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
    eligibleMaxElevationDeg: peakReached ? eligibleMax : null,
    aboveThreshold: pass.aboveThreshold[String(thresholdDeg)] ?? null,
    envelope,
    operatingIntervals,
    operatingMs,
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
