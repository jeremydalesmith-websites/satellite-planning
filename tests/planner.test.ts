import { describe, expect, it } from 'vitest';
import { ACTIVITIES, bandConfigOf, describeBands, joinActivities } from '../src/catalog/catalog.ts';
import { predictAll } from '../src/orbit/predict.ts';
import { computePlan, predictionThresholds, usableElements } from '../src/planner.ts';
import { emptyAvailability } from '../src/availability/availability.ts';
import { FIXTURE_DOWNLOAD_MS, TEST_OBSERVER, el, elementsFixture, statusFixture } from './helpers.ts';
import { SatTracker } from '../src/orbit/predict.ts';
import { findPasses } from '../src/orbit/predict.ts';
import { sunPos, jday, ecfToLookAngles, degreesToRadians, eciToEcf, gstime } from 'satellite.js';
import { assessPass } from '../src/eligibility/assess.ts';
import { classifyStatus } from '../src/eligibility/status.ts';

const DAY = 86_400_000;

describe('catalog', () => {
  it('every activity has a band configuration and unique IDs', () => {
    expect(new Set(ACTIVITIES.map((a) => a.activityId)).size).toBe(ACTIVITIES.length);
    ACTIVITIES.forEach((a) => expect(['V/U', 'U/V']).toContain(a.bandConfig));
  });
  it('covers both V/U and U/V, with plain-language wording', () => {
    expect(ACTIVITIES.find((a) => a.name === 'SO-50')!.bandConfig).toBe('V/U');
    expect(ACTIVITIES.find((a) => a.name === 'AO-91')!.bandConfig).toBe('U/V');
    expect(describeBands(ACTIVITIES.find((a) => a.name === 'AO-91')!)).toBe('Transmit on 70 centimeters (435.25 MHz), listen on 2 meters (145.96 MHz)');
  });
  it('rejects frequencies outside 2 m / 70 cm and same-band entries', () => {
    expect(() => bandConfigOf(100, 435)).toThrow();
    expect(() => bandConfigOf(145, 146)).toThrow(/cross-band/);
  });
  it('fails loudly on a repeater with no satellite identity', () => {
    expect(() => joinActivities([], [ACTIVITIES[0] as never], [])).toThrow(/identity/);
  });
  it('only AO-91 is flagged sunlight-dependent (per the cited AMSAT note)', () => {
    expect(ACTIVITIES.filter((a) => a.sunlightRequired).map((a) => a.name)).toEqual(['AO-91']);
  });
});

