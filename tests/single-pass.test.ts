import { describe, expect, it } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import { findEventWindows, findSinglePasses } from '../src/cluster/cluster.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { SINGLE_PASS_RESULT_LIMIT } from '../src/domain/policy.ts';
import { computePlan, diagnose } from '../src/planner.ts';
import { AO91, SO50, T0, assessed, at, geom, iv } from './factory.ts';
import { elementsFixture } from './helpers.ts';

/**
 * SINGLE-PASS MODE (minimum passes = 1): every qualifying pass is its own result, ranked by maximum elevation (highest
 * first, earlier on a tie). The maximum span does not apply. Everything else (peak selection, sunlight, eligibility,
 * availability, selection) is unchanged, and 2+ minimum passes still builds clusters.
 */
const P = (rise: number, set: number, el = 60, norad = SO50, st: Parameters<typeof assessed>[1] = 'recently-reported-active', thr = 40) =>
  assessed({ norad, rise, set, maxEl: el, thr }, st);
const AO = (rise: number, set: number, maxEl: number, sun: Array<[number, number, boolean, number]>, thr = 40) => assessed({ norad: AO91, rise, set, maxEl, sun, thr });
const block = (a: number, b: number) => [iv(a, b)];
// These tests were written for the elevation order, so the helper asks for it explicitly (the app default is Date).
const find = (all: ReturnType<typeof P>[], blocks = block(0, 1000), min = 1, span = 150) => findEventWindows(all, blocks, { maxSpanMin: span, minOpportunities: min, sort: 'elevation' });

describe('each qualifying pass is its own result', () => {
  it('passes that would form one cluster come back as separate one-pass results', () => {
    const passes = [P(10, 20), P(30, 40, 60, 25544), P(50, 60)];
    const w = find(passes);
    expect(w).toHaveLength(3);
    for (const r of w) {
      expect(r.counted).toHaveLength(1);
      expect(r.alternatives).toEqual([]);
      expect(r.excluded).toEqual([]);
      expect(r.distinctSatellites).toBe(1);
      expect(r.window).toEqual({ start: r.counted[0]!.riseMs, end: r.counted[0]!.setMs }); // the pass itself is the window
    }
  });
  it('does not build a multi-pass cluster even when passes are adjacent, but 2+ minimum passes still does', () => {
    const passes = [P(10, 20), P(20, 30)];
    expect(find(passes, block(0, 600), 1).map((r) => r.counted.length)).toEqual([1, 1]);
    const clusters = find(passes, block(0, 600), 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.counted).toHaveLength(2); // cluster behaviour preserved
    expect(clusters[0]!.window).toEqual(iv(10, 30));
  });
  it('overlapping passes are all returned (there is no one-station conflict between separate results)', () => {
    expect(find([P(10, 20), P(14, 24, 55, 25544)])).toHaveLength(2);
  });
});

describe('ranking: maximum elevation, highest first; earlier time breaks ties', () => {
  it('orders by elevation, then by earlier AOS', () => {
    const a = P(100, 110, 62), b = P(10, 20, 80), c = P(50, 60, 80, 25544), d = P(200, 210, 55);
    const w = find([a, b, c, d]);
    expect(w.map((r) => r.counted[0]!.passId)).toEqual([b.passId, c.passId, a.passId, d.passId]); // 80 (earlier), 80, 62, 55
  });
  it('input order does not matter', () => {
    const passes = [P(100, 110, 62), P(10, 20, 80), P(50, 60, 80, 25544), P(200, 210, 55)];
    const forward = find(passes).map((r) => r.counted[0]!.passId);
    expect(find([...passes].reverse()).map((r) => r.counted[0]!.passId)).toEqual(forward);
  });
  it('a sunlight-limited pass is ranked by the elevation it can be operated at, not by a peak in shadow', () => {
    const ao = AO(100, 112, 85, [[100, 105, true, 62], [105, 112, false, 85]]); // peak 85 in shadow; 62 while sunlit
    const so = P(10, 20, 70);
    const w = find([ao, so]);
    expect(w.map((r) => r.counted[0]!.noradId)).toEqual([SO50, AO91]); // 70 beats 62, although 85 > 70
  });
});

