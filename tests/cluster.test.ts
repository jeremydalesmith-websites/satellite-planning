import { describe, expect, it } from 'vitest';
import { evaluateWindow, findEventWindows, selectNonOverlapping, tidyStart } from '../src/cluster/cluster.ts';
import { diagnose } from '../src/planner.ts';
import { AO91, SO50, assessed, at, iv, MIN, status } from './factory.ts';

// helper: a pass whose operating interval is exactly [a, b] minutes from T0
const P = (a: number, b: number, el = 60, norad = SO50, st: Parameters<typeof assessed>[1] = 'recently-reported-active') =>
  assessed({ norad, rise: a - 4, set: b + 4, maxEl: el, above: [a, b] }, st);

const block = (a: number, b: number) => [iv(a, b)];
const find = (all: ReturnType<typeof P>[], blocks = block(0, 600), min = 3, dur = 150) =>
  findEventWindows(all, blocks, { durationMin: dur, minOpportunities: min });

describe('overlapping passes (one operating station)', () => {
  it('fully simultaneous passes count once, not twice', () => {
    expect(selectNonOverlapping([P(10, 15, 60, SO50), P(10, 15, 70, 25544)])).toHaveLength(1);
  });
  it('partially overlapping passes: only a non-overlapping subset counts', () => {
    const sel = selectNonOverlapping([P(10, 16), P(14, 20), P(18, 24)]);
    expect(sel.map((s) => s.operating!.start)).toEqual([at(10), at(18)]); // 10-16 and 18-24
  });
  it('touching end-to-start counts as sequential (no setup gap)', () => {
    expect(selectNonOverlapping([P(10, 15), P(15, 20)])).toHaveLength(2);
  });
  it('finds the optimal count, not a greedy-by-start one', () => {
    // A long pass overlapping two short ones: best is the two short ones.
    expect(selectNonOverlapping([P(0, 30), P(5, 10), P(15, 20)])).toHaveLength(2);
  });
  it('among equal counts prefers more total operating time, then higher elevation', () => {
    const a = selectNonOverlapping([P(0, 10, 50), P(0, 12, 50)]);
    expect(a[0]!.operating!.end).toBe(at(12));
    const b = selectNonOverlapping([P(0, 10, 50), P(0, 10, 80, 25544)]);
    expect(b[0]!.eligibleMaxElevationDeg).toBe(80);
  });
  it('overlaps are shown as alternatives, not hidden', () => {
    const ev = evaluateWindow(iv(0, 150), [P(10, 15), P(12, 17, 55, 25544), P(30, 34)]);
    expect(ev.counted).toHaveLength(2);
    expect(ev.alternatives).toHaveLength(1);
  });
});

describe('event-boundary handling', () => {
  const win = iv(100, 250);
  it('counts a pass only if its whole operating interval fits inside the window', () => {
    const ev = evaluateWindow(win, [P(100, 104), P(246, 250), P(110, 114)]);
    expect(ev.counted).toHaveLength(3); // exactly flush with edges is inside
  });
  it('does not count an event-edge sliver even though the full pass peaks above the threshold', () => {
    // Operating interval 96..104 straddles the window start at 100 -> not counted, but reported as an edge case.
    const edge = P(96, 104);
    const ev = evaluateWindow(win, [edge, P(120, 124)]);
    expect(ev.counted).toHaveLength(1);
    expect(ev.edge).toHaveLength(1);
  });
  it('a pass whose peak is inside but whose operating interval leaves the window is not counted', () => {
    const ev = evaluateWindow(win, [P(246, 254)]);
    expect(ev.counted).toHaveLength(0);
  });
  it('never places a window outside the availability block', () => {
    const w = find([P(5, 9), P(30, 34), P(60, 64)], block(0, 150));
    w.forEach((x) => { expect(x.window.start).toBeGreaterThanOrEqual(at(0)); expect(x.window.end).toBeLessThanOrEqual(at(150)); });
    expect(w).toHaveLength(1);
  });
  it('requires the entire event to fit within availability: a 100-minute block cannot host a 150-minute event', () => {
    expect(find([P(5, 9), P(30, 34), P(60, 64)], block(0, 100))).toEqual([]);
  });
  it('does not span two separate availability blocks', () => {
    const w = find([P(10, 14), P(80, 84), P(200, 204)], [iv(0, 150), iv(160, 400)], 3);
    expect(w).toEqual([]);
  });
});

