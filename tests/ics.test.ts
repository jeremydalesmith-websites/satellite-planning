import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_MIN_EVENT_MIN, CALENDAR_POST_MIN, CALENDAR_SETUP_MIN, PLANNER_URL } from '../src/domain/policy.ts';
import {
  ICS_MIME,
  buildCalendarExport,
  calendarDescription,
  calendarTimes,
  calendarTitle,
  calendarUid,
  enforceMinimumLength,
  escapeText,
  exactDuration,
  foldLine,
  InvalidCalendarDataError,
} from '../src/export/ics.ts';
import type { CalendarPass, CalendarSource } from '../src/export/ics.ts';

/**
 * CALENDAR EXPORT (builder only; no UI yet). The export is the SAVED plan as saved: start 10 minutes before the first saved
 * AOS, end 5 minutes after the last saved LOS, never shorter than 15 minutes; title from the full-pass numbers without
 * buffers; a static-snapshot warning; exact per-pass details; no coordinates, callsigns, alarms or network access.
 */
const ISS = 25544;
const SO50 = 27607;
const AO91 = 43017;
const MIN = 60_000;

const T1 = Date.UTC(2026, 10, 14, 23, 32, 4, 400); // 5:32:04 PM CST on Sat 14 Nov 2026
const pass = (o: Partial<CalendarPass> & Pick<CalendarPass, 'noradId' | 'name' | 'riseMs' | 'setMs'>): CalendarPass => ({
  peakMs: Math.round((o.riseMs + o.setMs) / 2),
  operatingMs: o.setMs - o.riseMs,
  fullMaxElevationDeg: 60,
  eligibleMaxElevationDeg: o.fullMaxElevationDeg ?? 60,
  statusState: 'recently-reported-active',
  ...o,
});
const iss = (extra: Partial<CalendarPass> = {}) =>
  pass({ noradId: ISS, name: 'ISS', riseMs: T1, peakMs: Date.UTC(2026, 10, 14, 23, 37, 20), setMs: T1 + 646_200, fullMaxElevationDeg: 75.2, ...extra }); // 10 min 46.2 s
const so50a = (extra: Partial<CalendarPass> = {}) =>
  pass({ noradId: SO50, name: 'SO-50', riseMs: Date.UTC(2026, 10, 15, 0, 10, 30), peakMs: Date.UTC(2026, 10, 15, 0, 16, 15), setMs: Date.UTC(2026, 10, 15, 0, 22, 30), fullMaxElevationDeg: 62.4, ...extra });
const so50b = (extra: Partial<CalendarPass> = {}) =>
  pass({ noradId: SO50, name: 'SO-50', riseMs: Date.UTC(2026, 10, 15, 1, 48, 0), peakMs: Date.UTC(2026, 10, 15, 1, 53, 40), setMs: Date.UTC(2026, 10, 15, 1, 59, 12), fullMaxElevationDeg: 70.2, ...extra });
const ao91 = (extra: Partial<CalendarPass> = {}) =>
  pass({
    noradId: AO91, name: 'AO-91', riseMs: Date.UTC(2026, 10, 15, 3, 0, 0), peakMs: Date.UTC(2026, 10, 15, 3, 5, 30), setMs: Date.UTC(2026, 10, 15, 3, 0, 0) + 666_000,
    fullMaxElevationDeg: 85.2, eligibleMaxElevationDeg: 62.4, operatingMs: 492_000, ...extra,
  });
const EXTRAS = { riseAzDeg: 22, setAzDeg: 158, aboveThreshold: { start: Date.UTC(2026, 10, 14, 23, 34, 10), end: Date.UTC(2026, 10, 14, 23, 40, 30) } };

const source = (counted: CalendarPass[], tz = 'America/Chicago', over: Partial<CalendarSource> = {}): CalendarSource => ({
  id: 'ev-test-1',
  savedAtMs: Date.UTC(2026, 10, 12, 18, 0, 0),
  window: { start: Math.min(...counted.map((p) => p.riseMs)), end: Math.max(...counted.map((p) => p.setMs)) },
  timeZone: tz,
  criteria: { minElevationDeg: 40 },
  original: { counted },
  ...over,
});
const BEFORE = Date.UTC(2026, 10, 13, 12, 0, 0); // an export made before the event
const AFTER = Date.UTC(2026, 10, 16, 12, 0, 0);

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter((l) => l !== '');
const prop = (ics: string, name: string) => unfold(ics).find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
const unescape = (v: string) => v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
const desc = (counted: CalendarPass[], tz?: string, exportedAt = BEFORE, over?: Partial<CalendarSource>) => calendarDescription(source(counted, tz, over), exportedAt);

afterEach(() => vi.restoreAllMocks());

