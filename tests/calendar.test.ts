import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_MIN_EVENT_MIN, CALENDAR_POST_MIN, CALENDAR_SETUP_MIN } from '../src/domain/policy.ts';
import {
  calendarDescription,
  calendarTimes,
  calendarTitle,
  enforceMinimumLength,
  exactDuration,
  InvalidCalendarDataError,
} from '../src/export/calendar.ts';
import type { CalendarPass, CalendarSource } from '../src/export/calendar.ts';

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
  // The shared threshold interval belongs to the ISS pass; for any other pass it is moved to start a minute after that pass begins.
  ...(o.aboveThreshold && (o.aboveThreshold.start < o.riseMs || o.aboveThreshold.end > o.setMs)
    ? { aboveThreshold: { start: o.riseMs + 60_000, end: o.riseMs + 60_000 + (o.aboveThreshold.end - o.aboveThreshold.start) } }
    : {}),
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
    ]) {
      expect(run).toThrow(InvalidCalendarDataError);
      expect(run).toThrow(message);
    }
  });
  it('a broken pass among valid ones rejects the whole event (no partial entry), and the message names the pass', () => {
    const s = source([iss(EXTRAS), so50a({ setMs: Date.UTC(2026, 10, 15, 0, 10, 30), peakMs: Date.UTC(2026, 10, 15, 0, 10, 30) })]);
    expect(() => calendarDescription(s, BEFORE)).toThrow(/pass 2 \(SO-50\)/);
  });
  it('a peak exactly on AOS or on LOS is allowed (the boundary is inclusive), one millisecond outside is not', () => {
    expect(() => calendarDescription(withPass({ peakMs: T1 }), BEFORE)).not.toThrow();
    expect(() => calendarDescription(withPass({ peakMs: T1 + 646_200 }), BEFORE)).not.toThrow();
    expect(() => calendarDescription(withPass({ peakMs: T1 - 1 }), BEFORE)).toThrow(InvalidCalendarDataError);
  });
  it('an event with no passes, an invalid time zone, or an invalid export or saved time is rejected', () => {
    expect(() => calendarTimes([])).toThrow(InvalidCalendarDataError);
    expect(() => calendarTitle([])).toThrow(InvalidCalendarDataError);
    expect(() => calendarDescription(source([]), BEFORE)).toThrow(InvalidCalendarDataError);
    expect(() => calendarDescription(source([iss()], 'Mars/Olympus'), BEFORE)).toThrow(/time zone "Mars\/Olympus" is not valid/);
    expect(() => calendarDescription(ok(), NaN)).toThrow(/export time is invalid/);
    expect(() => calendarDescription(source([iss()], 'UTC', { savedAtMs: NaN }), BEFORE)).toThrow(/saved time is invalid/);
    expect(() => calendarDescription(source([iss()], 'UTC', { criteria: { minElevationDeg: NaN } }), BEFORE)).toThrow(/elevation threshold/);
  });
  it('valid data still exports, and optional details that are absent are not errors', () => {
    expect(() => calendarDescription(ok(), BEFORE)).not.toThrow();
    expect(() => calendarDescription(source([iss()]), BEFORE)).not.toThrow();
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

describe('description: compact, readable, exact', () => {
  const single = desc([iss(EXTRAS)]);

  it('single pass: exactly the agreed compact layout', () => {
    expect(single).toBe(
      [
        'ISS — Saturday, November 14, 2026',
        'All times CST',
        '',
        'Pass: 5:32:04–5:42:50 PM',
        'Peak: 5:37:20 PM · 75°',
        'Duration: 10 min 46 s',
        'Above 40°: 5:34:10–5:40:30 PM · 6 min 20 s',
        'Direction: NNE → SSE',
        '',
        'Transmit: 145.990 MHz · tone 67 Hz',
        'Receive: 437.800 MHz',
        '',
        'Includes 10 min setup before and 5 min after.',
        'ISS repeater availability depends on station operations.',
        '',
        'Static calendar copy—recheck times and status:',
        'https://k1kfx.com/satellites/',
      ].join('\n'),
    );
  });
  it('keeps the exact pass information: start and end with seconds, peak time and elevation, duration, threshold interval, compass directions, frequencies and tone', () => {
    for (const line of ['Pass: 5:32:04–5:42:50 PM', 'Peak: 5:37:20 PM · 75°', 'Duration: 10 min 46 s', 'Above 40°: 5:34:10–5:40:30 PM · 6 min 20 s', 'Direction: NNE → SSE', 'Transmit: 145.990 MHz · tone 67 Hz', 'Receive: 437.800 MHz']) {
      expect(single).toContain(line);
    }
  });
  it('states the date and zone once, and has none of the removed clutter: UTC times, calendar-boundary listings, sources, provenance, eligibility history', () => {
    for (const gone of ['UTC', 'Setup starts', 'First pass starts', 'Last pass ends', 'Calendar entry ends', 'SETUP TIME', 'Source:', 'catalog note', 'manual', 'Eligibility', 'Heard', 'STATIC SNAPSHOT', 'saved on', 'ARISS', 'spacewalk']) expect(single).not.toContain(gone);
    expect(single.match(/CST/g)).toHaveLength(1); // "All times CST", and no zone repeated on any time
    expect(single.match(/November 14, 2026/g)).toHaveLength(1);
    expect(single.length).toBeLessThan(600);
  });
  it('ends with ONE short static-copy sentence and the planner link', () => {
    expect(single.split('\n').slice(-2)).toEqual(['Static calendar copy—recheck times and status:', 'https://k1kfx.com/satellites/']);
    expect(single.match(/k1kfx\.com/g)).toHaveLength(1);
    expect(single.match(/Static calendar copy/g)).toHaveLength(1);
  });
  it('one short buffer sentence, taken from the constants', () => {
    expect(single).toContain(`Includes ${CALENDAR_SETUP_MIN} min setup before and ${CALENDAR_POST_MIN} min after.`);
    expect(single.match(/setup/gi)).toHaveLength(1);
  });
  it('never invents a tone the catalog does not list; frequencies keep three decimals', () => {
    expect(desc([ao91()])).toContain('Transmit: 435.250 MHz · no tone listed');
    expect(desc([ao91()])).toContain('Receive: 145.960 MHz');
  });
  it('warnings are brief: the ISS availability sentence, and the catalog\'s own one-sentence notes without sources', () => {
    expect(desc([so50a(EXTRAS)])).toContain('The repeater has a 10-minute timer that must be armed before use: send a 2-second carrier with a 74.4 Hz CTCSS tone.');
    expect(desc([so50a(EXTRAS)])).not.toContain('SO-50: '); // one satellite: no label needed
    expect(desc([so50a(EXTRAS)])).not.toContain('availability depends'); // not an ISS-style repeater
    expect(desc([ao91()])).not.toMatch(/availability|timer/);
  });
  it('a sunlight-limited pass states the sunlit elevation and the restriction right under the heading, before the pass times', () => {
    const t = desc([ao91()]);
    const lines = t.split('\n');
    expect(lines[3]).toBe('Sunlight only: works only while the satellite is in sunlight; sunlit peak 62° (pass peak 85°); sunlit operating time 8 min 12 s of 11 min 06 s.');
    expect(t.indexOf('Sunlight only')).toBeLessThan(t.indexOf('Pass:'));
    expect(desc([ao91({ sunlight: 'partly-eclipsed' })])).toContain('Partly in Earth’s shadow.');
    expect(desc([ao91({ eligibleMaxElevationDeg: null })])).toContain('no sunlit peak');
    expect(desc([iss()])).not.toContain('Sunlight only');
  });
});

describe('several passes: compact blocks, shared notes once', () => {
  const multi = desc([so50b(EXTRAS), iss(EXTRAS), so50a(EXTRAS)]);
  it('opens with the pass count, date, zone and span, then one compact block per pass in time order', () => {
    const lines = multi.split('\n');
    expect(lines.slice(0, 3)).toEqual(['3 passes — Saturday, November 14, 2026', 'All times CST', 'Span: 2 h 27 min 08 s from first pass start to last pass end']);
    expect(multi.indexOf('ISS · pass 1 of 3')).toBeLessThan(multi.indexOf('SO-50 · pass 2 of 3'));
    expect(multi.indexOf('SO-50 · pass 2 of 3')).toBeLessThan(multi.indexOf('SO-50 · pass 3 of 3'));
    expect(multi).toContain('Pass: 5:32:04–5:42:50 PM');
    expect(multi).toContain('Pass: 6:10:30–6:22:30 PM');
    expect(multi).toContain('Pass: 7:48:00–7:59:12 PM');
    expect(multi.match(/^Peak: /gm)).toHaveLength(3);
    expect(multi.match(/^Duration: /gm)).toHaveLength(3);
    expect(multi.match(/^Transmit: /gm)).toHaveLength(3);
  });
  it('the buffer sentence, each warning and the static-copy note with the link appear ONCE', () => {
    expect(multi.match(/Includes 10 min setup before and 5 min after\./g)).toHaveLength(1);
    expect(multi.match(/Static calendar copy/g)).toHaveLength(1);
    expect(multi.match(/k1kfx\.com/g)).toHaveLength(1);
    expect(multi.match(/ISS repeater availability depends on station operations\./g)).toHaveLength(1);
    expect(multi.match(/74\.4 Hz CTCSS tone/g)).toHaveLength(1); // two SO-50 passes, one note
    expect(multi).toContain('SO-50: The repeater has a 10-minute timer'); // several satellites: the note says which
    expect(multi.split('\n').slice(-2)).toEqual(['Static calendar copy—recheck times and status:', 'https://k1kfx.com/satellites/']);
  });
  it('a pass on another local day than the first shows its date; the others do not', () => {
    const late = so50a({ riseMs: Date.UTC(2026, 10, 15, 6, 30, 0), peakMs: Date.UTC(2026, 10, 15, 6, 36, 0), setMs: Date.UTC(2026, 10, 15, 6, 42, 0) }); // 12:30 AM CST on Sunday
    const t = desc([iss(EXTRAS), late]);
    expect(t).toContain('Pass: Sun, Nov 15, 12:30:00–12:42:00 AM');
    expect(t).toContain('Peak: Sun, Nov 15, 12:36:00 AM · 62°');
    expect(t).toContain('Pass: 5:32:04–5:42:50 PM'); // the first pass keeps the plain form
  });
});

describe('alerts and past events appear at the very top', () => {
  it('caller-supplied alerts (for example a lost eligibility from the latest re-check) come first, each with a warning sign', () => {
    const t = calendarDescription(source([iss(EXTRAS)], 'America/Chicago', { alerts: ['ISS no longer has a recent report; re-check before the event.', 'SO-50 is not currently eligible.'] }), BEFORE);
    expect(t.split('\n').slice(0, 4)).toEqual(['⚠ ISS no longer has a recent report; re-check before the event.', '⚠ SO-50 is not currently eligible.', '', 'ISS — Saturday, November 14, 2026']);
  });
  it('no alerts means the heading is the first line; blank alerts are ignored; the builder never makes one up', () => {
    expect(desc([iss(EXTRAS)]).split('\n')[0]).toBe('ISS — Saturday, November 14, 2026');
    expect(calendarDescription(source([iss()], 'America/Chicago', { alerts: ['  ', ''] }), BEFORE).split('\n')[0]).toBe('ISS — Saturday, November 14, 2026');
    expect(desc([iss(EXTRAS)])).not.toContain('⚠');
  });
  it('alerts must be a list of text', () => {
    expect(() => calendarDescription(source([iss()], 'America/Chicago', { alerts: 'oops' as unknown as string[] }), BEFORE)).toThrow(InvalidCalendarDataError);
    expect(() => calendarDescription(source([iss()], 'America/Chicago', { alerts: [5 as unknown as string] }), BEFORE)).toThrow(InvalidCalendarDataError);
  });
  it('a past event is labeled past on the first line, and only when it is past', () => {
    const before = desc([iss(EXTRAS)], undefined, BEFORE);
    const after = desc([iss(EXTRAS)], undefined, AFTER);
    expect(before).not.toContain('Past event');
    expect(after.split('\n').slice(0, 3)).toEqual(['Past event: these passes have already happened.', '', 'ISS — Saturday, November 14, 2026']);
  });
  it('there is no time-dependent restriction: a past event still exports', () => {
    expect(() => calendarDescription(source([iss()]), Date.UTC(2030, 0, 1))).not.toThrow();
  });
  it('alerts and the past label together: alerts first', () => {
    const t = calendarDescription(source([iss()], 'America/Chicago', { alerts: ['ISS no longer qualifies.'] }), AFTER);
    expect(t.split('\n').slice(0, 2)).toEqual(['⚠ ISS no longer qualifies.', 'Past event: these passes have already happened.']);
  });
});

describe('older saved events: one concise note, nothing inferred', () => {
  const old = desc([iss(), so50a()]);
  it('omits direction and threshold lines and says ONCE that some details were not saved', () => {
    expect(old).not.toMatch(/^Direction|^Above /m);
    expect(old.match(/Some details were not saved with this older event, so they are left out\./g)).toHaveLength(1);
    expect(old).toContain('Pass: 5:32:04–5:42:50 PM'); // everything that WAS saved is still exact
  });
  it('a new event with every detail stored has no such note, and a stored "never above" is stated, not omitted', () => {
    expect(desc([iss(EXTRAS)])).not.toContain('not saved');
    expect(desc([iss({ ...EXTRAS, aboveThreshold: null })])).toContain('Above 40°: none');
  });
  it('the builder never reads current predictions: it imports no prediction, planner, storage or network code', () => {
    const src = readFileSync('src/export/calendar.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention these words
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(['../catalog/catalog.ts', '../domain/policy.ts', '../domain/types.ts', '../saved/saved.ts']); // saved.ts: types only
    for (const banned of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'navigator.', 'document.', 'window.', 'globalThis']) expect(code).not.toContain(banned);
  });
});

describe('time zones and clock formats', () => {
  it('descriptions use the saved planning zone: Kolkata (+5:30, next day) and Auckland (+13)', () => {
    const kolkata = desc([iss()], 'Asia/Kolkata');
    expect(kolkata.split('\n').slice(0, 2)).toEqual(['ISS — Sunday, November 15, 2026', 'All times GMT+5:30']);
    expect(kolkata).toContain('Pass: 5:02:04–5:12:50 AM');
    const auckland = desc([iss()], 'Pacific/Auckland');
    expect(auckland.split('\n').slice(0, 2)).toEqual(['ISS — Sunday, November 15, 2026', 'All times GMT+13']);
    expect(auckland).toContain('Pass: 12:32:04–12:42:50 PM');
  });
  it('AM/PM is written once when both ends share it, and kept on both when they do not', () => {
    const noon = pass({ noradId: ISS, name: 'ISS', riseMs: Date.UTC(2026, 10, 14, 17, 55, 0), peakMs: Date.UTC(2026, 10, 14, 18, 0, 0), setMs: Date.UTC(2026, 10, 14, 18, 4, 0) }); // 11:55 AM to 12:04 PM CST
    expect(desc([noon])).toContain('Pass: 11:55:00 AM–12:04:00 PM');
    expect(desc([iss(EXTRAS)])).toContain('Pass: 5:32:04–5:42:50 PM');
  });
  it('a pass that ends after local midnight shows the end date', () => {
    const night = pass({ noradId: ISS, name: 'ISS', riseMs: Date.UTC(2026, 10, 15, 5, 55, 0), peakMs: Date.UTC(2026, 10, 15, 6, 0, 0), setMs: Date.UTC(2026, 10, 15, 6, 5, 0) }); // 11:55 PM to 12:05 AM CST
    expect(desc([night])).toContain('Pass: 11:55:00 PM–12:05:00 AM (Sun, Nov 15)');
  });
  it('across the US spring-forward the UTC calendar times stay exact and every time names its own zone', () => {
    const rise = Date.UTC(2027, 2, 14, 7, 55, 0); // 1:55 AM CST, five minutes before the clocks jump
    const s = source([pass({ noradId: ISS, name: 'ISS', riseMs: rise, peakMs: Date.UTC(2027, 2, 14, 8, 2, 0), setMs: Date.UTC(2027, 2, 14, 8, 10, 0) })]);
    const times = calendarTimes(s.original.counted);
    expect(times.startMs).toBe(Date.UTC(2027, 2, 14, 7, 45, 0));
    expect(times.endMs).toBe(Date.UTC(2027, 2, 14, 8, 15, 0));
    const d = calendarDescription(s, Date.UTC(2027, 2, 1));
    expect(d).toContain('the clocks change during this event');
    expect(d).toContain('Pass: 1:55:00 AM CST–3:10:00 AM CDT');
    expect(d).not.toContain('All times');
  });
  it('the description follows the SAVED zone, not the process zone', () => {
    const asChicago = (tz: string) => {
      const script = `import { calendarDescription } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/export/calendar.ts')).href)};
        const i = JSON.parse(process.env.SRC_JSON); process.stdout.write(calendarDescription(i.source, i.exportedAt));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz, SRC_JSON: JSON.stringify({ source: source([iss()], 'America/Chicago'), exportedAt: BEFORE }) }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };
    const a = asChicago('Pacific/Auckland');
    expect(a).toContain('All times CST');
    expect(a).toContain('Pass: 5:32:04–5:42:50 PM');
    expect(a).toBe(asChicago('UTC'));
  }, 60_000);
});

describe('the export is a pure snapshot', () => {
  const deepFreeze = <T,>(o: T): T => {
    if (o && typeof o === 'object') for (const v of Object.values(o)) deepFreeze(v);
    return Object.freeze(o);
  };
  it('does not modify the saved event (even a deep-frozen one) and is deterministic', () => {
    const s = deepFreeze(source([iss(EXTRAS), so50a(EXTRAS)]));
    const first = calendarDescription(s, BEFORE);
    expect(calendarDescription(s, BEFORE)).toEqual(first);
    expect(s.window).toEqual({ start: T1, end: Date.UTC(2026, 10, 15, 0, 22, 30) }); // the saved window is untouched
  });
  it('makes no network request', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    calendarDescription(source([iss(EXTRAS), so50a(EXTRAS)]), BEFORE);
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
