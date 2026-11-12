import { describe, expect, it } from 'vitest';
import { findEventWindows } from '../src/cluster/cluster.ts';
import { assessPass } from '../src/eligibility/assess.ts';
import { classifyStatus } from '../src/eligibility/status.ts';
import { recheckSavedEvent } from '../src/saved/recheck.ts';
import { SAVED_SCHEMA, isLegacySavedEvent, isSavedEvent, recheckEvent, snapshotEvent } from '../src/saved/saved.ts';
import type { PredictionMeta } from '../src/planner.ts';
import { SO50, activity, assessed, at, geom, iv } from './factory.ts';

const meta: PredictionMeta = { generatedAtMs: at(-1000), elementsDownloadedAt: new Date(at(-1000)).toISOString(), statusDownloadedAt: null, epochs: {} };
// a qualifying pass with full envelope [rise, set] minutes from T0
const P = (rise: number, set: number, o: Partial<Parameters<typeof assessed>[0]> = {}, st: Parameters<typeof assessed>[1] = 'recently-reported-active') =>
  assessed({ norad: SO50, rise, set, maxEl: 60, ...o }, st);
const criteria = { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 3 };
const original = [P(110, 120), P(150, 160, { norad: 25544 }), P(200, 210)];
const cluster = findEventWindows(original, [iv(0, 1000)], { maxSpanMin: 150, minOpportunities: 3 })[0]!;
const saved = snapshotEvent(cluster, { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'ev1');

describe('new saved events (schema 2) store the ACTUAL cluster interval', () => {
  it('snapshot stores the displayed cluster interval, location, timezone, criteria and counted passes', () => {
    expect(saved.schema).toBe(SAVED_SCHEMA);
    expect(saved.window).toEqual(iv(110, 210)); // earliest AOS to latest LOS: not padded to the 2.5 h maximum
    expect(saved.window).toEqual(cluster.window);
    expect(saved.location).toEqual({ latDeg: 1, lonDeg: 2 });
    expect(saved.timeZone).toBe('UTC');
    expect(saved.criteria).toEqual(criteria);
    expect(saved.original.counted).toHaveLength(3);
    expect(saved.original.counted[0]).toMatchObject({ riseMs: at(110), setMs: at(120), operatingMs: 10 * 60_000 });
    expect(saved.original.meta).toEqual(meta);
    expect(isSavedEvent(saved)).toBe(true);
  });
  it('a sunlight-limited pass is saved with its permitted operating time, not the full pass', () => {
    const ao = assessed({ norad: 43017, rise: 0, set: 12, maxEl: 70, sun: [[0, 5, true, 55], [5, 12, false, 70]] });
    const c = findEventWindows([ao], [iv(0, 600)], { maxSpanMin: 150, minOpportunities: 1 })[0]!;
    const ev = snapshotEvent(c, { latDeg: 1, lonDeg: 2 }, 'UTC', { ...criteria, minOpportunities: 1 }, meta, at(0), 'ev-ao');
    expect(ev.window).toEqual(iv(0, 12));
    expect(ev.original.counted[0]!.operatingMs).toBe(5 * 60_000);
    expect(ev.original.totalOperatingMs).toBe(5 * 60_000);
  });
});

describe('saved events stay fixed and report meaningful changes', () => {
  it('unchanged data: no changes, still meets the minimum', () => {
    const r = recheckEvent(saved, original);
    expect(r.changes).toEqual([]);
    expect(r.meetsMinimum).toBe(true);
  });
  it('the saved interval is never modified by a recheck, even when passes move away', () => {
    const before = JSON.stringify(saved);
    const moved = [P(110, 120), P(150, 160, { norad: 25544 }), P(300, 310)]; // third pass now far outside
    const r = recheckEvent(saved, moved);
    expect(JSON.stringify(saved)).toBe(before);
    expect(r.evaluation.window).toEqual(saved.window);
  });
  it('warns when the event no longer meets the requested minimum, and says which pass was lost', () => {
    const r = recheckEvent(saved, [P(110, 120), P(150, 160, { norad: 25544 })]);
    expect(r.meetsMinimum).toBe(false);
    expect(r.countNow).toBe(2);
    expect(r.changes.some((c) => c.kind === 'lost')).toBe(true);
  });
  it('reports time shifts of a minute or more, ignoring tiny ones', () => {
    const small = recheckEvent(saved, [P(110.3, 120.3), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(small.changes).toEqual([]); // 18 s
    const big = recheckEvent(saved, [P(113, 123), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(big.changes.map((c) => c.kind)).toEqual(['shifted']);
    expect(big.changes[0]!.text).toMatch(/3 min later/);
  });
  it('reports elevation changes', () => {
    const r = recheckEvent(saved, [P(110, 120, { maxEl: 52 }), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(r.changes.some((c) => c.kind === 'elevation' && /60° to 52°/.test(c.text))).toBe(true);
  });
  it('a pass whose satellite loses eligibility no longer counts, is flagged, and the saved interval does not move', () => {
    const before = JSON.stringify(saved.window);
    const r = recheckEvent(saved, [P(110, 120, {}, 'unknown-stale'), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(r.meetsMinimum).toBe(false);
    expect(r.countNow).toBe(2);
    expect(r.changes[0]!.kind).toBe('eligibility');
    expect(r.changes[0]!.text).toMatch(/no qualifying FM report in the last 72 hours/);
    expect(r.lostEligibility).toHaveLength(1);
    expect(r.lostEligibility[0]).toMatchObject({ noradId: SO50, name: 'SO-50' });
    expect(JSON.stringify(saved.window)).toBe(before);
    expect(r.evaluation.window).toEqual(saved.window);
  });
  it('a pass whose satellite is known-unavailable is flagged the same way (evidence missing, not "inactive")', () => {
    const r = recheckEvent(saved, [P(110, 120, {}, 'known-unavailable'), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(r.changes[0]!.kind).toBe('eligibility');
    expect(r.lostEligibility[0]!.reason).not.toMatch(/inactive/i);
  });
  it('when no status data can be loaded, eligibility is NOT silently kept: every saved opportunity is flagged', () => {
    const noData = (o: Parameters<typeof assessed>[0]) => assessPass(geom(o), activity(o.norad ?? SO50), classifyStatus(activity(o.norad ?? SO50), null, at(0)), 40);
    const all = [
      noData({ norad: SO50, rise: 110, set: 120, maxEl: 60 }),
      noData({ norad: 25544, rise: 150, set: 160, maxEl: 60 }),
      noData({ norad: SO50, rise: 200, set: 210, maxEl: 60 }),
    ];
    const r = recheckEvent(saved, all);
    expect(r.countNow).toBe(0);
    expect(r.lostEligibility).toHaveLength(3);
    expect(r.lostEligibility.every((l) => /status data unavailable, so eligibility cannot be established/.test(l.reason))).toBe(true);
    expect(r.meetsMinimum).toBe(false);
  });
  it('recheckSavedEvent without loaded data says eligibility could not be re-confirmed', () => {
    const out = recheckSavedEvent(saved, null, at(0));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/could not be re-confirmed/);
  });
  it('reports a newly available opportunity inside the saved interval', () => {
    const r = recheckEvent(saved, [...original, P(125, 135, { norad: 40908 })]);
    expect(r.changes.some((c) => c.kind === 'added')).toBe(true);
    expect(r.countNow).toBe(4);
  });
  it('recomputation jitter of tens of milliseconds at the saved edges is NOT drift (a fresh save re-checks clean)', () => {
    const jitter = (p: ReturnType<typeof P>, dRise: number, dSet: number) => ({ ...p, riseMs: p.riseMs + dRise, setMs: p.setMs + dSet, envelope: { start: p.riseMs + dRise, end: p.setMs + dSet } });
    // first pass starts 37 ms EARLIER and last pass ends 36 ms LATER than when saved: exactly the predictor's refinement jitter
    const recomputed = [jitter(original[0]!, -37, -20), original[1]!, jitter(original[2]!, 15, 36)];
    const r = recheckEvent(saved, recomputed);
    expect(r.changes).toEqual([]);
    expect(r.countNow).toBe(3);
    expect(r.meetsMinimum).toBe(true);
  });
  it('but a real slip of a few seconds beyond the tolerance is still flagged', () => {
    const slip = { ...original[2]!, setMs: original[2]!.setMs + 5_000, envelope: { start: original[2]!.riseMs, end: original[2]!.setMs + 5_000 } };
    const r = recheckEvent(saved, [original[0]!, original[1]!, slip]);
    expect(r.changes.some((c) => c.kind === 'lost' && /extends outside the saved interval/.test(c.text))).toBe(true);
    expect(r.countNow).toBe(2);
  });
  it('drift: a pass that slides so its FULL pass crosses the saved edge is flagged as lost, with the reason, and the interval is not followed', () => {
    const r = recheckEvent(saved, [P(110, 120), P(150, 160, { norad: 25544 }), P(205, 215)]); // now ends after the saved end (210)
    expect(r.changes.find((c) => c.kind === 'lost')!.text).toMatch(/extends outside the saved interval/);
    expect(r.evaluation.window).toEqual(saved.window);
    expect(r.countNow).toBe(2);
  });
  it('drift at the start is flagged the same way', () => {
    const r = recheckEvent(saved, [P(105, 115), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(r.changes.some((c) => c.kind === 'lost' && /extends outside the saved interval/.test(c.text))).toBe(true);
  });
  it('does not match a different satellite or a pass hours away', () => {
    const r = recheckEvent(saved, [P(110, 120, { norad: 40908 }), P(150, 160, { norad: 25544 }), P(200, 210)]);
    expect(r.changes.some((c) => c.kind === 'lost')).toBe(true);
  });
});

describe('existing (schema 1) saved events are never reinterpreted', () => {
  const legacy = { schema: 1, id: 'old', savedAtMs: 1, window: { start: 1, end: 2 }, location: { latDeg: 1, lonDeg: 2 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 3 }, original: { counted: [], distinctSatellites: 0, totalOperatingMs: 0, meta } };
  it('are not accepted by the current loader and are recognised only so they can be left alone', () => {
    expect(isSavedEvent(legacy)).toBe(false);
    expect(isLegacySavedEvent(legacy)).toBe(true);
    expect(isLegacySavedEvent(saved)).toBe(false);
    expect(isLegacySavedEvent({ nonsense: true })).toBe(false);
  });
});