describe('the existing rules still apply to single passes', () => {
  it('honours the minimum elevation, including 60° and higher', () => {
    const passes = [P(10, 20, 59.9, SO50, 'recently-reported-active', 60), P(30, 40, 60, SO50, 'recently-reported-active', 60), P(50, 60, 88, 25544, 'recently-reported-active', 60)];
    const w = find(passes);
    expect(w.map((r) => r.counted[0]!.fullMaxElevationDeg)).toEqual([88, 60]); // 59.9 is out, 60 is in
  });
  it('a sunlit-only repeater whose peak occurs only in shadow does not qualify; one that reaches the elevation while sunlit does', () => {
    const shadowOnly = AO(10, 22, 80, [[10, 14, true, 39], [14, 22, false, 80]]);
    const sunlit = AO(40, 52, 70, [[40, 46, true, 55], [46, 52, false, 70]]);
    const w = find([shadowOnly, sunlit]);
    expect(w).toHaveLength(1);
    expect(w[0]!.counted[0]!.passId).toBe(sunlit.passId);
    expect(w[0]!.totalOperatingMs).toBe(6 * 60_000); // only the sunlit 6 minutes are operating time
  });
  it('ineligible satellites never appear', () => {
    expect(find([P(10, 20, 80, SO50, 'unknown-stale'), P(30, 40, 60, 25544, 'activation-required'), P(50, 60, 50)])).toHaveLength(1);
  });
  it('the whole pass must lie inside one availability block: a pass starting before or ending after it is excluded', () => {
    const w = find([P(-5, 5, 80), P(20, 30, 70), P(595, 605, 90)], block(0, 600));
    expect(w.map((r) => r.counted[0]!.fullMaxElevationDeg)).toEqual([70]);
  });
  it('passes in different availability blocks are all returned, once each', () => {
    const w = find([P(10, 20, 60), P(110, 120, 75)], [iv(0, 60), iv(100, 200)]);
    expect(w.map((r) => r.counted[0]!.fullMaxElevationDeg)).toEqual([75, 60]);
  });
});

describe('the maximum span is ignored in single-pass mode', () => {
  it('results are identical whatever span is selected', () => {
    const passes = [P(10, 20, 60), P(200, 214, 75), P(400, 412, 66)];
    const ids = (span: number) => find(passes, block(0, 1000), 1, span).map((r) => r.counted[0]!.passId);
    expect(ids(120)).toEqual(ids(180));
    expect(ids(120)).toHaveLength(3);
  });
});

describe('planner: selection, display limit and diagnosis', () => {
  const heard = (key: string): [string, { reports: [number, 'H', number][] }] => [key, { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] }];
  const status: StatusFile = { schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString(), satellites: Object.fromEntries([heard('SO-50_[FM]'), heard('ISS_[FM]')]) };
  const av = emptyAvailability();
  for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
  av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
  const plan = (passes: ReturnType<typeof geom>[], selectedNoradIds: number[], minElevationDeg = 40) =>
    computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg, maxSpanMin: 150, minOpportunities: 1 }, availability: av, range: { start: at(-120), end: at(3000) }, selectedNoradIds, sortBy: 'elevation' },
      { elements: elementsFixture, status }, passes, [], [], T0,
    );

  it('unselected and ineligible satellites are not offered', () => {
    const passes = [geom({ norad: 27607, rise: 56, set: 68, maxEl: 70 }), geom({ norad: 25544, rise: 96, set: 109, maxEl: 80 }), geom({ norad: 43017, rise: 130, set: 141, maxEl: 90 })];
    const only = plan(passes, [27607, 43017]); // ISS not selected; AO-91 selected but has no recent report
    expect(only.windows.map((w) => w.counted[0]!.noradId)).toEqual([27607]);
    const both = plan(passes, [27607, 25544]);
    expect(both.windows.map((w) => w.counted[0]!.noradId)).toEqual([25544, 27607]); // ISS 80 first, then SO-50 70
  });
  it('reports the total and applies the display limit when there are very many passes', () => {
    const many = Array.from({ length: SINGLE_PASS_RESULT_LIMIT + 20 }, (_, i) => geom({ norad: 27607, rise: 20 + i * 15, set: 30 + i * 15, maxEl: 41 + (i % 40) }));
    const result = plan(many, [27607]);
    expect(result.windowsTotal).toBe(SINGLE_PASS_RESULT_LIMIT + 20);
    expect(result.windows).toHaveLength(SINGLE_PASS_RESULT_LIMIT);
    const elevations = result.windows.map((w) => w.counted[0]!.fullMaxElevationDeg);
    expect(elevations).toEqual([...elevations].sort((a, b) => b - a)); // highest first through the whole list
    expect(findSinglePasses(result.assessments, result.availabilityIntervals, 'elevation')).toHaveLength(SINGLE_PASS_RESULT_LIMIT + 20);
  });
  it('cluster mode is unchanged: windowsTotal equals the clusters shown', () => {
    const passes = [geom({ norad: 27607, rise: 56, set: 68, maxEl: 70 }), geom({ norad: 25544, rise: 96, set: 109, maxEl: 80 })];
    const result = computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 2 }, availability: av, range: { start: at(-120), end: at(3000) }, selectedNoradIds: [27607, 25544] },
      { elements: elementsFixture, status }, passes, [], [], T0,
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.counted).toHaveLength(2);
    expect(result.windowsTotal).toBe(1);
  });
  it('the empty-result diagnosis speaks of results, not clusters, and never suggests a larger span', () => {
    const inputs = { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 60, maxSpanMin: 120, minOpportunities: 1 }, availability: av, range: iv(0, 1000) };
    const all = [P(10, 20, 58, SO50, 'recently-reported-active', 60)];
    const d = diagnose(inputs, [], new Map(), all, block(0, 1000));
    expect(d.suggestions.map((s) => s.kind)).not.toContain('longer-span');
    expect(d.suggestions.every((s) => !/cluster/.test(s.text))).toBe(true);
  });
});
