/**
 * Orbital pass prediction (geometry only, no operational judgement).
 *
 * All orbital mechanics come from satellite.js: SGP4 propagation (`propagate`),
 * sidereal time (`gstime`), frame transform (`eciToEcf`), look angles
 * (`ecfToLookAngles`), Sun position (`sunPos`) and Earth-shadow fraction
 * (`shadowFraction`). This file only decides WHERE to sample and refines
 * crossings with bisection / golden-section search.
 *
 * Search strategy
 *  1. Outside a pass, step ahead by a *provably safe* amount: the satellite's
 *     central angle to the observer must shrink to the horizon cone before a
 *     pass can start, and it cannot close faster than its maximum angular rate
 *     (mean motion, inflated for eccentricity, plus Earth rotation). So we can
 *     leap many minutes without risking a missed pass, instead of sampling
 *     blindly every few seconds for 42 days.
 *  2. Inside a pass, sample every 20 s.
 *  3. Rise/set, the peak, threshold crossings and eclipse boundaries are all
 *     refined to ~50 ms by bisection or golden-section search.
 */
import {
  constants,
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  geodeticToEcf,
  gstime,
  jday,
  propagate,
  radiansToDegrees,
  shadowFraction,
  sunPos,
  twoline2satrec,
} from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { PASS_HORIZON_DEG, SUNLIT_SHADOW_FRACTION_BELOW } from '../domain/policy.ts';
import type { ElementSet, Interval, Ms, Observer, PassGeometry, SunSegment } from '../domain/types.ts';

const IN_PASS_STEP_MS = 20_000;
const MIN_SKIP_MS = 5_000;
const MAX_SKIP_MS = 1_500_000;
const SUN_STEP_MS = 5_000;
const TOL_MS = 50;
const MAX_PASS_MS = 45 * 60_000;
const EARTH_ROT_RAD_S = 7.292115e-5;
const MU_KM3_S2 = constants.mu;

interface Sample {
  elDeg: number;
  azDeg: number;
  /** Central angle between observer and satellite (rad), from the law of cosines. */
  theta: number;
}

export class SatTracker {
  readonly satrec: SatRec;
  private readonly obsGd;
  private readonly obsRadiusKm: number;
  /** Conservative max angular rate of the sub-satellite point seen from the observer (rad/s). */
  readonly maxRateRadS: number;
  /** Largest possible horizon-cone half-angle (rad): computed at the orbit's apogee radius. */
  readonly horizonConeRad: number;

  readonly element: ElementSet;

  constructor(element: ElementSet, observer: Observer) {
    this.element = element;
    this.satrec = twoline2satrec(element.line1, element.line2);
    this.obsGd = {
      latitude: degreesToRadians(observer.latDeg),
      longitude: degreesToRadians(observer.lonDeg),
      height: observer.heightKm,
    };
    const o = geodeticToEcf(this.obsGd);
    this.obsRadiusKm = Math.hypot(o.x, o.y, o.z);
    const n = this.satrec.no / 60; // rad/min -> rad/s
    const e = this.satrec.ecco;
    // Angular rate at perigee relative to mean motion: (1+e)^2 / (1-e^2)^1.5
    const ecc = Math.pow(1 + e, 2) / Math.pow(1 - e * e, 1.5);
    this.maxRateRadS = n * ecc * 1.1 + EARTH_ROT_RAD_S;
    // Semi-major axis from mean motion (Kepler's third law, satellite.js's own mu constant).
    const aKm = Math.cbrt(MU_KM3_S2 / (n * n));
    const apogeeKm = Math.max(aKm * (1 + e), this.obsRadiusKm + 1);
    this.horizonConeRad = Math.acos(Math.min(1, this.obsRadiusKm / apogeeKm));
  }

  /** Look angles at time t, or null if SGP4 reports an error (e.g. decayed). */
  sample(t: Ms): Sample | null {
    const date = new Date(t);
    const pv = propagate(this.satrec, date);
    if (!pv) return null;
    const ecf = eciToEcf(pv.position, gstime(date));
    const look = ecfToLookAngles(this.obsGd, ecf);
    const r = Math.hypot(ecf.x, ecf.y, ecf.z);
    const R = this.obsRadiusKm;
    const cos = (R * R + r * r - look.rangeSat * look.rangeSat) / (2 * R * r);
    return {
      elDeg: radiansToDegrees(look.elevation),
      azDeg: (radiansToDegrees(look.azimuth) + 360) % 360,
      theta: Math.acos(Math.min(1, Math.max(-1, cos))),
    };
  }