describe('repeated passes from one satellite', () => {
  it('counts each pass as an opportunity but reports distinct satellites separately', () => {
    const w = find([P(10, 14, 60, SO50), P(60, 64, 55, SO50), P(110, 114, 70, SO50)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.counted).toHaveLength(3);
    expect(w[0]!.distinctSatellites).toBe(1);
  });
});

describe('status gating of the minimum', () => {
  it('unknown, stale and activation-required passes never satisfy the minimum', () => {
    const w = find([P(10, 14), P(60, 64, 60, 25544, 'unknown-stale'), P(110, 114, 60, 40908, 'activation-required')]);
    expect(w).toEqual([]);
  });
  it('they do not appear anywhere in a qualifying window: not counted, not an alternative, not left-out', () => {
    const w = find([P(10, 14), P(60, 64), P(110, 114), P(120, 124, 60, 25544, 'unknown-stale')]);
    expect(w).toHaveLength(1);
    expect(w[0]!.counted).toHaveLength(3);
    const shown = [...w[0]!.counted, ...w[0]!.alternatives, ...w[0]!.edge, ...w[0]!.excluded];
    expect(shown.some((a) => a.noradId === 25544)).toBe(false);
    expect(w[0]!.distinctSatellites).toBe(1);
  });
  it('known-unavailable and eclipse-excluded passes do not inflate counts or scores', () => {
    const dead = P(20, 24, 80, 25544, 'known-unavailable');
    const eclipsed = assessed({ norad: AO91, rise: 56, set: 68, maxEl: 70, above: [60, 64], sun: [[56, 68, false, 70]] });
    const ev = evaluateWindow(iv(0, 150), [P(10, 14), dead, eclipsed]);
    expect(ev.counted).toHaveLength(1);
    expect(ev.totalOperatingMs).toBe(4 * MIN);
    // The eclipse-limited pass of an eligible satellite is listed as left out; the status-excluded one is not shown at all.
    expect(ev.excluded.map((x) => x.exclusion)).toEqual(['eclipse']);
    void status;
  });
});

describe('duplicate-window consolidation', () => {
  const trio = [P(60, 64), P(90, 94), P(120, 124)];
  it('does not return a window for every minute of slack: one tidy window per pass set', () => {
    const w = find(trio, block(0, 600));
    expect(w).toHaveLength(1);
    expect(w[0]!.counted).toHaveLength(3);
    // starts on a 15-minute boundary within the feasible range [124-150, 60]
    expect(((w[0]!.window.start - at(0)) / MIN) % 15).toBe(0);
    expect(w[0]!.window.start).toBeLessThanOrEqual(at(60));
    expect(w[0]!.window.end).toBeGreaterThanOrEqual(at(124));
  });
  it('folds substantially overlapping windows with different pass sets into the best one', () => {
    const w = find([...trio, P(150, 154), P(180, 184)], block(0, 600));
    // {60,90,120}, {90,120,150}, {120,150,180} overlap heavily; far fewer than 3 results
    expect(w.length).toBeLessThan(3);
    expect(w[0]!.similarWindows).toBeGreaterThan(0);
  });
  it('keeps distinct windows on different days', () => {
    const day = 24 * 60;
    const a = [P(60, 64), P(90, 94), P(120, 124)];
    const b = [P(day + 60, day + 64), P(day + 90, day + 94), P(day + 120, day + 124)];
    expect(find([...a, ...b], [iv(0, 600), iv(day, day + 600)])).toHaveLength(2);
  });
  it('tidyStart falls back to the midpoint when no aligned time fits', () => {
    expect(tidyStart(at(1), at(3))).toBe(at(2));
    expect(tidyStart(at(0) + 1000, at(30))).toBe(at(15));
  });
});

describe('ranking', () => {
  const day = 24 * 60;
  it('ranks by count, then total operating time, then elevations', () => {
    const four = [P(10, 14), P(40, 44), P(70, 74), P(100, 104)];
    const threeLong = [P(day + 10, day + 20), P(day + 40, day + 50), P(day + 70, day + 80)];
    const threeHighEl = [P(2 * day + 10, 2 * day + 20, 85), P(2 * day + 40, 2 * day + 50, 85), P(2 * day + 70, 2 * day + 80, 85)];
    const w = find([...threeHighEl, ...threeLong, ...four], [iv(0, 600), iv(day, day + 600), iv(2 * day, 2 * day + 600)]);
    expect(w.map((x) => x.counted.length)).toEqual([4, 3, 3]);
    expect(w[1]!.sumEligibleMaxElevationDeg).toBeGreaterThan(w[2]!.sumEligibleMaxElevationDeg);
    expect(w[1]!.window.start).toBeGreaterThanOrEqual(at(2 * day)); // the 85° day beats the 60° day on tie-break
  });
  it('the minimum is honoured, including 2', () => {
    expect(find([P(10, 14), P(60, 64)], block(0, 600), 2)).toHaveLength(1);
    expect(find([P(10, 14), P(60, 64)], block(0, 600), 3)).toEqual([]);
  });
});

describe('empty results explain themselves and never relax silently', () => {
  const inputs = {
    observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
    criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 3 },
    availability: { periods: {} as never, selected: {} as never }, range: iv(0, 600),
  };
  it('no passes at all: empty result, no suggestions that would help', () => {
    expect(find([], block(0, 600))).toEqual([]);
    const d = diagnose(inputs, [], new Map(), [], block(0, 600));
    expect(d.suggestions).toEqual([]);
    expect(d.eligiblePasses).toBe(0);
  });
  it('suggests fewer opportunities as TEXT only, never suggests counting unconfirmed satellites; the original result stays empty', () => {
    const all = [P(10, 14), P(60, 64), P(110, 114, 60, 25544, 'unknown-stale')];
    expect(find(all)).toEqual([]);
    const d = diagnose(inputs, [], new Map(), all, block(0, 600));
    expect(d.suggestions.map((s) => s.kind)).toContain('fewer-opportunities');
    expect(d.suggestions.map((s) => s.kind as string)).not.toContain('count-conditional');
    expect(find(all)).toEqual([]); // still empty: nothing was applied
  });
  it('detects that availability is the bottleneck', () => {
    const all = [P(10, 14), P(60, 64), P(110, 114)];
    const d = diagnose(inputs, [], new Map(), all, block(300, 320));
    expect(d.blocksLongEnough).toBe(0);
    expect(d.suggestions.map((s) => s.kind)).toContain('more-availability');
  });
});

