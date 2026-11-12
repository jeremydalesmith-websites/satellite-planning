import { describe, expect, it } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { DEFAULT_SELECTED_NORAD_IDS, consideredIds, evaluateEligibility } from '../src/eligibility/eligibility.ts';
import { classifyStatus } from '../src/eligibility/status.ts';
import { assessPass } from '../src/eligibility/assess.ts';
import { ACTIVITIES, FM_REPEATERS, RESTRICTIONS, SATELLITES, SOURCES, joinActivities } from '../src/catalog/catalog.ts';
import { computePlan } from '../src/planner.ts';
import { elementsFixture } from './helpers.ts';
import { T0, at, geom } from './factory.ts';

/** Strict operational eligibility: a recent positive report for the exact FM entry, evaluated against NOW. */
const NOW = Date.UTC(2027, 0, 9, 12, 0, 0);
const secAgo = (s: number) => Math.floor((NOW - s * 1000) / 1000);
const hAgo = (h: number) => secAgo(h * 3600);
const mkFile = (satellites: StatusFile['satellites']): StatusFile => ({
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(), satellites,
});
const only = (key: string, reports: StatusFile['satellites'][string]['reports']) => mkFile({ [key]: { reports } });
const byName = (f: StatusFile | null, now = NOW) => Object.fromEntries(evaluateEligibility(f, now).map((e) => [e.name, e]));

describe('72-hour rule (evaluated against the current time)', () => {
  it('no positive FM report in the last 72 h = not eligible; the reason is missing evidence, never "inactive"', () => {
    const e = byName(only('SO-50_[FM]', []))['SO-50']!;
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('no qualifying FM report in the last 72 hours');
    expect(e.reason).not.toMatch(/inactive|dead|offline/i);
  });
  it('a satellite absent from the status file is not eligible', () => {
    expect(byName(mkFile({}))['TEVEL2-1']!.eligible).toBe(false);
  });
  it('a recent "Heard" with nothing newer makes it eligible', () => {
    expect(byName(only('SO-50_[FM]', [[hAgo(5), 'H', 0]]))['SO-50']!.eligible).toBe(true);
  });
  it('boundary: a report 72 h old still qualifies; one second older does not', () => {
    expect(byName(only('SO-50_[FM]', [[secAgo(72 * 3600), 'H', 0]]))['SO-50']!.eligible).toBe(true);
    expect(byName(only('SO-50_[FM]', [[secAgo(72 * 3600 + 1), 'H', 0]]))['SO-50']!.eligible).toBe(false);
  });
  it('is measured back from the time of evaluation, not from the data download time', () => {
    const f = only('SO-50_[FM]', [[hAgo(5), 'H', 0]]);
    expect(byName(f, NOW)['SO-50']!.eligible).toBe(true);
    expect(byName(f, NOW + 100 * 3_600_000)['SO-50']!.eligible).toBe(false); // evaluated 100 h later, same downloaded file
  });
  it('without any status data eligibility cannot be established, and the reason says so', () => {
    const e = byName(null)['SO-50']!;
    expect(e.eligible).toBe(false);
    expect(e.reason).toBe('status data unavailable, so eligibility cannot be established');
  });
});

describe('beacon, telemetry and other-mode reports never qualify', () => {
  const loud = Array.from({ length: 20 }, (_, i): [number, 'H', number] => [hAgo(1 + i), 'H', i]);
  it('"Telemetry Only" (beacon) in the FM entry does not qualify', () => {
    expect(byName(only('SO-50_[FM]', [[hAgo(1), 'T', 0]]))['SO-50']!.eligible).toBe(false);
  });
  it('plenty of "Heard" under other modes of the same satellite does not qualify', () => {
    const f = mkFile({ 'ISS_[SSTV]': { reports: loud }, 'ISS_[Crew]': { reports: loud }, 'ISS_[VHF_Digi]': { reports: loud }, 'ISS_[FM]': { reports: [] } });
    expect(byName(f)['ISS']!.eligible).toBe(false);
  });
  it('"Crew Active" inside the FM entry does not qualify', () => {
    expect(byName(only('ISS_[FM]', [[hAgo(1), 'C', 0]]))['ISS']!.eligible).toBe(false);
  });
});

