import { describe, expect, it } from 'vitest';
import { classifyStatus } from '../src/eligibility/status.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { AO91, MIN, SO50, activity, assessed, at, iv } from './factory.ts';

const NOW = Date.UTC(2027, 0, 9, 12, 0, 0);
const hoursAgo = (h: number) => Math.floor((NOW - h * 3_600_000) / 1000);
const file = (key: string, reports: StatusFile['satellites'][string]['reports']): StatusFile => ({
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(),
  satellites: { [key]: { reports } },
});
const so50 = { amsatStatusKey: 'SO-50_[FM]', interruptible: false, activationRequired: false };
const iss = { amsatStatusKey: 'ISS_[FM]', interruptible: true, activationRequired: false };

describe('operating status policy', () => {
  it('recent "Heard" with nothing newer = recently reported active, counts', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(5), 'H', 0], [hoursAgo(9), 'N', 1]]), NOW);
    expect(s.state).toBe('recently-reported-active');
    expect(s.countsTowardMinimum).toBe(true);
  });
  it('no reports in the window = unknown/stale, does not count', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(200), 'H', 0]]), NOW);
    expect(s.state).toBe('unknown-stale');
    expect(s.countsTowardMinimum).toBe(false);
  });
  it('a heard BEACON ("Telemetry Only") never establishes repeater use', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(2), 'T', 0]]), NOW);
    expect(s.countsTowardMinimum).toBe(false);
    expect(s.state).not.toBe('recently-reported-active');
  });
  it('an interruptible repeater (ISS) with nothing recent is treated like any other: no recent reports, does not count', () => {
    const s = classifyStatus(iss, file('ISS_[FM]', []), NOW);
    expect(s.state).toBe('unknown-stale');
    expect(s.detail).toBe('no-recent-reports');
    expect(s.countsTowardMinimum).toBe(false);
  });
  it('an interruptible repeater with a recent "Heard" counts, with the interruption caveat kept', () => {
    const s = classifyStatus(iss, file('ISS_[FM]', [[hoursAgo(3), 'H', 0]]), NOW);
    expect(s.state).toBe('recently-reported-active');
    expect(s.countsTowardMinimum).toBe(true);
    expect(s.interruptible).toBe(true);
    expect(s.activationRequired).toBe(false);
    expect(s.explanation).toMatch(/subject to interruptions/);
    expect(s.explanation).not.toMatch(/only at certain times|astronaut/i);
  });
  it('repeated negatives from several operators = known unavailable', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0], [hoursAgo(2), 'T', 1]]), NOW);
    expect(s.state).toBe('known-unavailable');
  });
  it('one negative report is only unconfirmed, not "known unavailable"', () => {
    expect(classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0]]), NOW).state).toBe('unknown-stale');
  });
  it('a newer negative after a positive is treated as conflicting (not counted)', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0], [hoursAgo(4), 'H', 1]]), NOW);
    expect(s.countsTowardMinimum).toBe(false);
    expect(s.explanation).toMatch(/Mixed reports/);
  });
  it('missing status data or a fetch error never counts', () => {
    expect(classifyStatus(so50, null, NOW).countsTowardMinimum).toBe(false);
    const bad: StatusFile = { ...file('x', []), satellites: { 'SO-50_[FM]': { reports: [], error: 'HTTP 500' } } };
    expect(classifyStatus(so50, bad, NOW).state).toBe('unknown-stale');
  });
  it('reports older than the window by one hour are ignored (freshness boundary)', () => {
    expect(classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(72.5), 'H', 0]]), NOW).state).toBe('unknown-stale');
    expect(classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(71.5), 'H', 0]]), NOW).state).toBe('recently-reported-active');
  });
});

