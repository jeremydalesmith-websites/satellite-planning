import { describe, expect, it } from 'vitest';
import { evaluateFixedInterval, findEventWindows, selectNonOverlapping } from '../src/cluster/cluster.ts';
import { diagnose } from '../src/planner.ts';
import { AO91, MIN, SO50, assessed, at, iv } from './factory.ts';

/**
 * Cluster model (see README "How passes are counted"): a pass is SELECTED by its maximum elevation; its envelope is
 * the FULL AOS-to-LOS pass; a cluster's bounds are the earliest AOS and latest LOS of the counted passes; the selected
 * hours are a MAXIMUM span; the whole envelope must fit inside one availability block; passes whose full envelopes
 * overlap conflict (one station).
 */

// helper: a qualifying pass with full envelope [rise, set] minutes from T0, peaking mid-pass
const P = (rise: number, set: number, el = 60, norad = SO50, st: Parameters<typeof assessed>[1] = 'recently-reported-active') =>
  assessed({ norad, rise, set, maxEl: el }, st);
// AO-91 (sunlight-dependent) pass with explicit sunlit/shadow segments: [start, end, lit, maxEl in segment]
const AO = (rise: number, set: number, maxEl: number, sun: Array<[number, number, boolean, number]>) => assessed({ norad: AO91, rise, set, maxEl, sun });

const block = (a: number, b: number) => [iv(a, b)];
const find = (all: ReturnType<typeof P>[], blocks = block(0, 1000), min = 3, span = 150) =>
  findEventWindows(all, blocks, { maxSpanMin: span, minOpportunities: min });
const mins = (ms: number) => ms / MIN;

describe('one-station overlap rule: FULL AOS-to-LOS envelopes', () => {
  it('fully simultaneous passes count once, not twice', () => {
    expect(selectNonOverlapping([P(10, 20, 60, SO50), P(10, 20, 70, 25544)])).toHaveLength(1);
  });
  it('partially overlapping passes: only a non-overlapping subset counts', () => {
    const sel = selectNonOverlapping([P(10, 22), P(18, 30), P(26, 38)]);
    expect(sel.map((s) => s.riseMs)).toEqual([at(10), at(26)]);
  });
  it('touching end-to-start counts as sequential (no setup gap)', () => {
    expect(selectNonOverlapping([P(10, 20), P(20, 30)])).toHaveLength(2);
  });
  it('finds the optimal count, not a greedy-by-start one', () => {
    expect(selectNonOverlapping([P(0, 60), P(5, 25), P(30, 50)])).toHaveLength(2);
  });
  it('overlap is decided on whole passes: passes that overlap only in their low-elevation tails still conflict (conservative)', () => {
    const a = P(20, 34); // rises 20, sets 34
    const b = P(30, 44); // rises 30 while a is still up: overlapping envelopes
    expect(selectNonOverlapping([a, b])).toHaveLength(1);
  });
  it('among equal counts prefers more total permitted operating time, then higher elevation', () => {
    expect(selectNonOverlapping([P(0, 10, 50), P(0, 12, 50)])[0]!.setMs).toBe(at(12));
    expect(selectNonOverlapping([P(0, 10, 50), P(0, 10, 80, 25544)])[0]!.eligibleMaxElevationDeg).toBe(80);
  });
  it('operating time never includes eclipsed time: a mostly-shadowed pass loses the tie-break to a fully permitted one', () => {
    const full = P(0, 12, 50, SO50); // 12 min permitted
    const shadowed = AO(0, 12, 70, [[0, 5, true, 55], [5, 12, false, 70]]); // only 5 min permitted
    expect(shadowed.operatingMs).toBe(5 * MIN);
    expect(selectNonOverlapping([shadowed, full])[0]!.noradId).toBe(SO50);
  });
  it('overlapping qualifying passes inside the cluster are shown as alternatives, not hidden', () => {
    const a = P(10, 20, 60), b = P(14, 24, 55, 25544), c = P(40, 50);
    const w = find([a, b, c], block(0, 600), 2);
    // Best cluster {a, c}: b overlaps a, so it is an alternative. Starting from b gives a separate, distinct cluster {b, c}.
    expect(w).toHaveLength(2);
    expect(w[0]!.counted.map((x) => x.passId)).toEqual([a.passId, c.passId]);
    expect(w[0]!.alternatives.map((x) => x.passId)).toEqual([b.passId]);
    expect(w[1]!.counted.map((x) => x.passId)).toEqual([b.passId, c.passId]);
    expect(w[1]!.alternatives).toEqual([]); // a begins before this cluster, so it is not inside it
  });
});