describe('calendar times: 10 minutes of setup before the first saved AOS, 5 minutes after the last saved LOS, at least 15 minutes', () => {
  it('constants', () => {
    expect([CALENDAR_SETUP_MIN, CALENDAR_POST_MIN, CALENDAR_MIN_EVENT_MIN]).toEqual([10, 5, 15]);
  });
  it('start is the first AOS minus 10 minutes (rounded DOWN to the second); end is the last LOS plus 5 minutes (rounded UP)', () => {
    const t = calendarTimes([iss()]);
    expect(t.firstAosMs).toBe(T1);
    expect(t.startMs).toBe(Date.UTC(2026, 10, 14, 23, 22, 4, 0)); // 23:22:04.4 -> 23:22:04
    expect(t.lastLosMs).toBe(T1 + 646_200);
    expect(t.endMs).toBe(Date.UTC(2026, 10, 14, 23, 47, 51, 0)); // 23:47:50.6 -> 23:47:51
    expect(t.startMs).toBeLessThanOrEqual(T1 - 10 * MIN);
    expect(t.endMs).toBeGreaterThanOrEqual(T1 + 646_200 + 5 * MIN);
    expect(t.extendedToMinimum).toBe(false);
  });
  it('whole-second instants are not moved', () => {
    const t = calendarTimes([pass({ noradId: ISS, name: 'ISS', riseMs: Date.UTC(2026, 10, 14, 20, 0, 0), setMs: Date.UTC(2026, 10, 14, 20, 10, 0) })]);
    expect(t.startMs).toBe(Date.UTC(2026, 10, 14, 19, 50, 0));
    expect(t.endMs).toBe(Date.UTC(2026, 10, 14, 20, 15, 0));
  });
  it('several passes: first AOS and last LOS, whatever order they are stored in', () => {
    const a = calendarTimes([so50b(), iss(), so50a()]);
    const b = calendarTimes([iss(), so50a(), so50b()]);
    expect(a).toEqual(b);
    expect(a.firstAosMs).toBe(T1);
    expect(a.lastLosMs).toBe(Date.UTC(2026, 10, 15, 1, 59, 12));
    expect(a.endMs).toBe(Date.UTC(2026, 10, 15, 2, 4, 12));
  });
  it('with any positive pass length the buffers already exceed the 15-minute minimum', () => {
    for (const lenMs of [1, 1000, 30_000, 5 * MIN]) {
      const t = calendarTimes([pass({ noradId: ISS, name: 'ISS', riseMs: T1, setMs: T1 + lenMs })]);
      expect(t.endMs - t.startMs).toBeGreaterThan(CALENDAR_MIN_EVENT_MIN * MIN);
      expect(t.extendedToMinimum).toBe(false);
    }
  });
  it('the minimum-length rule is a standalone timing helper: it only ever moves an end later and knows nothing about passes', () => {
    expect(enforceMinimumLength(1_000_000, 1_000_000 + 10 * MIN)).toEqual({ endMs: 1_000_000 + 15 * MIN, extended: true });
    expect(enforceMinimumLength(1_000_000, 1_000_000 + 15 * MIN)).toEqual({ endMs: 1_000_000 + 15 * MIN, extended: false });
    expect(enforceMinimumLength(1_000_000, 1_000_000 + 40 * MIN)).toEqual({ endMs: 1_000_000 + 40 * MIN, extended: false });
    expect(enforceMinimumLength(1_000_000, 1_000_000 + 2 * MIN, 5)).toEqual({ endMs: 1_000_000 + 5 * MIN, extended: true }); // another minimum
  });
  it('for valid passes the minimum never changes anything, so no valid event is ever reported as extended', () => {
    for (const len of [1, 1000, 30_000, 5 * MIN, 12 * MIN, 25 * MIN]) {
      const t = calendarTimes([pass({ noradId: ISS, name: 'ISS', riseMs: T1, setMs: T1 + len })]);
      expect(t.extendedToMinimum).toBe(false);
      expect(t.endMs - t.startMs).toBeGreaterThanOrEqual((CALENDAR_SETUP_MIN + CALENDAR_POST_MIN) * MIN + len - 1000);
    }
  });
});