describe('newer negative and mixed reports are treated exactly as before', () => {
  const so50 = { amsatStatusKey: 'SO-50_[FM]', interruptible: false, activationRequired: false };
  it('a newer negative after a positive is "mixed" and not eligible', () => {
    const f = only('SO-50_[FM]', [[hAgo(1), 'N', 0], [hAgo(4), 'H', 1]]);
    expect(classifyStatus(so50, f, NOW).detail).toBe('mixed');
    const e = byName(f)['SO-50']!;
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain('followed by a newer “Not Heard” report (mixed evidence)');
  });
  it('a positive newer than the last negative still qualifies', () => {
    expect(byName(only('SO-50_[FM]', [[hAgo(4), 'N', 0], [hAgo(1), 'H', 1]]))['SO-50']!.eligible).toBe(true);
  });
  it('repeated negatives are not eligible', () => {
    expect(byName(only('SO-50_[FM]', [[hAgo(1), 'N', 0], [hAgo(2), 'T', 1]]))['SO-50']!.eligible).toBe(false);
  });
});

describe('diagnostic wording distinguishes three kinds of "no" (wording only: eligibility is unchanged)', () => {
  const reason = (reports: StatusFile['satellites'][string]['reports']) => byName(only('AO-123_[FM]', reports))['AO-123']!;
  const noPositive = reason([]);
  const afterNotHeard = reason([[hAgo(30), 'H', 0], [hAgo(20), 'H', 1], [hAgo(2), 'N', 2]]);
  const afterBeacon = reason([[hAgo(30), 'H', 0], [hAgo(20), 'H', 1], [hAgo(2), 'T', 2]]);

  it('1. no recent positive FM report', () => {
    expect(noPositive.reason).toBe('no qualifying FM report in the last 72 hours');
  });
  it('2. recent positive reports superseded by a newer "Not Heard" report: mixed evidence, naming Not Heard', () => {
    expect(afterNotHeard.reason).toBe('recent positive FM reports were followed by a newer “Not Heard” report (mixed evidence), so they are not treated as current evidence');
  });
  it('3. recent positive reports superseded by a newer beacon/telemetry-only report: mixed evidence, naming the beacon', () => {
    expect(afterBeacon.reason).toBe('recent positive FM reports were followed by a newer beacon/telemetry-only report (mixed evidence), so they are not treated as current evidence');
  });
  it('the three are distinct, and none of them is eligible (the policy is unchanged)', () => {
    expect(new Set([noPositive.reason, afterNotHeard.reason, afterBeacon.reason]).size).toBe(3);
    expect([noPositive, afterNotHeard, afterBeacon].map((e) => e.eligible)).toEqual([false, false, false]);
  });
  it('names the NEWEST contrary report: Not Heard then a later beacon-only report is described as beacon-only, and the reverse as Not Heard', () => {
    expect(reason([[hAgo(30), 'H', 0], [hAgo(5), 'N', 1], [hAgo(2), 'T', 2]]).reason).toContain('beacon/telemetry-only');
    expect(reason([[hAgo(30), 'H', 0], [hAgo(5), 'T', 1], [hAgo(2), 'N', 2]]).reason).toMatch(/“Not Heard”/);
  });
  it('matches an AO-123-like history (many Heard, then several beacon-only and one Not Heard, newest beacon-only)', () => {
    const history: StatusFile['satellites'][string]['reports'] = [
      ...Array.from({ length: 10 }, (_, i): [number, 'H', number] => [hAgo(20 + i), 'H', i]),
      [hAgo(11.5), 'N', 20], [hAgo(11), 'T', 21], [hAgo(9), 'T', 22], [hAgo(4.5), 'T', 23],
    ];
    const e = reason(history);
    expect(e.eligible).toBe(false);
    expect(e.reason).toContain('newer beacon/telemetry-only report (mixed evidence)');
  });
  it('never describes reports as outvoted or implies that a "Not Heard" report proves a failure', () => {
    const bad = /outvot|fail|dead|broken|offline|inactive|not working|is off|unavailable/i;
    for (const e of [noPositive, afterNotHeard, afterBeacon]) expect(e.reason).not.toMatch(bad);
    // the longer explanation (shown in details) says the same thing
    expect(afterNotHeard.status.explanation).toMatch(/mixed evidence, not proof the repeater is off/);
    expect(afterNotHeard.status.explanation).not.toMatch(/not working/);
  });
});

