import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability, expandAvailability } from '../src/availability/availability.ts';
import type { AvailabilitySettings } from '../src/availability/availability.ts';
import { statusFileProblem } from '../src/data/load.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { classifyStatus } from '../src/eligibility/status.ts';
import { predictAll } from '../src/orbit/predict.ts';
import { computePlan, predictionThresholds, usableElements } from '../src/planner.ts';
import { recheckSavedEvent } from '../src/saved/recheck.ts';
import { isSavedEvent, savedSatelliteIds, snapshotEvent } from '../src/saved/saved.ts';
import { fmtSpan } from '../src/ui/format.ts';
import { ACTIVITIES } from '../src/catalog/catalog.ts';
import { T0, at, geom } from './factory.ts';
import { FIXTURE_DOWNLOAD_MS, elementsFixture, statusFixture } from './helpers.ts';

/**
 * Regression tests for the pre-beta review findings. Each documents a defect that was reproduced first.
 */
afterEach(() => { vi.useRealTimers(); });

const fullDay = () => {
  const av = emptyAvailability();
  for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
  av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
  return av;
};

describe('finding 1: a search must use the time it runs, and never recommend the past', () => {
  const heard = (key: string): [string, { reports: [number, 'H', number][] }] => [key, { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] }];
  const status: StatusFile = { schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString(), satellites: Object.fromEntries([heard('SO-50_[FM]')]) };
  const NOW = at(100); // the search runs 100 minutes after T0
  const run = (minOpportunities: number, range = { start: at(-600), end: at(600) }) =>
    computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities }, availability: fullDay(), range, selectedNoradIds: [27607] },
      { elements: elementsFixture, status },
      [
        geom({ norad: 27607, rise: 10, set: 20, maxEl: 60 }), // already finished
        geom({ norad: 27607, rise: 95, set: 108, maxEl: 60 }), // already under way at NOW
        geom({ norad: 27607, rise: 100, set: 110, maxEl: 60 }), // AOS exactly at NOW
        geom({ norad: 27607, rise: 130, set: 140, maxEl: 60 }), // in the future
      ],
      [], [], NOW,
    );

  it('past passes and already-started passes are not recommended, although the form\'s range began earlier', () => {
    const plan = run(1);
    const countedStarts = plan.windows.flatMap((w) => w.counted.map((c) => c.riseMs));
    expect(countedStarts.length).toBeGreaterThan(0);
    expect(Math.min(...countedStarts)).toBeGreaterThanOrEqual(NOW); // nothing that began before the search
    expect(plan.windows.every((w) => w.window.start >= NOW)).toBe(true);
  });
  it('a pass whose AOS is exactly the search time is still ahead of us and may be recommended; one already under way is not', () => {
    const rises = new Set(run(1).windows.flatMap((w) => w.counted.map((c) => c.riseMs)));
    expect(rises.has(at(100))).toBe(true);
    expect(rises.has(at(95))).toBe(false);
    expect(rises.has(at(10))).toBe(false);
  });
  it('multi-pass clusters cannot include a past pass either', () => {
    const plan = run(2);
    for (const w of plan.windows) expect(w.window.start).toBeGreaterThanOrEqual(NOW);
  });
  it('a range that has entirely passed yields no clusters (and no crash)', () => {
    const plan = run(1, { start: at(-600), end: at(50) });
    expect(plan.windows).toEqual([]);
  });
});