describe('selection by PEAK elevation, duration by the FULL pass', () => {
  it('a pass whose peak only just reaches the minimum is selected, and its cluster is the whole AOS-to-LOS pass', () => {
    // 40.2° peak with only a second or so above 40°: selected by peak, but the cluster is the full 12-minute pass.
    const barely = assessed({ rise: 100, set: 112, maxEl: 40.2, above: [105.99, 106.01] });
    const w = find([barely], block(0, 1000), 1);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toEqual(iv(100, 112));
    expect(w[0]!.totalOperatingMs).toBe(12 * MIN);
  });
  it('a pass peaking below the minimum is never selected', () => {
    expect(find([assessed({ rise: 100, set: 112, maxEl: 39.9, above: null })], block(0, 1000), 1)).toEqual([]);
  });
});

describe('sunlight must be available at the qualifying elevation', () => {
  it('a sunlit-only repeater whose peak occurs in shadow does not qualify, even though it has some sunlit time', () => {
    const shadowPeak = AO(100, 112, 70, [[100, 104, true, 39], [104, 112, false, 70]]);
    expect(shadowPeak.exclusion).toBe('eclipse');
    expect(find([shadowPeak], block(0, 1000), 1)).toEqual([]);
  });
  it('one that reaches the minimum while sunlit qualifies; the cluster is the full pass, but operating time is only the sunlit part', () => {
    const p = AO(100, 112, 70, [[100, 105, true, 55], [105, 112, false, 70]]);
    const w = find([p], block(0, 1000), 1);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toEqual(iv(100, 112)); // full pass envelope
    expect(w[0]!.totalOperatingMs).toBe(5 * MIN); // eclipsed 7 min are not operating time
  });
  it('eclipse-excluded passes inside a cluster are listed as left out, not counted', () => {
    const dark = AO(30, 42, 70, [[30, 34, true, 39], [34, 42, false, 70]]);
    const w = find([P(10, 20), P(60, 70), dark], block(0, 600), 2);
    expect(w[0]!.counted).toHaveLength(2);
    expect(w[0]!.excluded.map((x) => x.passId)).toEqual([dark.passId]);
  });
});

describe('actual cluster bounds', () => {
  it('bounds are the earliest AOS and latest LOS by timestamp, whatever the input order, with gaps included', () => {
    const w = find([P(100, 110), P(20, 30), P(60, 75)], block(0, 1000), 3, 150);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toEqual(iv(20, 110));
    expect(mins(w[0]!.window.end - w[0]!.window.start)).toBe(90);
  });
  it('a 20-minute cluster qualifies for a 2-hour maximum and is NOT padded to two hours', () => {
    const w = find([P(10, 20), P(20, 30)], block(0, 600), 2, 120);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toEqual(iv(10, 30));
    expect(mins(w[0]!.window.end - w[0]!.window.start)).toBe(20);
  });
});

describe('maximum cluster span', () => {
  it('a cluster exactly as long as the maximum is allowed; one minute longer is not', () => {
    const passes = [P(0, 10), P(140, 150)];
    expect(find(passes, block(0, 600), 2, 150)).toHaveLength(1);
    expect(find([P(0, 10), P(141, 151)], block(0, 600), 2, 150)).toEqual([]);
  });
  it('the span is measured from the earliest AOS to the latest LOS, not between peaks', () => {
    // Peaks are 148 min apart but the full envelopes span 160 min.
    const w = find([P(0, 12), P(148, 160)], block(0, 600), 2, 150);
    expect(w).toEqual([]);
    expect(find([P(0, 12), P(148, 160)], block(0, 600), 2, 180)).toHaveLength(1);
  });
});

describe('the full AOS-to-LOS cluster must fit inside availability', () => {
  it('a pass that starts before or ends after the block is not usable even if its peak is inside', () => {
    expect(find([P(-5, 5), P(20, 30)], block(0, 600), 2)).toEqual([]); // AOS before the block
    expect(find([P(20, 30), P(595, 605)], block(0, 600), 2)).toEqual([]); // LOS after the block
  });
  it('flush with the block edges is inside', () => {
    expect(find([P(0, 10), P(590, 600)], block(0, 600), 2, 600)).toHaveLength(1);
  });
  it('a cluster cannot span two separate availability blocks', () => {
    expect(find([P(10, 20), P(80, 90)], [iv(0, 60), iv(70, 200)], 2)).toEqual([]);
  });
  it('a block shorter than the maximum span still holds a shorter cluster', () => {
    const w = find([P(5, 15), P(25, 35)], block(0, 60), 2, 150);
    expect(w).toHaveLength(1);
    expect(w[0]!.window).toEqual(iv(5, 35));
  });
});