describe('operating-pattern classification: interruptible vs activation-required (reviewed per satellite)', () => {
  const names = (pred: (a: (typeof ACTIVITIES)[number]) => boolean) => ACTIVITIES.filter(pred).map((a) => a.name).sort();
  const loud = (key: string) => mkFile({ [key]: { reports: Array.from({ length: 20 }, (_, i): [number, 'H', number] => [hAgo(1 + i), 'H', i]) } });
  const planWith = (status: StatusFile, norad: number) =>
    computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 1 }, availability: fullDay(), range: { start: at(-120), end: at(400) }, selectedNoradIds: [norad] },
      { elements: elementsFixture, status },
      [geom({ norad, rise: 56, set: 68, maxEl: 70, above: [60, 64] })], [], [], T0,
    );

  it('each catalog entry carries an explicit classification (no shared boolean)', () => {
    expect(names((a) => a.interruptible)).toEqual(['ISS']);
    expect(names((a) => a.activationRequired)).toEqual(['CAS-3H', 'IO-86', 'PO-101', 'RS95S']);
    expect(names((a) => a.sunlightRequired)).toEqual(['AO-91']);
    expect(names((a) => a.interruptible && a.activationRequired)).toEqual([]); // the two classifications never overlap
  });
  it('the ISS entry cites ARISS, shows the "Subject to ISS operations" badge, and never says only astronauts operate it', () => {
    const iss = ACTIVITIES.find((a) => a.name === 'ISS')!;
    expect(iss.interruptibleBadge).toBe('Subject to ISS operations');
    const r = iss.restrictions.find((x) => x.kind === 'interruptible')!;
    expect(r.source.url).toMatch(/ariss\.org/);
    expect(r.text).toMatch(/full time/);
    expect(r.text).not.toMatch(/only when astronauts|astronauts (are )?actively operat|switched on by the crew/i);
  });

  it('ISS qualifies from a recent positive FM report alone, with no per-pass activation announcement', () => {
    const f = only('ISS_[FM]', [[hAgo(3), 'H', 0]]);
    const e = byName(f)['ISS']!;
    expect(e.eligible).toBe(true);
    expect(e.status.interruptible).toBe(true);
    expect(e.status.activationRequired).toBe(false);
    const plan = planWith(f, 25544);
    expect(plan.consideredNoradIds).toEqual([25544]);
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0]!.counted[0]!.name).toBe('ISS');
  });
  it('ISS still needs recent positive evidence: no recent report, or a newer negative, excludes it', () => {
    expect(byName(only('ISS_[FM]', []))['ISS']!.eligible).toBe(false);
    expect(byName(only('ISS_[FM]', [[hAgo(1), 'N', 0], [hAgo(4), 'H', 1]]))['ISS']!.reason).toMatch(/followed by a newer “Not Heard” report/);
    expect(planWith(only('ISS_[FM]', []), 25544).windows).toEqual([]);
  });

  it.each([['CAS-3H', 40908], ['IO-86', 40931], ['PO-101', 43678], ['RS95S', 67291]])(
    '%s (activation required) cannot qualify from plenty of recent "Heard" reports alone',
    (name, norad) => {
      const key = `${name}_[FM]`;
      const e = byName(loud(key))[name]!;
      expect(e.eligible).toBe(false);
      expect(e.status.positives).toBeGreaterThan(0); // the reports are there ...
      expect(e.status.state).toBe('activation-required'); // ... and still do not qualify it
      expect(e.reason).toMatch(/requires a confirmed activation window covering the pass, and none is available/);
      expect(e.reason).not.toMatch(/inactive|dead|offline/i);
      expect(e.note).toBeTruthy(); // the cited catalog note is shown in the diagnostics

      const plan = planWith(loud(key), norad); // even when explicitly selected
      expect(plan.consideredNoradIds).toEqual([]);
      expect(plan.assessments).toEqual([]);
      expect(plan.windows).toEqual([]);
    },
  );
  it('the exclusion is also what a saved-event re-check would report', () => {
    const e = byName(loud('IO-86_[FM]'))['IO-86']!;
    expect(e.status.countsTowardMinimum).toBe(false);
    expect(e.status.explanation).toMatch(/separately activated/);
  });
  it('normal repeaters (SO-50) are unaffected: a recent report qualifies them', () => {
    expect(byName(loud('SO-50_[FM]'))['SO-50']!.eligible).toBe(true);
  });
});