describe('elevation threshold boundary', () => {
  it('a pass whose peak is below the threshold is not selected and has no permitted operating time', () => {
    const a = assessed({ rise: 0, set: 10, maxEl: 39.99, above: null });
    expect(a.operatingIntervals).toEqual([]);
    expect(a.operatingMs).toBe(0);
    expect(a.verdict).toBe('excluded');
    expect(a.exclusion).toBe('below-threshold');
  });
  it('a pass whose MAXIMUM elevation exactly reaches the threshold is selected, and its whole AOS-to-LOS pass is the envelope', () => {
    const a = assessed({ rise: 0, set: 10, maxEl: 40, above: [4.999, 5.001] });
    expect(a.verdict).toBe('eligible');
    expect(a.envelope).toEqual(iv(0, 10));
    expect(a.operatingIntervals).toEqual([iv(0, 10)]); // unrestricted: the full pass is permitted operating time
    expect(a.operatingMs).toBe(10 * MIN);
  });
  it('selection is by peak elevation: a pass with only seconds above the threshold still qualifies, and its duration is the full pass', () => {
    const a = assessed({ rise: 0, set: 12, maxEl: 40.2, above: [5.99, 6.01] });
    expect(a.verdict).toBe('eligible');
    expect(a.operatingMs).toBe(12 * MIN); // not the ~1 s above 40°
    expect(a.aboveThreshold).toEqual(iv(5.99, 6.01)); // kept only as information (Details)
  });
});

describe('sunlight (sunlight-dependent repeater: AO-91)', () => {
  const sunlit = (s: number, e: number, m: number): [number, number, boolean, number] => [s, e, true, m];
  const dark = (s: number, e: number, m: number): [number, number, boolean, number] => [s, e, false, m];
  it('fully illuminated pass is eligible with no eclipse note', () => {
    const a = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, above: [4, 8] });
    expect(a.sunlight).toBe('illuminated');
    expect(a.verdict).toBe('eligible');
    expect(a.eligibleMaxElevationDeg).toBe(70);
  });
  it('fully eclipsed pass is excluded and explained', () => {
    const a = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [dark(0, 12, 70)] });
    expect(a.sunlight).toBe('eclipsed');
    expect(a.verdict).toBe('excluded');
    expect(a.exclusion).toBe('eclipse');
    expect(a.reasons[0]).toMatch(/shadow/);
  });
  it('partial eclipse: the elevation is reached while sunlit, so the pass qualifies; permitted operating time is only the sunlit part', () => {
    // Pass peaks at minute 6 (70°) in shadow, but the sunlit part (0-5 min) reaches 55°, above the 40° minimum.
    const a = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, above: [3, 9], sun: [sunlit(0, 5, 55), dark(5, 12, 70)] });
    expect(a.sunlight).toBe('partly-eclipsed');
    expect(a.verdict).toBe('eligible');
    expect(a.envelope).toEqual(iv(0, 12)); // the full pass is the envelope ...
    expect(a.operatingIntervals).toEqual([iv(0, 5)]); // ... but only the sunlit part is permitted operating time
    expect(a.operatingMs).toBe(5 * MIN);
    expect(a.fullMaxElevationDeg).toBe(70);
    expect(a.eligibleMaxElevationDeg).toBe(55);
  });
  it('a high peak that occurs only in shadow does NOT qualify the pass, even if some sunlit time exists', () => {
    // Lit for 0-4 min but only reaching 39°; the 70° peak is in shadow.
    const a = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [sunlit(0, 4, 39), dark(4, 12, 70)] });
    expect(a.verdict).toBe('excluded');
    expect(a.exclusion).toBe('eclipse');
    expect(a.operatingIntervals).toEqual([]);
  });
  it('eclipsed time is never included in operating time, even for a qualifying pass with several sunlit pieces', () => {
    const a = assessed({ norad: AO91, rise: 0, set: 12, maxEl: 70, sun: [sunlit(0, 3, 45), dark(3, 6, 70), sunlit(6, 12, 60)] });
    expect(a.verdict).toBe('eligible');
    expect(a.operatingIntervals).toEqual([iv(0, 3), iv(6, 12)]);
    expect(a.operatingMs).toBe(9 * MIN); // 12 min pass minus 3 min in shadow
  });
  it('LOCAL darkness is irrelevant: only satellite sunlight matters (no local-time input exists)', () => {
    // An evening pass with the satellite lit is fully eligible regardless of the clock time.
    const a = assessed({ norad: AO91, rise: 3 * 60 + 5, set: 3 * 60 + 17, maxEl: 60, above: [3 * 60 + 9, 3 * 60 + 13] });
    expect(a.verdict).toBe('eligible');
    expect(at(0)).toBeLessThan(a.envelope.start);
  });
  it('a non-sunlight-dependent repeater ignores eclipse entirely', () => {
    const a = assessed({ norad: SO50, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [[0, 12, false, 70]] });
    expect(a.verdict).toBe('eligible');
    expect(activity(SO50).sunlightRequired).toBe(false);
    expect(activity(AO91).sunlightRequired).toBe(true);
  });
});