describe('duplicate clusters and distinct sets', () => {
  const abc = [P(10, 20), P(30, 40), P(50, 60)];
  it('the same counted passes found from different starting points appear once', () => {
    const w = find(abc, block(0, 600), 3);
    expect(w).toHaveLength(1);
    expect(w[0]!.counted).toHaveLength(3);
  });
  it('distinct counted sets are all kept (no automatic strict-subset removal), each listed once', () => {
    const w = find(abc, block(0, 600), 2);
    const keys = w.map((c) => c.counted.map((x) => x.passId).join(','));
    expect(new Set(keys).size).toBe(keys.length); // no exact duplicates
    expect(w.map((c) => c.counted.length)).toEqual([3, 2, 2]); // {A,B,C} first, then the shorter {A,B} and {B,C}
  });
  it('a shorter cluster with fewer passes is kept next to a much longer cluster', () => {
    const w = find([P(0, 10), P(20, 30), P(140, 150)], block(0, 600), 2, 150);
    const long = w.find((c) => c.counted.length === 3)!;
    const short = w.find((c) => c.counted.length === 2 && c.window.end === at(30))!;
    expect(mins(long.window.end - long.window.start)).toBe(150);
    expect(short.window).toEqual(iv(0, 30));
  });
  it('honours the display limit', () => {
    expect(findEventWindows(abc, block(0, 600), { maxSpanMin: 150, minOpportunities: 2, limit: 1 })).toHaveLength(1);
  });
});

describe('status gating of the minimum', () => {
  it('unknown, stale and activation-required passes never satisfy the minimum', () => {
    expect(find([P(10, 20), P(60, 70, 60, 25544, 'unknown-stale'), P(110, 120, 60, 40908, 'activation-required')])).toEqual([]);
  });
  it('they do not appear anywhere in a qualifying cluster', () => {
    const w = find([P(10, 20), P(60, 70), P(110, 120), P(130, 140, 60, 25544, 'unknown-stale')]);
    expect(w).toHaveLength(1);
    expect(w[0]!.counted).toHaveLength(3);
    const shown = [...w[0]!.counted, ...w[0]!.alternatives, ...w[0]!.excluded];
    expect(shown.some((a) => a.noradId === 25544)).toBe(false);
    expect(w[0]!.distinctSatellites).toBe(1);
  });
});

describe('ranking', () => {
  const day = 24 * 60;
  it('ranks by count, then total operating time, then elevations, then earlier start', () => {
    const four = [P(10, 20), P(40, 50), P(70, 80), P(100, 110)];
    const threeLong = [P(day + 10, day + 30), P(day + 50, day + 70), P(day + 90, day + 110)];
    const threeHigh = [P(2 * day + 10, 2 * day + 20, 85), P(2 * day + 40, 2 * day + 50, 85), P(2 * day + 70, 2 * day + 80, 85)];
    const w = find([...threeHigh, ...threeLong, ...four], [iv(0, 600), iv(day, day + 600), iv(2 * day, 2 * day + 600)], 3);
    expect(w[0]!.counted).toHaveLength(4); // most passes first
    expect(w[1]!.window.start).toBe(at(day + 10)); // then 3 passes with the most operating time (3 x 20 min)
    expect(w[1]!.totalOperatingMs).toBeGreaterThan(w[2]!.totalOperatingMs);
    expect(w[2]!.window.start).toBe(at(2 * day + 10)); // then equal time (3 x 10 min): higher summed elevations beat the lower ones
    // the 4-pass block's shorter 3-pass sets are distinct clusters and are kept, ranked below
    expect(w.filter((x) => x.counted.length === 3).length).toBeGreaterThanOrEqual(4);
  });
  it('equal count and time: higher elevations win, then the earlier start', () => {
    const w = find([P(10, 20, 50), P(30, 40, 50), P(day + 10, day + 20, 80), P(day + 30, day + 40, 80)], [iv(0, 600), iv(day, day + 600)], 2);
    expect(w[0]!.window.start).toBe(at(day + 10)); // 160° beats 100°
    const same = find([P(10, 20, 50), P(30, 40, 50), P(day + 10, day + 20, 50), P(day + 30, day + 40, 50)], [iv(0, 600), iv(day, day + 600)], 2);
    expect(same[0]!.window.start).toBe(at(10)); // identical scores: earlier start
  });
  it('the minimum is honoured, including 2', () => {
    expect(find([P(10, 20), P(60, 70)], block(0, 600), 2)).toHaveLength(1);
    expect(find([P(10, 20), P(60, 70)], block(0, 600), 3)).toEqual([]);
  });
});