describe('a recent positive report is necessary, not sufficient (sunlight is enforced independently)', () => {
  it('sunlight restriction applies even when the report requirement is met (eclipsed pass excluded; lit pass kept)', () => {
    const ao91 = ACTIVITIES.find((a) => a.name === 'AO-91')!;
    const st = classifyStatus(ao91, only('AO-91_[FM]', [[hAgo(1), 'H', 0]]), NOW);
    expect(st.countsTowardMinimum).toBe(true);
    expect(assessPass(geom({ norad: 43017, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [[0, 12, false, 70]] }), ao91, st, 40).exclusion).toBe('eclipse');
    expect(assessPass(geom({ norad: 43017, rise: 0, set: 12, maxEl: 70, above: [4, 8] }), ao91, st, 40).verdict).toBe('eligible');
  });
  it('sunlight is independent of the operating pattern: it is enforced on a repeater that is also interruptible', () => {
    // Hypothetical catalog row: AO-91 additionally flagged interruptible. Neither classification cancels the other.
    const both = joinActivities(SATELLITES, FM_REPEATERS, [
      ...RESTRICTIONS,
      { noradId: 43017, kind: 'interruptible', badge: 'test', text: 't', source: SOURCES.arissStatus, asOf: '2026-11-04' },
    ]).find((a) => a.noradId === 43017)!;
    expect(both.sunlightRequired && both.interruptible).toBe(true);
    const st = classifyStatus(both, only('AO-91_[FM]', [[hAgo(1), 'H', 0]]), NOW);
    expect(st.countsTowardMinimum).toBe(true);
    expect(assessPass(geom({ norad: 43017, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [[0, 12, false, 70]] }), both, st, 40).exclusion).toBe('eclipse');
  });
  it('and being interruptible does not make a non-sunlight repeater sunlight-restricted (ISS in eclipse still counts)', () => {
    const iss = ACTIVITIES.find((a) => a.name === 'ISS')!;
    const st = classifyStatus(iss, only('ISS_[FM]', [[hAgo(1), 'H', 0]]), NOW);
    expect(assessPass(geom({ norad: 25544, rise: 0, set: 12, maxEl: 70, above: [4, 8], sun: [[0, 12, false, 70]] }), iss, st, 40).verdict).toBe('eligible');
  });
  it('sunlight restrictions still apply to an eligible satellite (eclipsed AO-91 pass is excluded)', () => {
    const f = only('AO-91_[FM]', [[hAgo(1), 'H', 0]]);
    const plan = computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 1 }, availability: fullDay(), range: { start: at(-120), end: at(400) }, selectedNoradIds: [43017] },
      { elements: elementsFixture, status: f },
      [geom({ norad: 43017, rise: 30, set: 42, maxEl: 70, above: [34, 38], sun: [[30, 42, false, 70]] })], [], [], T0,
    );
    expect(plan.consideredNoradIds).toEqual([43017]);
    expect(plan.windows).toEqual([]);
    expect(plan.assessments[0]!.exclusion).toBe('eclipse');
  });
});

