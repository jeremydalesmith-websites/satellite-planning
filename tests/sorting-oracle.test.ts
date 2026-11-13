import { describe, expect, it } from 'vitest';
import { findAllWindows, rankResults, usableElevation } from '../src/cluster/cluster.ts';
import type { SortBy } from '../src/cluster/cluster.ts';
import { SO50, assessed, at, iv } from './factory.ts';

/**
 * EXHAUSTIVE COMPARISON. For many small random schedules, every feasible cluster is enumerated by brute force (every subset
 * of passes that is pairwise non-overlapping, lies inside one availability block, has at least the minimum number of passes
 * and fits the maximum span), and the real search must agree on what each sort puts first:
 *   Date:       the earliest start that any feasible cluster has (and, at that start, the most passes, then the highest lowest
 *               elevation);
 *   Elevation:  the highest "lowest usable elevation" any feasible cluster reaches;
 *   Pass count: the most passes any feasible cluster holds.
 * A count-and-elevation-only pruning once dropped the EARLIEST cluster whenever a later one had at least as many passes and as
 * high an elevation; the frontier now includes the start time.
 */
interface Pass { rise: number; set: number; el: number }
const P = (p: Pass) => assessed({ norad: SO50, rise: p.rise, set: p.set, maxEl: p.el, thr: 40 }, 'recently-reported-active');