describe('verdicts from status', () => {
  const base = { rise: 0, set: 10, maxEl: 60 as number, above: [4, 6] as [number, number] };
  it.each([
    ['recently-reported-active', 'eligible'],
    ['unknown-stale', 'excluded'],
    ['activation-required', 'excluded'],
    ['known-unavailable', 'excluded'],
  ] as const)('%s -> %s', (st, verdict) => {
    expect(assessed(base, st).verdict).toBe(verdict);
  });
  it('every status other than recently-reported-active is excluded for lack of evidence (exclusion "status"), never "conditional"', () => {
    for (const st of ['unknown-stale', 'activation-required', 'known-unavailable'] as const) {
      const a = assessed(base, st);
      expect(a.exclusion).toBe('status');
      expect(a.reasons[0]).toMatch(st === 'activation-required' ? /requires a confirmed activation window/ : /no qualifying FM report/);
    }
  });
});

describe('FM-mode matching: other modes and beacons can never establish FM availability', () => {
  const fileWith = (satellites: StatusFile['satellites']): StatusFile => ({
    schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(), satellites,
  });
  const loud = Array.from({ length: 20 }, (_, i): [number, 'H', number] => [hoursAgo(1 + i), 'H', i]);

  it('lots of "Heard" reports under OTHER modes of the same satellite are ignored (classifier reads only the FM key)', () => {
    const f = fileWith({ 'ISS_[Crew]': { reports: loud }, 'ISS_[SSTV]': { reports: loud }, 'ISS_[VHF_Digi]': { reports: loud }, 'ISS_[FM]': { reports: [] } });
    const s = classifyStatus(iss, f, NOW);
    expect(s.countsTowardMinimum).toBe(false);
    expect(s.detail).toBe('no-recent-reports');
  });
  it('"Crew Active" inside the FM entry is ignored: it is not repeater evidence', () => {
    const s = classifyStatus(iss, file('ISS_[FM]', [[hoursAgo(1), 'C', 0], [hoursAgo(2), 'C', 1]]), NOW);
    expect(s.countsTowardMinimum).toBe(false);
    expect(s.positives).toBe(0);
  });
  it('beacon-only ("Telemetry Only") reports are counted as NOT working and reported separately', () => {
    const s = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'T', 0], [hoursAgo(2), 'T', 1], [hoursAgo(3), 'N', 2]]), NOW);
    expect(s.beaconOnly).toBe(2);
    expect(s.notHeard).toBe(1);
    expect(s.positives).toBe(0);
    expect(s.countsTowardMinimum).toBe(false);
  });
});

describe('three kinds of "no" are distinct in label, detail and wording', () => {
  const notHeard = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0]]), NOW);
  const mixed = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0], [hoursAgo(4), 'H', 1]]), NOW);
  const confirmed = classifyStatus(so50, file('SO-50_[FM]', [[hoursAgo(1), 'N', 0], [hoursAgo(2), 'N', 1]]), NOW);
  it('labels', () => {
    expect(notHeard.label).toBe('Not heard (unconfirmed)');
    expect(mixed.label).toBe('Mixed reports');
    expect(confirmed.label).toBe('Confirmed unavailable');
    expect(new Set([notHeard.label, mixed.label, confirmed.label]).size).toBe(3);
  });
  it('details and policy outcome', () => {
    expect([notHeard.detail, mixed.detail, confirmed.detail]).toEqual(['not-heard', 'mixed', 'confirmed-unavailable']);
    expect([notHeard.state, mixed.state, confirmed.state]).toEqual(['unknown-stale', 'unknown-stale', 'known-unavailable']);
    // None counts, and none is shown in results: all three are excluded from planning for lack of evidence.
    expect([notHeard, mixed, confirmed].every((s) => !s.countsTowardMinimum)).toBe(true);
  });
  it('an activation-required repeater is labelled as needing a confirmed activation window, whatever the reports say', () => {
    const act = { amsatStatusKey: 'IO-86_[FM]', interruptible: false, activationRequired: true };
    for (const reports of [[], [[hoursAgo(1), 'H', 0]], [[hoursAgo(1), 'N', 0]]] as StatusFile['satellites'][string]['reports'][]) {
      const s = classifyStatus(act, file('IO-86_[FM]', reports), NOW);
      expect(s.state).toBe('activation-required');
      expect(s.label).toBe('Activation window required (not confirmed)');
      expect(s.countsTowardMinimum).toBe(false);
    }
  });
});
