import { describe, expect, it } from 'vitest';
import { findAllWindows, findEventWindows, rankResults } from '../src/cluster/cluster.ts';
import type { SortBy } from '../src/cluster/cluster.ts';
import { RESULT_LIMIT, SINGLE_PASS_RESULT_LIMIT } from '../src/domain/policy.ts';
import { AO91, SO50, assessed, at, iv } from './factory.ts';

/**
 * SORTING. The sort changes only the ORDER of the results, never which results exist, and it is applied before the
 * display limit. Date: soonest first. Elevation: highest first (a cluster is scored by its LOWEST usable maximum
 * elevation). Pass count: most passes first (clusters only). Elevation and Pass count break ties by earlier start.
 */
const P = (rise: number, set: number, el = 60, norad = SO50) => assessed({ norad, rise, set, maxEl: el, thr: 40 }, 'recently-reported-active');
const block = (a: number, b: number) => [iv(a, b)];
const run = (all: ReturnType<typeof P>[], sort: SortBy, min: number, blocks = block(0, 100000), span = 150) => findEventWindows(all, blocks, { maxSpanMin: span, minOpportunities: min, sort });
const starts = (w: ReturnType<typeof run>) => w.map((x) => x.window.start);

describe('single passes', () => {
  const passes = [P(100, 110, 62), P(10, 20, 80), P(50, 60, 80, 25544), P(200, 210, 55)];
  it('Date (default): soonest first', () => {
    expect(starts(run(passes, 'date', 1))).toEqual([at(10), at(50), at(100), at(200)]);
    expect(starts(findEventWindows(passes, block(0, 1000), { maxSpanMin: 150, minOpportunities: 1 }))).toEqual([at(10), at(50), at(100), at(200)]);
  });
  it('Elevation: highest first; equal elevations by earlier start', () => {
    const w = run(passes, 'elevation', 1);
    expect(w.map((x) => x.counted[0]!.fullMaxElevationDeg)).toEqual([80, 80, 62, 55]);
    expect(starts(w).slice(0, 2)).toEqual([at(10), at(50)]);
  });
  it('Pass count has no meaning for single passes: it falls back to Date', () => {
    expect(starts(run(passes, 'count', 1))).toEqual(starts(run(passes, 'date', 1)));
  });
  it('a sunlight-limited pass is ranked by the elevation it can be operated at', () => {
    const ao = assessed({ norad: AO91, rise: 100, set: 112, maxEl: 85, thr: 40, sun: [[100, 105, true, 62], [105, 112, false, 85]] }, 'recently-reported-active');
    const w = run([ao, P(10, 20, 70)], 'elevation', 1);
    expect(w[0]!.window.start).toBe(at(10)); // 70 beats the 62 the AO-91 pass can actually be used at, not its 85 in shadow
  });
  it('input order never matters', () => {
    for (const sort of ['date', 'elevation'] as const) {
      expect(starts(run([...passes].reverse(), sort, 1))).toEqual(starts(run(passes, sort, 1)));
    }
  });
});