describe('stale / unavailable data', () => {
  it('skips element sets older than the policy limit and says why (IO-86 fixture is ~116 days old)', () => {
    const { usable, skipped } = usableElements(elementsFixture, FIXTURE_DOWNLOAD_MS);
    expect(skipped.map((s) => s.name)).toEqual(['IO-86']);
    expect(skipped[0]!.reason).toMatch(/days old/);
    expect(usable.some((s) => s.noradId === 40931)).toBe(false);
  });
  it('if everything is stale nothing is usable; nothing is substituted', () => {
    expect(usableElements(elementsFixture, FIXTURE_DOWNLOAD_MS + 200 * DAY).usable).toEqual([]);
  });
  it('a satellite missing from the download is reported, not invented', () => {
    const f = { ...elementsFixture, sets: elementsFixture.sets.filter((s) => s.noradId !== 27607) };
    expect(usableElements(f, FIXTURE_DOWNLOAD_MS).skipped.some((s) => s.name === 'SO-50')).toBe(true);
  });
  it('with NO status data, no pass can count: results are empty and explain why', () => {
    const now = FIXTURE_DOWNLOAD_MS;
    const av = emptyAvailability();
    for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
    const { usable, skipped } = usableElements(elementsFixture, now);
    const range = { start: now, end: now + 7 * DAY };
    const run = predictAll(usable, TEST_OBSERVER, range.start, range.end, { thresholdsDeg: predictionThresholds(40) });
    const plan = computePlan(
      { observer: TEST_OBSERVER, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 2 }, availability: av, range },
      { elements: elementsFixture, status: null }, run.passes, run.errors, skipped, now,
    );
    expect(plan.assessments.some((a) => a.verdict === 'eligible')).toBe(false);
    expect(plan.windows).toEqual([]);
    expect(plan.consideredNoradIds).toEqual([]);
    expect(plan.assessments).toEqual([]);
    expect(plan.eligibility.every((e) => !e.eligible)).toBe(true);
    expect(plan.eligibility.filter((e) => !e.status.activationRequired).every((e) => /status data unavailable/.test(e.reason ?? ''))).toBe(true);
    expect(plan.meta.statusDownloadedAt).toBeNull();
  });
  it('with the real status fixture the finder matches a brute-force minute-by-minute reference', () => {
    const now = FIXTURE_DOWNLOAD_MS;
    const av = emptyAvailability();
    for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
    av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
    const { usable, skipped } = usableElements(elementsFixture, now);
    const range = { start: now, end: now + 14 * DAY };
    const D = 180 * 60_000;
    const run = predictAll(usable, TEST_OBSERVER, range.start, range.end, { thresholdsDeg: predictionThresholds(30) });
    const mk = (minOpp: number) => computePlan(
      { observer: TEST_OBSERVER, timeZone: 'UTC', criteria: { minElevationDeg: 30, durationMin: 180, minOpportunities: minOpp }, availability: av, range },
      { elements: elementsFixture, status: statusFixture }, run.passes, run.errors, skipped, now,
    );
    const plan2 = mk(2);

    // Independent reference: slide a 3 h window in 1-minute steps; count a maximum set of non-overlapping
    // operating intervals with a plain earliest-finish-first greedy (a different algorithm from the DP).
    const ops = plan2.assessments.filter((a) => a.verdict === 'eligible' && a.operating).map((a) => a.operating!).sort((x, y) => x.end - y.end);
    let best = 0;
    for (let s = range.start; s + D <= range.end; s += 60_000) {
      let last = -Infinity, n = 0;
      for (const o of ops) if (o.start >= s && o.end <= s + D && o.start >= last) { n++; last = o.end; }
      best = Math.max(best, n);
    }
    expect(best).toBeGreaterThanOrEqual(2);
    expect(Math.max(...plan2.windows.map((w) => w.counted.length))).toBe(best);
    // "no windows" at 3 is only reported if the reference agrees nothing has 3
    expect(mk(3).windows.length > 0).toBe(best >= 3);
    for (const w of plan2.windows) {
      w.counted.forEach((c) => expect(c.status.state).toBe('recently-reported-active'));
      for (let i = 1; i < w.counted.length; i++) expect(w.counted[i]!.operating!.start).toBeGreaterThanOrEqual(w.counted[i - 1]!.operating!.end);
    }
  });
});