describe('broken pass data is rejected, never made to look valid', () => {
  const ok = () => source([iss(EXTRAS)]);
  const withPass = (over: Partial<CalendarPass>) => source([iss({ ...EXTRAS, ...over })]);
  const cases: Array<[string, Partial<CalendarPass>, RegExp]> = [
    ['LOS equal to AOS', { setMs: T1, peakMs: T1 }, /LOS at or before its AOS/],
    ['LOS before AOS', { setMs: T1 - 3 * MIN, peakMs: T1 - 4 * MIN }, /LOS at or before its AOS/],
    ['NaN AOS', { riseMs: NaN }, /invalid AOS/],
    ['NaN LOS', { setMs: NaN }, /invalid LOS/],
    ['infinite LOS', { setMs: Infinity }, /invalid LOS/],
    ['AOS that is not a number', { riseMs: '2026-11-14' as unknown as number }, /invalid AOS/],
    ['undefined LOS', { setMs: undefined as unknown as number }, /invalid LOS/],
    ['NaN peak', { peakMs: NaN }, /invalid peak/],
    ['peak before AOS', { peakMs: T1 - 1 }, /peak outside the pass/],
    ['peak after LOS', { peakMs: T1 + 646_200 + 1 }, /peak outside the pass/],
    ['NaN maximum elevation', { fullMaxElevationDeg: NaN }, /invalid maximum elevation/],
    ['negative operating time', { operatingMs: -1 }, /invalid operating time/],
    ['NaN sunlit elevation', { eligibleMaxElevationDeg: NaN }, /invalid sunlit elevation/],
    ['NaN direction', { riseAzDeg: NaN }, /invalid rise direction/],
    ['threshold interval with a NaN end', { aboveThreshold: { start: T1, end: NaN } }, /invalid time-above-threshold/],
    ['threshold interval that runs backwards', { aboveThreshold: { start: T1 + 60_000, end: T1 } }, /runs backwards/],
  ];
  it.each(cases)('%s: every entry point throws InvalidCalendarDataError and no file is produced', (_name, over, message) => {
    const s = withPass(over);
    for (const run of [
      () => calendarTimes(s.original.counted),
      () => calendarTitle(s.original.counted),
      () => calendarDescription(s, BEFORE),
      () => buildCalendarExport(s, BEFORE),
    ]) {
      expect(run).toThrow(InvalidCalendarDataError);
      expect(run).toThrow(message);
    }
  });
  it('a broken pass among valid ones rejects the whole event (no partial entry), and the message names the pass', () => {
    const s = source([iss(EXTRAS), so50a({ setMs: Date.UTC(2026, 10, 15, 0, 10, 30), peakMs: Date.UTC(2026, 10, 15, 0, 10, 30) })]);
    expect(() => buildCalendarExport(s, BEFORE)).toThrow(/pass 2 \(SO-50\)/);
  });
  it('a peak exactly on AOS or on LOS is allowed (the boundary is inclusive), one millisecond outside is not', () => {
    expect(() => buildCalendarExport(withPass({ peakMs: T1 }), BEFORE)).not.toThrow();
    expect(() => buildCalendarExport(withPass({ peakMs: T1 + 646_200 }), BEFORE)).not.toThrow();
    expect(() => buildCalendarExport(withPass({ peakMs: T1 - 1 }), BEFORE)).toThrow(InvalidCalendarDataError);
  });
  it('an event with no passes, an invalid time zone, or an invalid export or saved time is rejected', () => {
    expect(() => calendarTimes([])).toThrow(InvalidCalendarDataError);
    expect(() => calendarTitle([])).toThrow(InvalidCalendarDataError);
    expect(() => buildCalendarExport(source([]), BEFORE)).toThrow(InvalidCalendarDataError);
    expect(() => buildCalendarExport(source([iss()], 'Mars/Olympus'), BEFORE)).toThrow(/time zone "Mars\/Olympus" is not valid/);
    expect(() => buildCalendarExport(ok(), NaN)).toThrow(/export time is invalid/);
    expect(() => buildCalendarExport(source([iss()], 'UTC', { savedAtMs: NaN }), BEFORE)).toThrow(/saved time is invalid/);
    expect(() => buildCalendarExport(source([iss()], 'UTC', { criteria: { minElevationDeg: NaN } }), BEFORE)).toThrow(/elevation threshold/);
  });
  it('valid data still exports, and optional details that are absent are not errors', () => {
    expect(() => buildCalendarExport(ok(), BEFORE)).not.toThrow();
    expect(() => buildCalendarExport(source([iss()]), BEFORE)).not.toThrow();
  });
});

describe('sample labels (for a test file imported into a throwaway calendar)', () => {
  it('prefix the title and the description without changing the times, the UID or SEQUENCE; a normal export has no prefix', () => {
    const s = source([iss(EXTRAS)], 'America/Chicago', { id: 'sample-iss-1' });
    const plain = buildCalendarExport(s, BEFORE);
    const sample = buildCalendarExport(s, BEFORE, { titlePrefix: 'SAMPLE — ', descriptionPrefix: 'SAMPLE: illustrative data.' });
    expect(prop(plain.content, 'SUMMARY')).toBe('ISS 75° 11m');
    expect(prop(sample.content, 'SUMMARY')).toBe('SAMPLE — ISS 75° 11m');
    expect(unescape(prop(sample.content, 'DESCRIPTION')!)).toMatch(/^SAMPLE: illustrative data\.\n\nSTATIC SNAPSHOT/);
    for (const name of ['DTSTART', 'DTEND', 'UID', 'SEQUENCE']) expect(prop(sample.content, name)).toBe(prop(plain.content, name));
    expect(sample.filename).toBe(plain.filename);
  });
});

