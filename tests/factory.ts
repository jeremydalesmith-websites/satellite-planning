/** SYNTHETIC test builders (not real orbital data). */
import { ACTIVITIES } from '../src/catalog/catalog.ts';
import type { FmActivity } from '../src/catalog/catalog.ts';
import type { Interval, PassGeometry, SunSegment } from '../src/domain/types.ts';
import { assessPass } from '../src/eligibility/assess.ts';
import type { PassAssessment } from '../src/eligibility/assess.ts';
import { STATUS_LABELS } from '../src/eligibility/status.ts';
import type { OperationalStatus, StatusState } from '../src/eligibility/status.ts';

export const MIN = 60_000;
export const T0 = Date.UTC(2027, 0, 9, 15, 0, 0); // arbitrary fixed instant
export const at = (minutes: number) => T0 + minutes * MIN;
export const iv = (a: number, b: number): Interval => ({ start: at(a), end: at(b) });

export const activity = (noradId: number): FmActivity => ACTIVITIES.find((a) => a.noradId === noradId)!;
export const SO50 = 27607; // not sunlight-dependent
export const AO91 = 43017; // sunlight-dependent

export function status(state: StatusState, scheduleDependent = false): OperationalStatus {
  return {
    state, label: STATUS_LABELS[state], explanation: 'test', scheduleDependent,
    lastPositiveMs: null, lastNegativeMs: null, positives: 0, negatives: 0, windowHours: 72,
    dataDownloadedAt: null, countsTowardMinimum: state === 'recently-reported-active',
  };
}

export interface GeomOpts {
  norad?: number;
  /** minutes from T0 */
  rise: number; set: number; peak?: number; maxEl: number;
  /** above-threshold interval in minutes, or null */
  above?: [number, number] | null;
  thr?: number;
  /** sun segments [start, end, lit, maxEl] in minutes; default: one lit segment */
  sun?: Array<[number, number, boolean, number]>;
}

export function geom(o: GeomOpts): PassGeometry {
  const thr = o.thr ?? 40;
  const peak: number = o.peak ?? (o.rise + o.set) / 2;
  const above: [number, number] | null = o.above === undefined ? [peak - 1, peak + 1] : o.above;
  const sun: SunSegment[] = (o.sun ?? [[o.rise, o.set, true, o.maxEl]]).map(([s, e, lit, m]) => ({
    start: at(s), end: at(e), lit, maxElevationDeg: m,
  }));
  return {
    id: `${o.norad ?? SO50}:${o.rise}`, noradId: o.norad ?? SO50,
    riseMs: at(o.rise), peakMs: at(peak), setMs: at(o.set), maxElevationDeg: o.maxEl,
    riseAzDeg: 10, peakAzDeg: 90, setAzDeg: 200,
    aboveThreshold: { [String(thr)]: above ? iv(above[0], above[1]) : null },
    sunSegments: sun,
  };
}

export function assessed(o: GeomOpts, st: StatusState = 'recently-reported-active', sched = false): PassAssessment {
  return assessPass(geom(o), activity(o.norad ?? SO50), status(st, sched), o.thr ?? 40);
}
