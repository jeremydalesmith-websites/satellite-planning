import { describe, expect, it } from 'vitest';
import { recheckEvent, snapshotEvent } from '../src/saved/saved.ts';
import { evaluateWindow } from '../src/cluster/cluster.ts';
import type { PredictionMeta } from '../src/planner.ts';
import { recheckSavedEvent } from '../src/saved/recheck.ts';
import { assessPass } from '../src/eligibility/assess.ts';
import { classifyStatus } from '../src/eligibility/status.ts';
import { SO50, activity, assessed, at, geom, iv } from './factory.ts';

const meta: PredictionMeta = { generatedAtMs: at(-1000), elementsDownloadedAt: new Date(at(-1000)).toISOString(), statusDownloadedAt: null, epochs: {} };
const P = (a: number, b: number, o: Partial<Parameters<typeof assessed>[0]> = {}, st: Parameters<typeof assessed>[1] = 'recently-reported-active') =>
  assessed({ norad: SO50, rise: a - 4, set: b + 4, maxEl: 60, above: [a, b], ...o }, st);
const criteria = { minElevationDeg: 40, durationMin: 150, minOpportunities: 3 };
const window = iv(100, 250);
const original = [P(110, 114), P(150, 154, { norad: 25544 }), P(200, 204)];
const saved = snapshotEvent(evaluateWindow(window, original), { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'ev1');

describe('saved events stay fixed and report meaningful changes', () => {
  it('snapshot stores the fixed window, location, timezone, criteria and original opportunities', () => {
    expect(saved.window).toEqual(window);
    expect(saved.location).toEqual({ latDeg: 1, lonDeg: 2 });
    expect(saved.timeZone).toBe('UTC');
    expect(saved.criteria).toEqual(criteria);
    expect(saved.original.counted).toHaveLength(3);
    expect(saved.original.meta).toEqual(meta);
  });
  it('unchanged data: no changes, still meets minimum', () => {
    const r = recheckEvent(saved, original);
    expect(r.changes).toEqual([]);
    expect(r.meetsMinimum).toBe(true);
  });
  it('the saved window is never modified by a recheck, even when passes move away', () => {
    const before = JSON.stringify(saved);
    const moved = [P(110, 114), P(150, 154, { norad: 25544 }), P(300, 304)]; // third pass now outside window
    const r = recheckEvent(saved, moved);
    expect(JSON.stringify(saved)).toBe(before);
    expect(r.evaluation.window).toEqual(window);
  });
  it('warns when the event no longer meets the requested minimum, and says which pass was lost', () => {
    const r = recheckEvent(saved, [P(110, 114), P(150, 154, { norad: 25544 })]);
    expect(r.meetsMinimum).toBe(false);
    expect(r.countNow).toBe(2);
    expect(r.changes.some((c) => c.kind === 'lost')).toBe(true);
  });
  it('reports time shifts of a minute or more, ignoring tiny ones', () => {
    const small = recheckEvent(saved, [P(110.3, 114.3), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(small.changes).toEqual([]); // 18 s
    const big = recheckEvent(saved, [P(113, 117), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(big.changes.map((c) => c.kind)).toEqual(['shifted']);
    expect(big.changes[0]!.text).toMatch(/3 min later/);
  });
  it('reports elevation changes and status changes', () => {
    const r = recheckEvent(saved, [P(110, 114, { maxEl: 52 }), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(r.changes.some((c) => c.kind === 'elevation' && /60° to 52°/.test(c.text))).toBe(true);
  });
  it('a pass whose satellite loses eligibility no longer counts, is flagged, and the saved window does not move', () => {
    const before = JSON.stringify(saved.window);
    const r = recheckEvent(saved, [P(110, 114, {}, 'unknown-stale'), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(r.meetsMinimum).toBe(false);
    expect(r.countNow).toBe(2);
    expect(r.changes[0]!.kind).toBe('eligibility');
    expect(r.changes[0]!.text).toMatch(/no qualifying FM report in the last 72 hours/);
    expect(r.lostEligibility).toHaveLength(1);
    expect(r.lostEligibility[0]).toMatchObject({ noradId: SO50, name: 'SO-50' });
    expect(JSON.stringify(saved.window)).toBe(before);
    expect(r.evaluation.window).toEqual(window);
  });
  it('a pass whose satellite is known-unavailable is flagged the same way (evidence missing, not "inactive")', () => {
    const r = recheckEvent(saved, [P(110, 114, {}, 'known-unavailable'), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(r.changes[0]!.kind).toBe('eligibility');
    expect(r.lostEligibility).toHaveLength(1);
    expect(r.lostEligibility[0]!.reason).not.toMatch(/inactive/i);
  });
  it('when no status data can be loaded, eligibility is NOT silently kept: every saved opportunity is flagged', () => {
    const noData = (o: Parameters<typeof assessed>[0]) => assessPass(geom(o), activity(o.norad ?? SO50), classifyStatus(activity(o.norad ?? SO50), null, at(0)), 40);
    const all = [
      noData({ norad: SO50, rise: 106, set: 118, maxEl: 60, above: [110, 114] }),
      noData({ norad: 25544, rise: 146, set: 158, maxEl: 60, above: [150, 154] }),
      noData({ norad: SO50, rise: 196, set: 208, maxEl: 60, above: [200, 204] }),
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
  it('reports a newly available opportunity', () => {
    const r = recheckEvent(saved, [...original, P(225, 229, { norad: 40908 })]);
    expect(r.changes.some((c) => c.kind === 'added')).toBe(true);
    expect(r.countNow).toBe(4);
  });
  it('a pass that shifts partly outside the event is reported as lost with the reason', () => {
    const orig = [P(110, 114), P(150, 154, { norad: 25544 }), P(240, 244)];
    const sv = snapshotEvent(evaluateWindow(window, orig), { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'ev2');
    const r = recheckEvent(sv, [P(110, 114), P(150, 154, { norad: 25544 }), P(247, 255)]); // slid across the 250 end
    expect(r.changes.find((c) => c.kind === 'lost')!.text).toMatch(/extends past the event/);
  });
  it('does not match a different satellite or a pass hours away', () => {
    const r = recheckEvent(saved, [P(110, 114, { norad: 40908 }), P(150, 154, { norad: 25544 }), P(200, 204)]);
    expect(r.changes.some((c) => c.kind === 'lost')).toBe(true);
  });
});