describe('titles', () => {
  it('single pass: name, full-pass maximum elevation (nearest degree), full AOS-to-LOS duration (nearest minute): ISS 75° 11m', () => {
    expect(calendarTitle([iss()])).toBe('ISS 75° 11m');
  });
  it('the duration is the pass, not the calendar entry (the 15 buffer minutes are excluded)', () => {
    expect(calendarTitle([iss()])).not.toMatch(/26m|25m/);
  });
  it('rounding edges: 74.5° -> 75, 74.49° -> 74; 10 min 30 s -> 11m, 10 min 29.9 s -> 10m', () => {
    expect(calendarTitle([iss({ fullMaxElevationDeg: 74.5 })])).toContain(' 75° ');
    expect(calendarTitle([iss({ fullMaxElevationDeg: 74.49 })])).toContain(' 74° ');
    expect(calendarTitle([iss({ setMs: T1 + 630_000 })])).toMatch(/ 11m$/);
    expect(calendarTitle([iss({ setMs: T1 + 629_900 })])).toMatch(/ 10m$/);
  });
  it('a sunlight-limited pass is titled by its full-pass maximum (the sunlit value goes in the description)', () => {
    expect(calendarTitle([ao91()])).toBe('AO-91 85° 11m'); // 666 s = 11.1 min
  });
  it('several passes: "3 passes: ISS 75°, SO-50 62°, SO-50 70°", chronological, without the overall span', () => {
    const t = calendarTitle([so50b(), iss(), so50a()]);
    expect(t).toBe('3 passes: ISS 75°, SO-50 62°, SO-50 70°');
    expect(t).not.toMatch(/\d\s?h\b|\bspan\b|min/i);
  });
  it('two and four passes list every pass; more than four show the first three and "+N more"', () => {
    expect(calendarTitle([iss(), so50a()])).toBe('2 passes: ISS 75°, SO-50 62°');
    const four = [iss(), so50a(), so50b(), ao91()];
    expect(calendarTitle(four)).toBe('4 passes: ISS 75°, SO-50 62°, SO-50 70°, AO-91 85°');
    const five = [...four, pass({ noradId: ISS, name: 'ISS', riseMs: Date.UTC(2026, 10, 15, 5, 0, 0), setMs: Date.UTC(2026, 10, 15, 5, 10, 0), fullMaxElevationDeg: 50 })];
    expect(calendarTitle(five)).toBe('5 passes: ISS 75°, SO-50 62°, SO-50 70°, +2 more');
    const six = [...five, pass({ noradId: ISS, name: 'ISS', riseMs: Date.UTC(2026, 10, 15, 7, 0, 0), setMs: Date.UTC(2026, 10, 15, 7, 10, 0) })];
    expect(calendarTitle(six)).toMatch(/^6 passes: .*\+3 more$/);
  });
});