describe('findings 2 and 3: saved-event re-checks honour the saved satellite selection', () => {
  const now = FIXTURE_DOWNLOAD_MS;
  const observer = { latDeg: 47, lonDeg: -122, heightKm: 0 };
  const criteria = { minElevationDeg: 20, maxSpanMin: 180, minOpportunities: 2 };
  const SEL = [25544, 27607]; // ISS and SO-50 only
  const data = { elements: elementsFixture, status: statusFixture };
  const range = { start: now, end: now + 10 * 86_400_000 };
  const { usable, skipped } = usableElements(elementsFixture, now);
  const run = predictAll(usable.filter((s) => SEL.includes(s.noradId)), observer, range.start, range.end, { thresholdsDeg: predictionThresholds(20) });
  const plan = computePlan({ observer, timeZone: 'UTC', criteria, availability: fullDay(), range, selectedNoradIds: SEL }, data, run.passes, [], skipped, now);
  const where = { latDeg: observer.latDeg, lonDeg: observer.lonDeg };
  const save = (w: (typeof plan.windows)[number], selected?: readonly number[]) => snapshotEvent(w, where, 'UTC', criteria, plan.meta, now, 'ev', selected);
  const idsOf = (out: ReturnType<typeof recheckSavedEvent>) => {
    if (!out.ok) throw new Error(out.message);
    const e = out.recheck.evaluation;
    return new Set([...e.counted, ...e.alternatives, ...e.edge, ...e.excluded].map((a) => a.noradId));
  };

  it('fixture sanity: the scenario has clusters, and AO-91 is eligible but not selected', () => {
    expect(plan.windows.length).toBeGreaterThan(10);
    expect(plan.eligibility.find((e) => e.name === 'AO-91')!.eligible).toBe(true);
  });
  it('a new event persists the selected satellite IDs, and the loader accepts them', () => {
    const ev = save(plan.windows[0]!, SEL);
    expect(ev.selectedNoradIds).toEqual(SEL);
    expect(isSavedEvent(ev)).toBe(true);
    expect(isSavedEvent({ ...ev, selectedNoradIds: 'nope' })).toBe(false);
    expect(isSavedEvent({ ...ev, selectedNoradIds: undefined })).toBe(true); // older records without it stay valid
  });
  it('a re-check never introduces a satellite that was not selected (AO-91 was creeping in before the fix)', () => {
    let checked = 0;
    for (const w of plan.windows) {
      const out = recheckSavedEvent(save(w, SEL), data, now);
      for (const id of idsOf(out)) expect(SEL).toContain(id);
      if (out.ok) expect(out.recheck.changes.some((c) => /AO-91/.test(c.text))).toBe(false);
      checked++;
    }
    expect(checked).toBe(plan.windows.length);
  });
  it('positive control: with AO-91 selected, the same events do pick it up as a new opportunity', () => {
    const withAo = [...SEL, 43017];
    const picked = plan.windows.filter((w) => {
      const out = recheckSavedEvent(save(w, withAo), data, now);
      return out.ok && out.recheck.changes.some((c) => c.kind === 'added' && /AO-91/.test(c.text));
    });
    expect(picked.length).toBeGreaterThan(0);
  });
  it('records without selection metadata fall back to the satellites that were originally counted (conservative)', () => {
    const w = plan.windows.find((x) => recheckSavedEvent(save(x, [...SEL, 43017]), data, now).ok && (recheckSavedEvent(save(x, [...SEL, 43017]), data, now) as { recheck: { changes: { text: string }[] } }).recheck.changes.some((c) => /AO-91/.test(c.text)))!;
    const old = save(w); // no selection recorded
    expect(old.selectedNoradIds).toBeUndefined();
    const counted = new Set(old.original.counted.map((c) => c.noradId));
    expect(savedSatelliteIds(old)).toEqual(counted);
    const out = recheckSavedEvent(old, data, now);
    for (const id of idsOf(out)) expect(counted.has(id)).toBe(true);
    expect(counted.has(43017)).toBe(false); // AO-91 was never in this event
  });
  it('the "not included" note only names satellites in the saved selection (IO-86 no longer appears on unrelated events)', () => {
    const out = recheckSavedEvent(save(plan.windows[0]!, SEL), data, now);
    expect(out.ok && out.skippedNote).toBe(null);
    const withIo = recheckSavedEvent(save(plan.windows[0]!, [...SEL, 40931]), data, now); // IO-86's elements are too old in the fixture
    expect(withIo.ok && withIo.skippedNote).toMatch(/IO-86/); // positive control: still reported when it IS selected
  });
});