describe('clusters', () => {
  // day 0: three passes at 45/90/90 (min 45). day 1: two passes at 80/75 (min 75). day 2: four passes at 41 (min 41).
  const day = 24 * 60;
  const all = [
    P(10, 20, 45), P(40, 50, 90), P(70, 80, 90),
    P(day + 10, day + 20, 80), P(day + 40, day + 50, 75),
    P(2 * day + 10, 2 * day + 20, 41), P(2 * day + 40, 2 * day + 50, 41), P(2 * day + 70, 2 * day + 80, 41), P(2 * day + 100, 2 * day + 110, 41),
  ];
  const blocks = [iv(0, 600), iv(day, day + 600), iv(2 * day, 2 * day + 600)];
  it('the sort never changes WHICH clusters exist', () => {
    const ids = (sort: SortBy) => findAllWindows(all, blocks, { maxSpanMin: 150, minOpportunities: 2, sort }).map((w) => w.counted.map((c) => c.passId).join(',')).sort();
    expect(ids('elevation')).toEqual(ids('date'));
    expect(ids('count')).toEqual(ids('date'));
  });
  it('Date: soonest start first', () => {
    const s = starts(run(all, 'date', 2, blocks));
    expect(s).toEqual([...s].sort((a, b) => a - b));
  });
  it('Elevation: compares the LOWEST usable elevation, highest first', () => {
    const w = run(all, 'elevation', 2, blocks);
    expect(w[0]!.minUsableElevationDeg).toBe(90); // the pair of 90-degree passes on day 0 beats the 80/75 pair
    expect(w[0]!.counted.map((c) => c.fullMaxElevationDeg)).toEqual([90, 90]);
    const mins = w.map((x) => x.minUsableElevationDeg);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });
  it('Elevation reaches clusters that a count-first search would have hidden (the frontier)', () => {
    // day 0: the 3-pass set includes a 45; the best PAIR (90, 90) must still be a result.
    const pair = run(all, 'elevation', 2, blocks).find((w) => w.counted.length === 2 && w.minUsableElevationDeg === 90);
    expect(pair).toBeTruthy();
    // with a minimum of 3 that pair is correctly not a result
    expect(run(all, 'elevation', 3, blocks).every((w) => w.counted.length >= 3)).toBe(true);
  });
  it('Pass count: most passes first; ties by earlier start', () => {
    const w = run(all, 'count', 2, blocks);
    expect(w[0]!.counted).toHaveLength(4);
    const counts = w.map((x) => x.counted.length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    const threes = w.filter((x) => x.counted.length === 3);
    expect(starts(threes)).toEqual([...starts(threes)].sort((a, b) => a - b));
  });
  it('input order never matters', () => {
    for (const sort of ['date', 'elevation', 'count'] as const) {
      expect(run([...all].reverse(), sort, 2, blocks).map((w) => w.counted.map((c) => c.passId).join(','))).toEqual(run(all, sort, 2, blocks).map((w) => w.counted.map((c) => c.passId).join(',')));
    }
  });
});

describe('the sort is applied BEFORE the display limit', () => {
  it('single passes: the limit keeps the true soonest / highest N of more than the limit', () => {
    // elevation rises with time, so the best passes are the LAST ones: a limit applied first would lose them
    const many = Array.from({ length: SINGLE_PASS_RESULT_LIMIT + 30 }, (_, i) => P(20 + i * 15, 30 + i * 15, 41 + Math.floor(i / 3)));
    const date = rankResults(many, block(0, 1e6), { maxSpanMin: 150, minOpportunities: 1, sort: 'date' });
    expect(date.windowsTotal).toBe(many.length);
    expect(date.windows).toHaveLength(SINGLE_PASS_RESULT_LIMIT);
    expect(date.windows[0]!.window.start).toBe(at(20)); // the earliest
    const elev = rankResults(many, block(0, 1e6), { maxSpanMin: 150, minOpportunities: 1, sort: 'elevation' });
    const best = Math.max(...many.map((p) => p.fullMaxElevationDeg));
    expect(elev.windows[0]!.counted[0]!.fullMaxElevationDeg).toBe(best);
    expect(elev.windows).toHaveLength(SINGLE_PASS_RESULT_LIMIT);
    const top = [...many].map((p) => p.fullMaxElevationDeg).sort((a, b) => b - a).slice(0, SINGLE_PASS_RESULT_LIMIT);
    expect(elev.windows.map((w) => w.counted[0]!.fullMaxElevationDeg)).toEqual(top);
  });
  it('clusters: the best cluster by every sort is shown even when there are more than the limit', () => {
    const day = 24 * 60;
    // RESULT_LIMIT + 10 days of one pair each; the LAST day holds the highest pair
    const days = RESULT_LIMIT + 10;
    const all = Array.from({ length: days }, (_, d) => [P(d * day + 10, d * day + 20, 41 + d), P(d * day + 40, d * day + 50, 41 + d)]).flat();
    const blocks = Array.from({ length: days }, (_, d) => iv(d * day, d * day + 600));
    const o = (sort: SortBy) => rankResults(all, blocks, { maxSpanMin: 150, minOpportunities: 2, sort });
    expect(o('date').windows[0]!.window.start).toBe(at(10));
    expect(o('elevation').windows[0]!.minUsableElevationDeg).toBe(41 + days - 1);
    expect(o('elevation').windows).toHaveLength(RESULT_LIMIT);
    expect(o('elevation').windowsTotal).toBe(days);
  });
});