describe('description: the setup, the snapshot and every pass', () => {
  const text = desc([iss(EXTRAS), so50a(EXTRAS), so50b(EXTRAS)]);

  it('opens with the static-snapshot warning: it does not update automatically and may differ from the latest re-check', () => {
    const first = text.split('\n')[0]!;
    expect(first).toMatch(/^STATIC SNAPSHOT/);
    expect(first).toContain('does not update automatically');
    expect(first).toMatch(/latest re-check may differ/);
    expect(first).toContain(PLANNER_URL);
    expect(first).toContain('plan saved on Thu, Nov 12, 2026');
  });
  it('distinguishes setup start, first AOS, last LOS and the buffered calendar end, with the zone and UTC', () => {
    expect(text).toContain('Setup starts (calendar start): Sat, Nov 14, 2026, 5:22:04 PM CST (2026-11-14 23:22:04 UTC)');
    expect(text).toContain('First pass starts (first AOS): Sat, Nov 14, 2026, 5:32:04 PM CST (2026-11-14 23:32:04 UTC)');
    expect(text).toContain('Last pass ends (last LOS): Sat, Nov 14, 2026, 7:59:12 PM CST (2026-11-15 01:59:12 UTC)');
    expect(text).toContain('Calendar entry ends: Sat, Nov 14, 2026, 8:04:12 PM CST (2026-11-15 02:04:12 UTC)');
    expect(text).toContain('Span from first AOS to last LOS: 2 h 27 min 08 s');
    expect(text).toContain('The first 10 minutes of this entry are SETUP TIME, not satellite time.');
    expect(text).toContain('5 minutes past the last pass');
  });
  it('labels the setup time ahead of any pass block', () => {
    expect(text.indexOf('SETUP TIME')).toBeLessThan(text.indexOf('PASS 1 of 3'));
  });
  it('gives each pass exact AOS/LOS with seconds and zone, the exact duration, and the peak time and elevation', () => {
    expect(text).toContain('PASS 1 of 3: ISS (↑ 2 m · ↓ 70 cm)');
    expect(text).toContain('Start (AOS): 5:32:04 PM CST (23:32:04 UTC)');
    expect(text).toContain('End (LOS): 5:42:50 PM CST (23:42:50 UTC)');
    expect(text).toContain('Duration: 10 min 46 s');
    expect(text).toContain('Peak: 5:37:20 PM CST (23:37:20 UTC), maximum elevation 75°');
    expect(text).toContain('PASS 2 of 3: SO-50');
    expect(text).toContain('Duration: 12 min 00 s');
    expect(text).toContain('Duration: 11 min 12 s');
  });
  it('gives the time above the selected threshold with its start and end, and the rise and set directions, when stored', () => {
    expect(text).toContain('Time above 40°: 5:34:10 PM CST (23:34:10 UTC) to 5:40:30 PM CST (23:40:30 UTC) (6 min 20 s)');
    expect(text).toContain('Rises NNE (22°), sets SSE (158°)');
  });
  it('gives radio settings: frequencies and the tone, never inventing a tone the catalog does not list', () => {
    expect(text).toContain('Radio: transmit 145.990 MHz (67 Hz tone), listen 437.800 MHz');
    expect(text).toContain('Radio: transmit 145.850 MHz (67 Hz tone), listen 436.795 MHz');
    expect(desc([ao91()])).toContain('Radio: transmit 435.250 MHz (no tone listed in the catalog), listen 145.960 MHz');
  });
  it('carries the operational warnings with their sources, as manual catalog notes', () => {
    expect(text).toContain('Subject to ISS operations:');
    expect(text).toMatch(/ARISS expects the ISS radios to operate full time/);
    expect(text).toContain('arming'.length ? '74.4 Hz CTCSS tone' : '');
    expect(text).toContain('manual catalog note, not live');
    expect(text).toContain('Eligibility when saved: a recent "Heard" report for its FM repeater (not a live status check).');
  });
  it('a sunlight-limited pass puts the sunlit-usable elevation and the restriction ahead of the pass times', () => {
    const t = desc([ao91()]);
    const block = t.slice(t.indexOf('PASS 1 of 1'));
    expect(block).toContain('SUNLIGHT-ONLY REPEATER');
    expect(block).toContain('Maximum elevation while sunlit: 62° (the full pass peaks at 85°). Sunlit operating time: 8 min 12 s of 11 min 06 s.');
    expect(block).toContain('AMSAT asks that this repeater not be used while the satellite is in eclipse');
    expect(block.indexOf('SUNLIGHT-ONLY REPEATER')).toBeLessThan(block.indexOf('Start (AOS)'));
    expect(block.match(/not be used while the satellite is in eclipse/g)).toHaveLength(1); // stated once, not again under Warnings
  });
  it('says when part of a sunlight-limited pass is in Earth’s shadow, and when the sunlit peak equals the pass peak', () => {
    expect(desc([ao91({ sunlight: 'partly-eclipsed' })])).toContain('Part of the pass is in Earth’s shadow.');
    expect(desc([ao91({ eligibleMaxElevationDeg: 85.2, operatingMs: 666_000 })])).toContain('(same as the pass peak)');
  });
  it('ends with the planner link and a re-check reminder', () => {
    expect(text).toMatch(/Planning estimate only\. Re-check the pass times and repeater status before the event\.\nPlanner: https:\/\/k1kfx\.com\/satellites\/$/);
  });
});

describe('older saved events: one concise note, nothing inferred', () => {
  const old = desc([iss(), so50a()]);
  it('omits direction and threshold lines and says ONCE that some details were not stored', () => {
    expect(old).not.toMatch(/Rises |Time above/);
    expect(old.match(/were not stored with this older saved event/g)).toHaveLength(1);
    expect(old).not.toMatch(/not stored.*not stored/s);
  });
  it('a new event with every detail stored has no such note, and a stored "never above" is stated, not omitted', () => {
    expect(desc([iss(EXTRAS)])).not.toContain('not stored');
    expect(desc([iss({ ...EXTRAS, aboveThreshold: null })])).toContain('Time above 40°: none');
  });
  it('the builder never reads current predictions: it imports no prediction, planner, storage or network code', () => {
    const src = readFileSync('src/export/ics.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention these words
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(['../catalog/catalog.ts', '../domain/policy.ts', '../domain/types.ts', '../saved/saved.ts']); // saved.ts: types only
    for (const banned of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'navigator.', 'document.', 'window.', 'globalThis']) expect(code).not.toContain(banned);
  });
});