describe('local night vs satellite sunlight (real orbit, ISS)', () => {
  /** Sun elevation at the observer: satellite.js sunPos + look angles toward the Sun. */
  function localSunElevationDeg(t: number): number {
    const d = new Date(t);
    const { rsun } = sunPos(jday(d));
    const k = 149_597_870.7;
    const ecf = eciToEcf({ x: rsun.x * k, y: rsun.y * k, z: rsun.z * k }, gstime(d));
    const look = ecfToLookAngles({ latitude: degreesToRadians(TEST_OBSERVER.latDeg), longitude: degreesToRadians(TEST_OBSERVER.lonDeg), height: 0 }, ecf);
    return (look.elevation * 180) / Math.PI;
  }
  const tr = new SatTracker(el(25544), TEST_OBSERVER);
  const passes = findPasses(el(25544), TEST_OBSERVER, FIXTURE_DOWNLOAD_MS, FIXTURE_DOWNLOAD_MS + 30 * DAY, { thresholdsDeg: [10] });

  it('there are passes in local darkness during which the satellite is fully in sunlight', () => {
    const found = passes.filter((p) => localSunElevationDeg(p.peakMs) < -12 && p.sunSegments.every((s) => s.lit));
    expect(found.length).toBeGreaterThan(0);
  });
  it('there are passes in local darkness during which the satellite is eclipsed (not simply "night = lit")', () => {
    const found = passes.filter((p) => localSunElevationDeg(p.peakMs) < -12 && p.sunSegments.every((s) => !s.lit));
    expect(found.length).toBeGreaterThan(0);
  });
  it('there are passes that go partly into eclipse (a lit/unlit transition during the pass)', () => {
    expect(passes.some((p) => p.sunSegments.length > 1)).toBe(true);
  });
  it('for a sunlight-dependent repeater, eligibility follows satellite sunlight, not local time', () => {
    // Apply the AO-91 rule to ISS geometry: lit-in-darkness passes stay eligible, eclipsed ones do not.
    const ao91 = ACTIVITIES.find((a) => a.name === 'AO-91')!;
    const st = classifyStatus({ amsatStatusKey: ao91.amsatStatusKey, interruptible: false, activationRequired: false }, { schema: 1, source: { name: '', url: '', license: '' }, downloadedAt: '', satellites: { [ao91.amsatStatusKey]: { reports: [[Math.floor(FIXTURE_DOWNLOAD_MS / 1000) - 60, 'H', 0]] } } }, FIXTURE_DOWNLOAD_MS);
    const withThr = findPasses(el(25544), TEST_OBSERVER, FIXTURE_DOWNLOAD_MS, FIXTURE_DOWNLOAD_MS + 30 * DAY, { thresholdsDeg: [30] });
    const dark = withThr.filter((p) => localSunElevationDeg(p.peakMs) < -12);
    const litDark = dark.find((p) => p.sunSegments.every((s) => s.lit))!;
    const shadowDark = dark.find((p) => p.sunSegments.every((s) => !s.lit))!;
    expect(assessPass({ ...litDark, noradId: ao91.noradId }, ao91, st, 30).verdict).toBe('eligible');
    const bad = assessPass({ ...shadowDark, noradId: ao91.noradId }, ao91, st, 30);
    expect(bad.verdict).toBe('excluded');
    expect(bad.exclusion).toBe('eclipse');
  });
  it('segments match a 2-second brute-force scan of sunlight transitions for every pass', () => {
    for (const p of passes) {
      let transitions = 0;
      let prev = tr.isSunlit(p.riseMs);
      for (let t = p.riseMs; t <= p.setMs; t += 2000) {
        const l = tr.isSunlit(t);
        if (l !== prev) transitions++;
        prev = l;
      }
      expect(p.sunSegments.length - 1).toBe(transitions);
    }
  });
  it('sunlit segments tile the pass exactly and alternate; maximum elevation never exceeds the pass maximum', () => {
    for (const p of passes) {
      expect(p.sunSegments[0]!.start).toBe(p.riseMs);
      expect(p.sunSegments.at(-1)!.end).toBe(p.setMs);
      p.sunSegments.forEach((s, i) => {
        if (i > 0) { expect(s.start).toBe(p.sunSegments[i - 1]!.end); expect(s.lit).toBe(!p.sunSegments[i - 1]!.lit); }
        expect(s.maxElevationDeg).toBeLessThanOrEqual(p.maxElevationDeg + 1e-6);
      });
    }
  });
  it('a segment boundary is a real lit/unlit transition (refined to well under a second)', () => {
    const p = passes.find((x) => x.sunSegments.length > 1)!;
    const b = p.sunSegments[0]!.end;
    expect(tr.isSunlit(b - 500)).toBe(p.sunSegments[0]!.lit);
    expect(tr.isSunlit(b + 500)).toBe(p.sunSegments[1]!.lit);
  });
});
