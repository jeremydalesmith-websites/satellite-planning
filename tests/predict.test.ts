import { describe, expect, it } from 'vitest';
import { SatTracker, findCrossing, findPasses, goldenMax } from '../src/orbit/predict.ts';
import { FIXTURE_DOWNLOAD_MS, TEST_OBSERVER, el } from './helpers.ts';

const DAY = 86_400_000;
const START = FIXTURE_DOWNLOAD_MS;

/** Independent reference: dense 1-second sampling, same satellite.js propagation. */
function bruteForce(noradId: number, days: number, floorDeg: number) {
  const tr = new SatTracker(el(noradId), TEST_OBSERVER);
  const out: Array<{ rise: number; set: number; max: number; peak: number }> = [];
  let cur: { rise: number; max: number; peak: number } | null = null;
  for (let t = START; t < START + days * DAY; t += 1000) {
    const e = tr.elevationAt(t);
    if (e > 0) {
      if (!cur) cur = { rise: t, max: e, peak: t };
      else if (e > cur.max) { cur.max = e; cur.peak = t; }
    } else if (cur) {
      if (cur.max >= floorDeg) {
        // Near-zenith passes have a sharp peak that a 1 s grid can miss by up to ~0.05°,
        // so refine the reference maximum at 10 ms resolution around its 1 s peak.
        for (let u = cur.peak - 1500; u <= cur.peak + 1500; u += 10) {
          const v = tr.elevationAt(u);
          if (v > cur.max) { cur.max = v; cur.peak = u; }
        }
        out.push({ rise: cur.rise, set: t, max: cur.max, peak: cur.peak });
      }
      cur = null;
    }
  }
  return out;
}

describe('numerical helpers', () => {
  it('findCrossing locates a step to within tolerance', () => {
    const x = findCrossing((t) => t >= 12_345.6, 0, 100_000, 1);
    expect(Math.abs(x - 12_345.6)).toBeLessThan(2);
  });
  it('goldenMax finds the peak of a parabola', () => {
    const x = goldenMax((t) => -((t - 5000) ** 2), 0, 12_000, 1);
    expect(Math.abs(x - 5000)).toBeLessThan(2);
  });
});

describe('adaptive pass search matches dense brute force', () => {
  // ISS (51.6° orbit), SO-50 (64.6°), AO-91 (sun-sync) cover different geometries.
  for (const id of [25544, 27607, 43017]) {
    it(`NORAD ${id}: same passes, rise/set within 1.5 s, max elevation within 0.005°`, () => {
      const floor = 5;
      const ref = bruteForce(id, 4, floor);
      const got = findPasses(el(id), TEST_OBSERVER, START, START + 4 * DAY, { thresholdsDeg: [floor] })
        // brute force only keeps passes that began and ended inside the window
        .filter((p) => p.riseMs > START + 1000 && p.setMs < START + 4 * DAY - 1000);
      expect(ref.length).toBeGreaterThan(3);
      const gotInRef = got.filter((g) => ref.some((r) => Math.abs(r.rise - g.riseMs) < 5000));
      expect(gotInRef.length).toBe(ref.length);
      for (const r of ref) {
        const g = got.find((x) => Math.abs(x.riseMs - r.rise) < 5000)!;
        expect(g, 'missed pass').toBeDefined();
        expect(Math.abs(g.riseMs - r.rise)).toBeLessThan(1500);
        expect(Math.abs(g.setMs - r.set)).toBeLessThan(1500);
        expect(Math.abs(g.maxElevationDeg - r.max)).toBeLessThan(0.005);
        // The refined maximum must not be lower than the dense reference (beyond solver tolerance).
        expect(g.maxElevationDeg).toBeGreaterThanOrEqual(r.max - 0.001);
      }
    });
  }
});

describe('elevation-threshold boundaries', () => {
  const passes = findPasses(el(27607), TEST_OBSERVER, START, START + 10 * DAY, { thresholdsDeg: [5] });
  const p = passes.find((x) => x.maxElevationDeg > 30)!;

  it('a threshold just below the maximum yields a short interval around the peak', () => {
    const th = p.maxElevationDeg - 0.05;
    const [q] = findPasses(el(27607), TEST_OBSERVER, p.riseMs - 60_000, p.setMs + 60_000, { thresholdsDeg: [th] });
    expect(q).toBeDefined();
    const iv = q!.aboveThreshold[String(th)]!;
    expect(iv).not.toBeNull();
    expect(iv.start).toBeLessThanOrEqual(q!.peakMs);
    expect(iv.end).toBeGreaterThanOrEqual(q!.peakMs);
    expect(iv.end - iv.start).toBeLessThan(60_000);
  });

  it('a threshold just above the maximum drops the pass entirely', () => {
    const th = p.maxElevationDeg + 0.05;
    const res = findPasses(el(27607), TEST_OBSERVER, p.riseMs - 60_000, p.setMs + 60_000, { thresholdsDeg: [th] });
    expect(res.find((x) => Math.abs(x.peakMs - p.peakMs) < 30_000)).toBeUndefined();
  });

  it('interval above a lower threshold contains the interval above a higher one', () => {
    const res = findPasses(el(27607), TEST_OBSERVER, p.riseMs - 60_000, p.setMs + 60_000, { thresholdsDeg: [10, 25] });
    const q = res.find((x) => Math.abs(x.peakMs - p.peakMs) < 30_000)!;
    const lo = q.aboveThreshold['10']!;
    const hi = q.aboveThreshold['25']!;
    expect(lo.start).toBeLessThan(hi.start);
    expect(lo.end).toBeGreaterThan(hi.end);
  });
});

describe('range edges', () => {
  it('a pass already in progress at the start of the range reports its true rise time', () => {
    const [p] = findPasses(el(27607), TEST_OBSERVER, START, START + 3 * DAY, { thresholdsDeg: [20] });
    const mid = (p!.riseMs + p!.setMs) / 2;
    const [q] = findPasses(el(27607), TEST_OBSERVER, mid, mid + 60 * 60_000, { thresholdsDeg: [20] });
    expect(q).toBeDefined();
    expect(Math.abs(q!.riseMs - p!.riseMs)).toBeLessThan(200);
    expect(Math.abs(q!.setMs - p!.setMs)).toBeLessThan(200);
  });
});