/** Deterministic pseudo-random numbers (mulberry32), so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function schedule(seed: number) {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const n = int(3, 9);
  // One satellite never has two passes with the same AOS (a pass id is satellite + AOS), so AOS times are kept distinct.
  const used = new Set<number>();
  const passes: Pass[] = Array.from({ length: n }, () => {
    let rise = int(0, 330);
    while (used.has(rise)) rise = int(0, 330);
    used.add(rise);
    return { rise, set: rise + int(6, 16), el: int(40, 89) };
  });
  const blocks = r() < 0.5 ? [iv(0, 400)] : [iv(0, 190), iv(200, 420)];
  const maxSpanMin = [120, 150, 180][int(0, 2)]!;
  const minOpportunities = int(2, 3);
  return { passes, blocks, maxSpanMin, minOpportunities };
}

interface Cluster { start: number; count: number; minEl: number }

function bruteForce(s: ReturnType<typeof schedule>): Cluster[] {
  const out: Cluster[] = [];
  const { passes } = s;
  for (let mask = 1; mask < 1 << passes.length; mask++) {
    const set = passes.filter((_, i) => mask & (1 << i));
    if (set.length < s.minOpportunities) continue;
    set.sort((a, b) => a.rise - b.rise);
    let ok = true;
    for (let i = 1; i < set.length && ok; i++) ok = set[i]!.rise >= set[i - 1]!.set; // envelopes must not overlap
    if (!ok) continue;
    const start = set[0]!.rise;
    const end = Math.max(...set.map((p) => p.set));
    if (end - start > s.maxSpanMin) continue;
    if (!s.blocks.some((b) => at(start) >= b.start && at(end) <= b.end)) continue;
    out.push({ start: at(start), count: set.length, minEl: Math.min(...set.map((p) => p.el)) });
  }
  return out;
}

const SEEDS = Array.from({ length: 600 }, (_, i) => 1000 + i);

describe('the real search agrees with an exhaustive enumeration on what each sort puts first', () => {
  const search = (s: ReturnType<typeof schedule>, sort: SortBy) =>
    findAllWindows(s.passes.map(P), s.blocks, { maxSpanMin: s.maxSpanMin, minOpportunities: s.minOpportunities, sort });

  it('Date: the earliest feasible start is always found, and the best cluster at that start comes first', () => {
    const misses: number[] = [];
    for (const seed of SEEDS) {
      const s = schedule(seed);
      const all = bruteForce(s);
      const got = search(s, 'date');
      if (all.length === 0) { if (got.length !== 0) misses.push(seed); continue; }
      const earliest = Math.min(...all.map((c) => c.start));
      const bestAtStart = all.filter((c) => c.start === earliest).sort((a, b) => b.count - a.count || b.minEl - a.minEl)[0]!;
      const first = got[0];
      if (!first || first.window.start !== earliest || first.counted.length !== bestAtStart.count || first.minUsableElevationDeg !== bestAtStart.minEl) misses.push(seed);
    }
    expect(misses).toEqual([]);
  });
  it('Elevation: the highest lowest-elevation any feasible cluster reaches is found', () => {
    const misses: number[] = [];
    for (const seed of SEEDS) {
      const s = schedule(seed);
      const all = bruteForce(s);
      const got = search(s, 'elevation');
      if (all.length === 0) { if (got.length !== 0) misses.push(seed); continue; }
      if (got[0]?.minUsableElevationDeg !== Math.max(...all.map((c) => c.minEl))) misses.push(seed);
    }
    expect(misses).toEqual([]);
  });
  it('Pass count: the largest feasible cluster is found', () => {
    const misses: number[] = [];
    for (const seed of SEEDS) {
      const s = schedule(seed);
      const all = bruteForce(s);
      const got = search(s, 'count');
      if (all.length === 0) { if (got.length !== 0) misses.push(seed); continue; }
      if (got[0]?.counted.length !== Math.max(...all.map((c) => c.count))) misses.push(seed);
    }
    expect(misses).toEqual([]);
  });
  it('every cluster returned is feasible (sorting never creates or hides feasibility)', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const s = schedule(seed);
      const feasible = new Set(bruteForce(s).map((c) => `${c.start}|${c.count}|${c.minEl}`));
      for (const sort of ['date', 'elevation', 'count'] as const) {
        for (const w of search(s, sort)) expect(feasible.has(`${w.window.start}|${w.counted.length}|${w.minUsableElevationDeg}`), `seed ${seed} ${sort}`).toBe(true);
      }
    }
  });
  it('the display limit is applied afterwards: the shown list is the first N of the full sorted list, with the true total', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const s = schedule(seed);
      for (const sort of ['date', 'elevation', 'count'] as const) {
        const opts = { maxSpanMin: s.maxSpanMin, minOpportunities: s.minOpportunities, sort };
        const full = findAllWindows(s.passes.map(P), s.blocks, opts);
        const shown = rankResults(s.passes.map(P), s.blocks, { ...opts, limit: 3 });
        expect(shown.windowsTotal).toBe(full.length);
        expect(shown.windows.map((w) => w.counted.map((c) => c.passId).join())).toEqual(full.slice(0, 3).map((w) => w.counted.map((c) => c.passId).join()));
      }
    }
  });
});

describe('the Date regression found in review (an earlier cluster dominated only on count and elevation)', () => {
  // Pass A (minute 0-10, 50 deg) can start a 2-pass cluster with B (20-30, 50 deg). A LATER 2-pass cluster C (40-50, 80) + D (60-70, 80)
  // has the same count and a higher elevation, so a (count, elevation)-only frontier would drop the earlier one.
  const passes = [P({ rise: 0, set: 10, el: 50 }), P({ rise: 20, set: 30, el: 50 }), P({ rise: 40, set: 50, el: 80 }), P({ rise: 60, set: 70, el: 80 })];
  it('Date returns the earlier, lower-elevation cluster first', () => {
    const w = findAllWindows(passes, [iv(0, 200)], { maxSpanMin: 150, minOpportunities: 2, sort: 'date' });
    expect(w[0]!.window.start).toBe(at(0));
    expect(w[0]!.minUsableElevationDeg).toBeGreaterThanOrEqual(50);
  });
  it('Elevation still returns the higher one first', () => {
    const w = findAllWindows(passes, [iv(0, 200)], { maxSpanMin: 150, minOpportunities: 2, sort: 'elevation' });
    expect(w[0]!.minUsableElevationDeg).toBe(80);
  });
  it('the usable-elevation helper is what the comparison uses', () => {
    expect(usableElevation(passes[0]!)).toBe(50);
  });
});

describe('cost: no subset enumeration', () => {
  it('a six-week search with about 1,200 passes in one continuous availability block is fast for every sort', () => {
    const day = 24 * 60;
    const passes: ReturnType<typeof P>[] = [];
    for (let d = 0; d < 42; d++) for (let k = 0; k < 28; k++) passes.push(P({ rise: d * day + k * 51 + (k % 3), set: d * day + k * 51 + (k % 3) + 7 + (k % 5), el: 40 + ((d * 7 + k * 13) % 50) }));
    const blocks = [iv(0, 42 * day)];
    const t0 = Date.now();
    for (const sort of ['date', 'elevation', 'count'] as const) {
      const r = rankResults(passes, blocks, { maxSpanMin: 180, minOpportunities: 3, sort });
      expect(r.windows.length).toBeLessThanOrEqual(25);
      expect(r.windowsTotal).toBeGreaterThan(25);
    }
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});
