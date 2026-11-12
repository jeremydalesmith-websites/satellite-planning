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