  elevationAt(t: Ms): number {
    return this.sample(t)?.elDeg ?? -90;
  }

  /** Is the satellite fully in sunlight at time t? Uses satellite.js sunPos + shadowFraction. */
  isSunlit(t: Ms): boolean {
    const date = new Date(t);
    const pv = propagate(this.satrec, date);
    if (!pv) return true;
    const { rsun } = sunPos(jday(date));
    return shadowFraction(rsun, pv.position) < SUNLIT_SHADOW_FRACTION_BELOW;
  }

  /** Safe time to skip ahead while the satellite is below the horizon cone. */
  skipMs(theta: number): number {
    const ms = (0.85 * (theta - this.horizonConeRad) / this.maxRateRadS) * 1000;
    return Math.min(MAX_SKIP_MS, Math.max(MIN_SKIP_MS, ms));
  }
}

/** Time at which `pred` flips, given pred(a) !== pred(b). */
export function findCrossing(pred: (t: Ms) => boolean, a: Ms, b: Ms, tolMs = TOL_MS): Ms {
  const pa = pred(a);
  let lo = a;
  let hi = b;
  while (hi - lo > tolMs) {
    const mid = lo + (hi - lo) / 2;
    if (pred(mid) === pa) lo = mid;
    else hi = mid;
  }
  return lo + (hi - lo) / 2;
}

/** Golden-section search for the time of maximum of a unimodal f on [a, b]. */
export function goldenMax(f: (t: Ms) => number, a: Ms, b: Ms, tolMs = TOL_MS): Ms {
  const phi = (Math.sqrt(5) - 1) / 2;
  let lo = a;
  let hi = b;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = f(c);
  let fd = f(d);
  while (hi - lo > tolMs) {
    if (fc > fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = f(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = f(d);
    }
  }
  return lo + (hi - lo) / 2;
}

export interface PredictOptions {
  /** Thresholds (deg) to compute above-threshold intervals for. Passes below the lowest are dropped. */
  thresholdsDeg: number[];
}

/** Find all passes overlapping [startMs, endMs] whose maximum elevation reaches the lowest threshold. */
export function findPasses(
  element: ElementSet,
  observer: Observer,
  startMs: Ms,
  endMs: Ms,
  opts: PredictOptions,
): PassGeometry[] {
  const tracker = new SatTracker(element, observer);
  const floor = Math.min(...opts.thresholdsDeg);
  const horizon = PASS_HORIZON_DEG;
  const passes: PassGeometry[] = [];
  const up = (t: Ms) => tracker.elevationAt(t) > horizon;

  let t = startMs;
  let prevT: Ms | null = null; // last sample known to be below the horizon
  let first = true;

  while (t < endMs) {
    const s = tracker.sample(t);
    if (!s) {
      // Propagation failure: do not guess. Move on; caller reports satellites yielding nothing.
      prevT = null;
      t += 60_000;
      first = false;
      continue;
    }
    if (s.elDeg <= horizon) {
      prevT = t;
      t += tracker.skipMs(s.theta);
      first = false;
      continue;
    }

    // ---- Inside a pass at time t. Find the rise.
    let rise: Ms;
    if (first || prevT === null) {
      // Already up at the start of the range: walk backwards to the true rise.
      let back = t;
      while (up(back) && t - back < MAX_PASS_MS) back -= IN_PASS_STEP_MS;
      rise = findCrossing(up, back, back + IN_PASS_STEP_MS);
    } else {
      rise = findCrossing(up, prevT, t);
    }

    // ---- Walk forward to the set, remembering the best sample for the peak bracket.
    const samples: Array<{ t: Ms; el: number }> = [{ t: rise, el: horizon }];
    let cur = Math.max(t, rise);
    let lastUp = cur;
    samples.push({ t: cur, el: tracker.elevationAt(cur) });
    let guard = 0;
    for (;;) {
      const next = lastUp + IN_PASS_STEP_MS;
      const el = tracker.elevationAt(next);
      if (el <= horizon || ++guard > MAX_PASS_MS / IN_PASS_STEP_MS) {
        cur = next;
        break;
      }
      samples.push({ t: next, el });
      lastUp = next;
    }
    const setMs = findCrossing(up, lastUp, cur);
    samples.push({ t: setMs, el: horizon });

    let bi = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i]!.el > samples[bi]!.el) bi = i;
    const lo = samples[Math.max(0, bi - 1)]!.t;
    const hi = samples[Math.min(samples.length - 1, bi + 1)]!.t;
    const peakMs = goldenMax((x) => tracker.elevationAt(x), lo, hi);
    const peak = tracker.sample(peakMs);

    if (peak && peak.elDeg >= floor) {
      passes.push(buildPass(tracker, rise, peakMs, setMs, peak.elDeg, opts.thresholdsDeg));
    }

    prevT = cur;
    t = cur + tracker.skipMs(tracker.sample(cur)?.theta ?? Math.PI / 2);
    first = false;
  }
  return passes;
}