describe('past events', () => {
  it('are labeled past (and not otherwise); the entry itself is unchanged', () => {
    const before = desc([iss(EXTRAS)], undefined, BEFORE);
    const after = desc([iss(EXTRAS)], undefined, AFTER);
    expect(before).not.toContain('PAST EVENT');
    expect(after).toContain('PAST EVENT: the last pass of this saved plan ended Sat, Nov 14, 2026, 5:42:50 PM CST (2026-11-14 23:42:50 UTC), before this file was exported.');
    expect(buildCalendarExport(source([iss()]), BEFORE).startMs).toBe(buildCalendarExport(source([iss()]), AFTER).startMs);
  });
  it('there is no time-dependent restriction: a past event still exports', () => {
    expect(() => buildCalendarExport(source([iss()]), Date.UTC(2030, 0, 1))).not.toThrow();
  });
});

describe('time zones', () => {
  it('descriptions use the saved planning zone: Kolkata (+5:30, next day) and Auckland (+13)', () => {
    const kolkata = desc([iss()], 'Asia/Kolkata');
    expect(kolkata).toContain('Setup starts (calendar start): Sun, Nov 15, 2026, 4:52:04 AM GMT+5:30 (2026-11-14 23:22:04 UTC)');
    expect(kolkata).toContain('Start (AOS): 5:02:04 AM GMT+5:30 (23:32:04 UTC)');
    const auckland = desc([iss()], 'Pacific/Auckland');
    expect(auckland).toContain('Start (AOS): 12:32:04 PM GMT+13 (23:32:04 UTC)');
  });
  it('a pass on the same local day as the setup start shows only its clock time; one on another local day shows its date', () => {
    const t = desc([iss(), so50b()], 'America/Chicago'); // 7:48 PM CST: the same local day as the 5:22 PM setup start
    expect(t).toContain('Start (AOS): 7:48:00 PM CST (01:48:00 UTC)');
    const late = so50a({ riseMs: Date.UTC(2026, 10, 15, 6, 30, 0), peakMs: Date.UTC(2026, 10, 15, 6, 36, 0), setMs: Date.UTC(2026, 10, 15, 6, 42, 0) }); // 12:30 AM CST on Sunday
    const next = desc([iss(), late], 'America/Chicago');
    expect(next).toContain('Start (AOS): Sun, Nov 15, 2026, 12:30:00 AM CST (06:30:00 UTC)');
    expect(next).toContain('Start (AOS): 5:32:04 PM CST (23:32:04 UTC)'); // the first pass keeps the short form
  });
  it('across the US spring-forward (CST to CDT) the UTC calendar times stay exact and the description names both zones', () => {
    const rise = Date.UTC(2027, 2, 14, 7, 55, 0); // 1:55 AM CST, five minutes before the clocks jump
    const s = source([pass({ noradId: ISS, name: 'ISS', riseMs: rise, setMs: Date.UTC(2027, 2, 14, 8, 10, 0) })]);
    const ics = buildCalendarExport(s, Date.UTC(2027, 2, 1)).content;
    expect(prop(ics, 'DTSTART')).toBe('20270314T074500Z');
    expect(prop(ics, 'DTEND')).toBe('20270314T081500Z');
    const d = calendarDescription(s, Date.UTC(2027, 2, 1));
    expect(d).toContain('1:45:00 AM CST');
    expect(d).toContain('3:10:00 AM CDT');
  });
  it('the ACTUAL builder gives byte-identical output in processes whose system time zone really differs', () => {
    // Each child process is STARTED with TZ set, runs the real builder (not a format of an already-UTC value), and also reports
    // what its own system zone is, so the test fails loudly if the environment ignored TZ and the comparison was vacuous.
    const script = `
      import { buildCalendarExport } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/export/ics.ts')).href)};
      const input = JSON.parse(process.env.SRC_JSON);
      const probe = new Date(Date.UTC(2026, 10, 14, 23, 32, 4));
      process.stdout.write(JSON.stringify({
        systemZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMin: probe.getTimezoneOffset(),
        naiveLocalHour: probe.getHours(), // what a zone-dependent implementation would have used
        content: buildCalendarExport(input.source, input.exportedAt).content,
      }));`;
    const payload = JSON.stringify({ source: source([iss(EXTRAS), so50a(EXTRAS), so50b(EXTRAS)]), exportedAt: BEFORE });
    const zones = ['Pacific/Auckland', 'America/Chicago', 'Asia/Kolkata', 'UTC'];
    const runs = zones.map((tz) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz, SRC_JSON: payload }, encoding: 'utf8' });
      expect(r.status, `${tz}: ${r.stderr}`).toBe(0);
      return { tz, ...(JSON.parse(r.stdout) as { systemZone: string; offsetMin: number; naiveLocalHour: number; content: string }) };
    });
    // the environments really differ: each child saw its own zone, with different offsets and different local hours
    const canonical = (z: string) => new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone; // ICU names Kolkata "Asia/Calcutta"
    expect(runs.map((r) => r.systemZone)).toEqual(zones.map(canonical));
    expect(runs.map((r) => r.offsetMin)).toEqual([-780, 360, -330, 0]);
    expect(new Set(runs.map((r) => r.naiveLocalHour)).size).toBe(4); // a zone-dependent computation WOULD have differed here
    // ...and yet the exported file is identical
    for (const r of runs) expect(r.content).toBe(runs[0]!.content);
    expect(prop(runs[0]!.content, 'DTSTART')).toBe('20261114T232204Z');
  }, 60_000);
  it('the description follows the SAVED zone, not the process zone', () => {
    const asChicago = (tz: string) => {
      const script = `import { calendarDescription } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/export/ics.ts')).href)};
        const i = JSON.parse(process.env.SRC_JSON); process.stdout.write(calendarDescription(i.source, i.exportedAt));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz, SRC_JSON: JSON.stringify({ source: source([iss()], 'America/Chicago'), exportedAt: BEFORE }) }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const a = asChicago('Pacific/Auckland');
    expect(a).toContain('5:32:04 PM CST');
    expect(a).toBe(asChicago('UTC'));
  }, 60_000);
});

describe('the .ics file', () => {
  const ics = buildCalendarExport(source([iss(EXTRAS), so50a(EXTRAS), so50b(EXTRAS)]), BEFORE);

  it('is a VCALENDAR with one VEVENT and the required properties, DTSTART/DTEND in UTC', () => {
    const lines = unfold(ics.content);
    expect(lines.slice(0, 3)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//K1KFX//Satellite Pass Planner//EN']);
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(prop(ics.content, 'DTSTART')).toBe('20261114T232204Z');
    expect(prop(ics.content, 'DTEND')).toBe('20261115T020412Z');
    expect(prop(ics.content, 'DTSTAMP')).toBe('20261113T120000Z');
    expect(prop(ics.content, 'UID')).toBe('ev-test-1@k1kfx.com');
    expect(prop(ics.content, 'SEQUENCE')).toBe('0');
    expect(prop(ics.content, 'URL')).toBe('https://k1kfx.com/satellites/');
    expect(prop(ics.content, 'TRANSP')).toBe('OPAQUE');
    expect(ics.startMs).toBe(Date.UTC(2026, 10, 14, 23, 22, 4));
    expect(ics.endMs).toBe(Date.UTC(2026, 10, 15, 2, 4, 12));
  });
  it('uses CRLF line endings throughout and ends with one', () => {
    expect(ics.content.endsWith('\r\n')).toBe(true);
    expect(ics.content.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // no bare CR or LF
  });
  it('every physical line is at most 75 octets and no multi-byte character is split', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (const line of ics.content.split('\r\n')) {
      const bytes = new TextEncoder().encode(line);
      expect(bytes.length).toBeLessThanOrEqual(75);
      expect(() => decoder.decode(bytes)).not.toThrow();
    }
  });
  it('the unfolded SUMMARY and DESCRIPTION round-trip to the title and description', () => {
    expect(unescape(prop(ics.content, 'SUMMARY')!)).toBe('3 passes: ISS 75°, SO-50 62°, SO-50 70°');
    expect(unescape(prop(ics.content, 'DESCRIPTION')!)).toBe(calendarDescription(source([iss(EXTRAS), so50a(EXTRAS), so50b(EXTRAS)]), BEFORE));
  });
  it('escapes commas, semicolons, backslashes and newlines in text values', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(prop(ics.content, 'SUMMARY')).toContain('ISS 75°\\, SO-50');
  });
  it('folds ASCII and multi-byte lines without losing a character', () => {
    const ascii = `X:${'a'.repeat(200)}`;
    expect(foldLine(ascii).split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(foldLine(ascii).replace(/\r\n /g, '')).toBe(ascii);
    const degrees = `X:${'°'.repeat(100)}`;
    const folded = foldLine(degrees);
    expect(folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(degrees);
    expect(foldLine('short')).toBe('short');
  });
  it('has no alarm, location, coordinates, attendees or callsigns', () => {
    for (const banned of ['VALARM', 'LOCATION', 'GEO:', 'ATTENDEE', 'ORGANIZER', 'callsign']) expect(ics.content).not.toContain(banned);
  });
  it('even a full saved event (which holds the observer location) exports without it', () => {
    const full = { ...source([iss(EXTRAS)]), location: { latDeg: 42.3517, lonDeg: -71.0642 }, selectedNoradIds: [ISS] };
    const out = buildCalendarExport(full, BEFORE).content;
    expect(out).not.toMatch(/42\.35|71\.06|latDeg|lonDeg/);
  });
  it('the UID is stable across exports; only DTSTAMP differs between two exports made before the event', () => {
    const a = buildCalendarExport(source([iss(EXTRAS)]), BEFORE).content;
    const b = buildCalendarExport(source([iss(EXTRAS)]), BEFORE + 6 * 60 * MIN).content; // still before the event
    expect(prop(a, 'UID')).toBe(prop(b, 'UID'));
    expect(a.replace(/DTSTAMP:\S+/, '')).toBe(b.replace(/DTSTAMP:\S+/, ''));
    expect(a).not.toBe(b);
  });
  it('UIDs are safe for any saved-event id', () => {
    expect(calendarUid('ev-m3x2k-ab12c')).toBe('ev-m3x2k-ab12c@k1kfx.com');
    expect(calendarUid('ev 1/2:3 ;,')).toBe('ev-1-2-3@k1kfx.com');
    expect(calendarUid('///')).toBe('event@k1kfx.com');
  });
  it('filenames are plain ASCII with the first AOS date and time in the event zone', () => {
    expect(buildCalendarExport(source([iss()]), BEFORE).filename).toBe('ISS-75deg-11m-20261114-1732.ics');
    expect(ics.filename).toBe('3-passes-20261114-1732.ics');
    expect(buildCalendarExport(source([iss({ name: 'Odd/Name: "x"' })]), BEFORE).filename).toMatch(/^[A-Za-z0-9._-]+\.ics$/);
    expect(ics.mimeType).toBe(ICS_MIME);
    expect(ICS_MIME).toBe('text/calendar;charset=utf-8');
  });
});

describe('the export is a pure snapshot', () => {
  const deepFreeze = <T,>(o: T): T => {
    if (o && typeof o === 'object') for (const v of Object.values(o)) deepFreeze(v);
    return Object.freeze(o);
  };
  it('does not modify the saved event (even a deep-frozen one) and is deterministic', () => {
    const s = deepFreeze(source([iss(EXTRAS), so50a(EXTRAS)]));
    const first = buildCalendarExport(s, BEFORE);
    expect(buildCalendarExport(s, BEFORE)).toEqual(first);
    expect(s.window).toEqual({ start: T1, end: Date.UTC(2026, 10, 15, 0, 22, 30) }); // the saved window is untouched
  });
  it('makes no network request', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    buildCalendarExport(source([iss(EXTRAS), so50a(EXTRAS)]), BEFORE);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('exact durations', () => {
    expect(exactDuration(646_200)).toBe('10 min 46 s');
    expect(exactDuration(59_400)).toBe('0 min 59 s');
    expect(exactDuration(8_827_600)).toBe('2 h 27 min 08 s'); // 2 h 27 min 07.6 s
    expect(exactDuration(-5)).toBe('0 min 00 s');
  });
});

/**
 * A REAL iCalendar parser (ical.js), not a hand-written one. It is not a project dependency: it is installed in a scratch
 * folder and enabled with ICAL_JS_PATH=<path to ical.js/dist/ical.min.js or its package folder>. Without it these are skipped.
 */
const icalPath = process.env.ICAL_JS_PATH;
describe.skipIf(!icalPath)('validated with ical.js', () => {
  const load = async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(icalPath!).href)) as Record<string, unknown>;
    return (mod.default ?? mod) as { parse: (s: string) => unknown[]; Component: new (j: unknown) => { getFirstSubcomponent: (n: string) => any; name: string }; Time: unknown };
  };
  it('parses without error and reads back the same instants, summary and description', async () => {
    const ICAL = await load();
    const counted = [iss(EXTRAS), so50a(EXTRAS), so50b(EXTRAS)];
    const out = buildCalendarExport(source(counted), BEFORE);
    const root = new ICAL.Component(ICAL.parse(out.content));
    expect(root.name).toBe('vcalendar');
    const ev = root.getFirstSubcomponent('vevent');
    expect(ev.getFirstPropertyValue('summary')).toBe(out.title);
    expect(ev.getFirstPropertyValue('description')).toBe(calendarDescription(source(counted), BEFORE));
    expect(ev.getFirstPropertyValue('dtstart').toUnixTime() * 1000).toBe(out.startMs);
    expect(ev.getFirstPropertyValue('dtend').toUnixTime() * 1000).toBe(out.endMs);
    expect(ev.getFirstPropertyValue('uid')).toBe('ev-test-1@k1kfx.com');
    expect(ev.getFirstPropertyValue('url')).toBe('https://k1kfx.com/satellites/');
    expect(root.getFirstSubcomponent('vevent').getAllSubcomponents('valarm')).toHaveLength(0);
  });
});