describe('review fix: tidyStart and window containment (sub-second slack)', () => {
  it('tidyStart never returns a time outside [lo, hi]', () => {
    for (const [lo, hi] of [[1000000300, 1000000400], [5, 7], [1000000999, 1000000999]] as const) {
      const s = tidyStart(lo, hi);
      expect(s).toBeGreaterThanOrEqual(lo);
      expect(s).toBeLessThanOrEqual(hi);
    }
  });
  it('a window never starts before its availability block, even when the block starts mid-second', () => {
    const start = at(7) + 100; // e.g. a range clipped to "now", which has milliseconds
    const D = 120 * MIN;
    const trio = [P(10, 14), P(40, 44), P(70, 74)];
    const w = findEventWindows(trio, [{ start, end: start + D + 5000 }], { durationMin: 120, minOpportunities: 3 });
    expect(w).toHaveLength(1);
    expect(w[0]!.window.start).toBeGreaterThanOrEqual(start);
    expect(w[0]!.window.end).toBeLessThanOrEqual(start + D + 5000);
  });
});

/**
 * CHARACTERIZATION of the interval semantics as they are TODAY. These pin current behaviour so it can be
 * discussed and deliberately changed; they do not claim the behaviour is the final intent.
 * One interval per pass drives fit, overlap, ranking time and the timeline bar: the OPERATING interval =
 * (time at or above the elevation threshold) restricted to the eligible (sunlit, if required) part.
 */
describe('current interval semantics (characterization)', () => {
  it('a pass counts when only its above-threshold segment fits in the event, even though its rise and set are outside', () => {
    const wide = assessed({ rise: 5, set: 20, maxEl: 60, above: [11, 14] }); // rise 5 is before the event start (10)
    const late = assessed({ rise: 140, set: 170, maxEl: 60, above: [150, 154] }); // set 170 is after the event end (160)
    const ev = evaluateWindow(iv(10, 160), [wide, late]);
    expect(ev.counted).toHaveLength(2);
    expect(ev.edge).toHaveLength(0);
  });
  it('but a pass whose above-threshold segment crosses the event edge is not counted, however much of rise-to-set is inside', () => {
    const edge = assessed({ rise: 6, set: 20, maxEl: 60, above: [9, 13] }); // above-threshold starts before 10
    const ev = evaluateWindow(iv(10, 160), [edge]);
    expect(ev.counted).toHaveLength(0);
    expect(ev.edge).toHaveLength(1);
  });
  it('overlap is decided on the above-threshold segments only: passes whose rise-to-set overlap can both count', () => {
    const a = assessed({ rise: 20, set: 34, maxEl: 60, above: [24, 28] });
    const b = assessed({ rise: 30, set: 44, maxEl: 60, above: [31, 35] }); // b rises while a is still up, but the above-threshold times are disjoint
    expect(a.setMs).toBeGreaterThan(b.riseMs); // the whole passes overlap in time
    expect(selectNonOverlapping([a, b])).toHaveLength(2); // yet both count
  });
  it('and passes whose above-threshold segments overlap cannot both count', () => {
    const a = assessed({ rise: 20, set: 34, maxEl: 60, above: [24, 30] });
    const b = assessed({ rise: 22, set: 36, maxEl: 60, above: [28, 33] });
    expect(selectNonOverlapping([a, b])).toHaveLength(1);
  });
  it('for a sunlight-restricted repeater the scheduled interval is the sunlit part of the above-threshold segment, shorter than the time above the threshold', () => {
    const p = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, above: [3, 9], sun: [[0, 5, true, 55], [5, 12, false, 70]] });
    expect(p.aboveThreshold).toEqual(iv(3, 9)); // 6 min at or above the threshold (what the card headline shows)
    expect(p.operating).toEqual(iv(3, 5)); // 2 min actually scheduled and counted
  });
  it('a pass peaking below the threshold has no interval at all, so it is never selected', () => {
    const p = assessed({ rise: 0, set: 12, maxEl: 38, above: null });
    expect(p.operating).toBeNull();
    expect(evaluateWindow(iv(0, 150), [p]).counted).toHaveLength(0);
  });
});