describe('selection', () => {
  const eligAll = evaluateEligibility(
    mkFile({ 'ISS_[FM]': { reports: [[hAgo(1), 'H', 0]] }, 'SO-50_[FM]': { reports: [[hAgo(1), 'H', 0]] }, 'AO-91_[FM]': { reports: [[hAgo(1), 'H', 0]] }, 'AO-123_[FM]': { reports: [[hAgo(1), 'H', 0]] } }),
    NOW,
  );
  it('defaults are ISS, SO-50 and AO-91, applied only when eligible', () => {
    expect([...consideredIds(eligAll)].sort()).toEqual([...DEFAULT_SELECTED_NORAD_IDS].sort());
    const noAo91 = eligAll.map((e) => (e.noradId === 43017 ? { ...e, eligible: false } : e));
    expect(consideredIds(noAo91).has(43017)).toBe(false);
  });
  it('an eligible but unselected satellite is not considered', () => {
    expect(consideredIds(eligAll, [27607]).has(61781)).toBe(false);
    expect([...consideredIds(eligAll, [27607, 61781])].sort()).toEqual([27607, 61781]);
  });
  it('eligibility never edits the stored selection: an ineligible selected satellite returns when it qualifies again', () => {
    const chosen = Object.freeze([27607, 43017]) as readonly number[];
    const without = eligAll.map((e) => (e.noradId === 43017 ? { ...e, eligible: false } : e));
    expect([...consideredIds(without, chosen)]).toEqual([27607]);
    expect([...consideredIds(eligAll, chosen)].sort()).toEqual([27607, 43017]); // same stored list, AO-91 back
  });
});

function fullDay() {
  const av = emptyAvailability();
  for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
  av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
  return av;
}

describe('unselected / ineligible satellites cannot affect ranking or counts', () => {
  const status = mkFile({
    'SO-50_[FM]': { reports: [[hAgo(1), 'H', 0]] },
    'ISS_[FM]': { reports: [[hAgo(1), 'H', 0]] },
    'CAS-3H_[FM]': { reports: [] }, // not eligible
  });
  const passes = [
    geom({ norad: 27607, rise: 26, set: 38, maxEl: 60, above: [30, 34] }),
    geom({ norad: 27607, rise: 56, set: 68, maxEl: 60, above: [60, 64] }),
    geom({ norad: 25544, rise: 86, set: 98, maxEl: 88, above: [90, 94] }), // eligible but may be unselected
    geom({ norad: 40908, rise: 106, set: 118, maxEl: 89, above: [110, 114] }), // ineligible
  ];
  const run = (selectedNoradIds: number[], minOpportunities = 2) =>
    computePlan(
      { observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities }, availability: fullDay(), range: { start: at(-120), end: at(400) }, selectedNoradIds },
      { elements: elementsFixture, status }, passes, [], [], T0,
    );

  it('with only SO-50 selected the ISS and the ineligible CAS-3H passes do not exist in the results', () => {
    const plan = run([27607, 40908]); // CAS-3H is selected but ineligible
    expect(plan.consideredNoradIds).toEqual([27607]);
    expect(plan.assessments.map((a) => a.noradId)).toEqual([27607, 27607]);
    expect(plan.windows).toHaveLength(1);
    const w = plan.windows[0]!;
    expect(w.counted.map((c) => c.noradId)).toEqual([27607, 27607]);
    expect(w.distinctSatellites).toBe(1);
    const everywhere = [...w.counted, ...w.alternatives, ...w.edge, ...w.excluded];
    expect(everywhere.some((a) => a.noradId === 25544 || a.noradId === 40908)).toBe(false);
  });
  it('selecting ISS adds its pass; the high ISS pass changes counts only when selected', () => {
    expect(run([27607]).windows[0]!.counted).toHaveLength(2);
    const withIss = run([27607, 25544]).windows[0]!;
    expect(withIss.counted).toHaveLength(3);
    expect(withIss.distinctSatellites).toBe(2);
  });
  it('a third pass from an unselected satellite cannot satisfy a minimum of 3', () => {
    expect(run([27607], 3).windows).toEqual([]);
    expect(run([27607, 25544], 3).windows).toHaveLength(1);
  });
  it('the diagnosis never suggests counting unconfirmed passes', () => {
    const d = run([27607], 3).diagnosis!;
    expect(d.suggestions.map((s) => s.kind as string)).not.toContain('count-conditional');
  });
  it('records the single time snapshot used and the eligibility of every catalog satellite', () => {
    const plan = run([27607]);
    expect(plan.meta.eligibilityCheckedAtMs).toBe(T0);
    expect(plan.eligibility.find((e) => e.name === 'CAS-3H')!.eligible).toBe(false);
  });
});