function buildPass(
  tracker: SatTracker,
  rise: Ms,
  peakMs: Ms,
  setMs: Ms,
  maxEl: number,
  thresholds: number[],
): PassGeometry {
  const above: Record<string, Interval | null> = {};
  for (const th of thresholds) {
    if (maxEl < th) {
      above[String(th)] = null;
      continue;
    }
    const geq = (x: Ms) => tracker.elevationAt(x) >= th;
    above[String(th)] = {
      start: findCrossing(geq, rise, peakMs),
      end: findCrossing(geq, peakMs, setMs),
    };
  }
  return {
    id: `${tracker.element.noradId}:${Math.round(peakMs / 1000)}`,
    noradId: tracker.element.noradId,
    riseMs: rise,
    peakMs,
    setMs,
    maxElevationDeg: maxEl,
    riseAzDeg: tracker.sample(rise + 1)?.azDeg ?? NaN,
    peakAzDeg: tracker.sample(peakMs)?.azDeg ?? NaN,
    setAzDeg: tracker.sample(setMs - 1)?.azDeg ?? NaN,
    aboveThreshold: above,
    sunSegments: sunSegments(tracker, rise, peakMs, setMs, maxEl),
  };
}

/** Split [rise, set) into lit / unlit segments with refined boundaries. */
export function sunSegments(
  tracker: SatTracker,
  rise: Ms,
  peakMs: Ms,
  setMs: Ms,
  maxEl: number,
): SunSegment[] {
  const bounds: Ms[] = [rise];
  let prev = rise;
  let prevLit = tracker.isSunlit(rise);
  const states: boolean[] = [prevLit];
  for (let x = rise + SUN_STEP_MS; ; x += SUN_STEP_MS) {
    const at = Math.min(x, setMs);
    const lit = tracker.isSunlit(at);
    if (lit !== prevLit) {
      bounds.push(findCrossing((q) => tracker.isSunlit(q), prev, at));
      states.push(lit);
      prevLit = lit;
    }
    prev = at;
    if (at >= setMs) break;
  }
  bounds.push(setMs);
  const segs: SunSegment[] = [];
  for (let i = 0; i < states.length; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    // Elevation rises to the peak and falls after it, so a segment's maximum is the peak if the
    // segment contains it, otherwise the value at the end nearest the peak.
    const maxElevationDeg =
      start <= peakMs && peakMs <= end
        ? maxEl
        : end <= peakMs
          ? tracker.elevationAt(end)
          : tracker.elevationAt(start);
    segs.push({ start, end, lit: states[i]!, maxElevationDeg });
  }
  return segs;
}

export interface PredictionRun {
  passes: PassGeometry[];
  /** Satellites for which propagation produced nothing usable. */
  errors: Array<{ noradId: number; message: string }>;
  generatedAtMs: Ms;
}

/** Predict for many satellites. `onProgress` lets a Worker report status without blocking the UI. */
export function predictAll(
  elements: readonly ElementSet[],
  observer: Observer,
  startMs: Ms,
  endMs: Ms,
  opts: PredictOptions,
  onProgress?: (done: number, total: number, name: string) => void,
): PredictionRun {
  const passes: PassGeometry[] = [];
  const errors: PredictionRun['errors'] = [];
  elements.forEach((el, i) => {
    onProgress?.(i, elements.length, el.name);
    try {
      const tracker = new SatTracker(el, observer);
      if (!tracker.sample(startMs) || !tracker.sample(endMs)) {
        errors.push({ noradId: el.noradId, message: 'Orbital model could not be propagated over the search range.' });
        return;
      }
      passes.push(...findPasses(el, observer, startMs, endMs, opts));
    } catch (e) {
      errors.push({ noradId: el.noradId, message: e instanceof Error ? e.message : String(e) });
    }
  });
  onProgress?.(elements.length, elements.length, '');
  passes.sort((a, b) => a.riseMs - b.riseMs);
  return { passes, errors, generatedAtMs: Date.now() };
}