describe('empty results explain themselves and never relax silently', () => {
  const inputs = {
    observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
    criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 3 },
    availability: { periods: {} as never, selected: {} as never }, range: iv(0, 600),
  };
  it('no passes at all: empty result, no suggestions that would help', () => {
    expect(find([], block(0, 600))).toEqual([]);
    const d = diagnose(inputs, [], new Map(), [], block(0, 600));
    expect(d.suggestions).toEqual([]);
    expect(d.eligiblePasses).toBe(0);
  });
  it('suggests fewer passes as TEXT only, never suggests counting unconfirmed satellites; the original result stays empty', () => {
    const all = [P(10, 20), P(60, 70), P(110, 120, 60, 25544, 'unknown-stale')];
    expect(find(all)).toEqual([]);
    const d = diagnose(inputs, [], new Map(), all, block(0, 600));
    expect(d.suggestions.map((s) => s.kind)).toContain('fewer-opportunities');
    expect(d.suggestions.map((s) => s.kind as string)).not.toContain('count-conditional');
    expect(find(all)).toEqual([]); // nothing was applied
  });
  it('detects that availability is the bottleneck (no block can hold a whole pass)', () => {
    const all = [P(10, 20), P(60, 70), P(110, 120)];
    const d = diagnose(inputs, [], new Map(), all, block(300, 304));
    expect(d.blocksHoldingAPass).toBe(0);
    expect(d.suggestions.map((s) => s.kind)).toContain('more-availability');
  });
  it('can suggest a larger maximum span as text only', () => {
    const all = [P(10, 20), P(100, 110), P(170, 180)]; // 170 min envelope: too long for 150, fine for 180
    expect(find(all, block(0, 600), 3, 150)).toEqual([]);
    const d = diagnose({ ...inputs, criteria: { ...inputs.criteria, maxSpanMin: 150 } }, [], new Map(), all, block(0, 600));
    expect(d.suggestions.map((s) => s.kind)).toContain('longer-span');
  });
});

describe('the saved-event tolerance does not leak into new searches', () => {
  it('a pass one second outside the availability block is excluded: new-search constraints are exact', () => {
    const early = assessed({ norad: SO50, rise: -1 / 60, set: 10, maxEl: 60 }); // AOS one second before the block starts
    expect(find([early, P(20, 30)], block(0, 600), 2)).toEqual([]);
    expect(find([P(20, 30), assessed({ norad: SO50, rise: 590, set: 600 + 1 / 60, maxEl: 60 })], block(0, 600), 2)).toEqual([]); // LOS one second after the end
  });
  it('a cluster one second longer than the maximum span is rejected', () => {
    expect(find([P(0, 10), assessed({ norad: SO50, rise: 140, set: 150 + 1 / 60, maxEl: 60 })], block(0, 600), 2, 150)).toEqual([]);
  });
});

describe('a FIXED interval (saved event) is evaluated by whole passes, with drift reported', () => {
  const win = iv(100, 250);
  it('a pass counts only if its whole AOS-to-LOS fits inside; one that merely overlaps is reported as an edge case', () => {
    const inside = P(110, 120);
    const flush = P(240, 250);
    const straddle = P(96, 108); // AOS before the saved start
    const ev = evaluateFixedInterval(win, [inside, flush, straddle]);
    expect(ev.counted).toHaveLength(2);
    expect(ev.edge.map((e) => e.passId)).toEqual([straddle.passId]);
  });
  it('the above-threshold part being inside is not enough: the whole pass must fit', () => {
    const p = assessed({ rise: 96, set: 120, maxEl: 60, above: [105, 110] });
    const ev = evaluateFixedInterval(win, [p]);
    expect(ev.counted).toHaveLength(0);
    expect(ev.edge).toHaveLength(1);
  });
  it('passes that do not touch the interval are ignored', () => {
    expect(evaluateFixedInterval(win, [P(10, 20), P(300, 310)]).counted).toHaveLength(0);
  });
});