describe('finding 4: fall-back (repeated) wall times resolve the same way whenever the page is opened', () => {
  const NY = 'America/New_York';
  const setup = (from: number, to: number): AvailabilitySettings => {
    const a = emptyAvailability();
    a.periods.morning = { startMin: from, endMin: to };
    a.selected.morning[0] = true; // Sunday 2026-11-01 is the US fall-back day
    return a;
  };
  const range = { start: Date.UTC(2026, 9, 31, 12), end: Date.UTC(2026, 10, 2, 12) };
  const hours = (iv: { start: number; end: number }) => (iv.end - iv.start) / 3_600_000;

  it('01:30-06:00 on the fall-back day is the same 5.5 h whether "today" is in July or December', () => {
    const results = [Date.UTC(2026, 6, 15, 12), Date.UTC(2026, 11, 15, 12), Date.UTC(2026, 10, 1, 8)].map((when) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(when);
      const r = expandAvailability(setup(90, 360), NY, range);
      vi.useRealTimers();
      return r;
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(results[2]);
    expect(results[0]).toHaveLength(1);
    // the EARLIER instant of the repeated 01:30 (EDT = 05:30 UTC), as documented; 06:00 is EST = 11:00 UTC
    expect(results[0]![0]!.start).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(hours(results[0]![0]!)).toBe(5.5);
  });
  it('an END boundary inside the repeated hour also takes the earlier instant, independent of today\'s date', () => {
    const ends = [Date.UTC(2026, 6, 15, 12), Date.UTC(2026, 11, 15, 12)].map((when) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(when);
      const r = expandAvailability(setup(30, 90), NY, range);
      vi.useRealTimers();
      return r;
    });
    expect(ends[0]).toEqual(ends[1]);
    expect(ends[0]![0]!.end).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT, the first 01:30
    expect(hours(ends[0]![0]!)).toBe(1);
  });
  it('ordinary days and the spring-forward gap are unaffected', () => {
    const a = setup(90, 360);
    a.selected.morning[3] = true; // an ordinary Wednesday
    const r = expandAvailability(a, NY, { start: Date.UTC(2026, 9, 27), end: Date.UTC(2026, 9, 29) });
    expect(r).toHaveLength(1);
    expect(hours(r[0]!)).toBe(4.5);
    // 02:30-03:30 on the 2026-03-08 spring-forward day: 02:30 does not exist, so the real period is 03:00-03:30 (0.5 h)
    const gap = expandAvailability(setup(150, 210), NY, { start: Date.UTC(2026, 2, 7), end: Date.UTC(2026, 2, 9, 12) });
    expect(gap).toHaveLength(1);
    expect(hours(gap[0]!)).toBe(0.5);
  });
});

describe('finding 6: the displayed duration is computed from exact timestamps, display rounding stays separate', () => {
  it('a cluster of 7199.8 s displays as 2 h 00 min 00 s, never 2 h 00 min 01 s, so it cannot appear to break a 2 h limit', () => {
    const start = Date.UTC(2027, 0, 9, 10, 0, 0, 600);
    const end = Date.UTC(2027, 0, 9, 12, 0, 0, 400);
    expect(end - start).toBe(7_199_800);
    expect(fmtSpan(start, end)).toBe('2 h 00 min 00 s');
  });
  it('rounds the exact elapsed time to the nearest second', () => {
    expect(fmtSpan(0, 60_200)).toBe('1 min 00 s');
    expect(fmtSpan(0, 60_600)).toBe('1 min 01 s');
    expect(fmtSpan(400, 60_600)).toBe('1 min 00 s'); // exact 60.2 s (the outward-rounded bounds would have said 61 s)
  });
  it('never exceeds the selected maximum when the exact span does not', () => {
    const seconds = (s: string) => { const m = /(?:(\d+) h )?(?:(\d+) min )?(\d+) s/.exec(s)!; return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]); };
    for (const exactMs of [7_199_999, 7_199_500, 7_199_499, 7_200_000]) {
      expect(seconds(fmtSpan(1234, 1234 + exactMs))).toBeLessThanOrEqual(7200); // every exact span <= 2 h displays as <= 2 h
    }
  });
});

describe('finding 7: malformed status entries fail closed instead of crashing', () => {
  const base = { schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString() };
  it('statusFileProblem names what is wrong and accepts a well-formed file', () => {
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': { reports: [] } } })).toBeNull();
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': {} } })).toMatch(/SO-50_\[FM\].*reports/);
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': { reports: 'x' } } })).toMatch(/SO-50_\[FM\]/);
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': { reports: [[1, 'Z', 0]] } } })).toMatch(/SO-50_\[FM\]/);
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': { reports: [['a', 'H', 0]] } } })).toMatch(/SO-50_\[FM\]/);
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': null } })).toMatch(/SO-50_\[FM\]/);
    expect(statusFileProblem({ ...base, satellites: { 'SO-50_[FM]': { reports: [[1700000000, 'H', 2]] } } })).toBeNull();
  });
  it('the classifier never throws on a malformed entry; it treats it as no data', () => {
    const so50 = ACTIVITIES.find((a) => a.name === 'SO-50')!;
    for (const entry of [{}, { reports: null }, { reports: 'oops' }, { reports: 5 }]) {
      const file = { ...base, satellites: { 'SO-50_[FM]': entry } } as unknown as StatusFile;
      const s = classifyStatus(so50, file, T0);
      expect(s.countsTowardMinimum).toBe(false);
      expect(s.detail).toBe('no-data');
    }
  });
});
