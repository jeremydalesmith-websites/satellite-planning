import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_TEMPLATE_URL, buildGoogleCalendarUrl } from '../src/export/googleCalendar.ts';
import { InvalidCalendarDataError, buildCalendarExport, calendarDescription, calendarTitle } from '../src/export/ics.ts';
import type { CalendarPass, CalendarSource } from '../src/export/ics.ts';

/**
 * "Add to Google Calendar": a prefilled event link for a SAVED event. It must carry exactly what the approved calendar builder
 * produces (title, setup/post-pass buffers, compact plain-text description, validation), and nothing else.
 */
const ISS = 25544;
const SO50 = 27607;
const AO91 = 43017;
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
const EXTRAS = { riseAzDeg: 22, setAzDeg: 158, aboveThreshold: { start: Date.UTC(2026, 10, 14, 23, 34, 10), end: Date.UTC(2026, 10, 14, 23, 40, 30) } };
const iss = (extra: Partial<CalendarPass> = {}) => pass({ noradId: ISS, name: 'ISS', riseMs: T1, peakMs: Date.UTC(2026, 10, 14, 23, 37, 20), setMs: T1 + 646_200, fullMaxElevationDeg: 75.2, ...EXTRAS, ...extra });
const so50a = (extra: Partial<CalendarPass> = {}) => pass({ noradId: SO50, name: 'SO-50', riseMs: Date.UTC(2026, 10, 15, 0, 10, 30), peakMs: Date.UTC(2026, 10, 15, 0, 16, 15), setMs: Date.UTC(2026, 10, 15, 0, 22, 30), fullMaxElevationDeg: 62.4, ...EXTRAS, ...extra });
const so50b = (extra: Partial<CalendarPass> = {}) => pass({ noradId: SO50, name: 'SO-50', riseMs: Date.UTC(2026, 10, 15, 1, 48, 0), peakMs: Date.UTC(2026, 10, 15, 1, 53, 40), setMs: Date.UTC(2026, 10, 15, 1, 59, 12), fullMaxElevationDeg: 70.2, ...EXTRAS, ...extra });
const source = (counted: CalendarPass[], tz = 'America/Chicago', over: Partial<CalendarSource> = {}): CalendarSource => ({
  id: 'ev-test-1',
  savedAtMs: Date.UTC(2026, 10, 12, 18, 0, 0),
  window: { start: Math.min(...counted.map((p) => p.riseMs)), end: Math.max(...counted.map((p) => p.setMs)) },
  timeZone: tz,
  criteria: { minElevationDeg: 40 },
  original: { counted },
  ...over,
});
const BEFORE = Date.UTC(2026, 10, 13, 12, 0, 0);
const parts = (url: string) => {
  const u = new URL(url);
  return { u, keys: [...u.searchParams.keys()], text: u.searchParams.get('text')!, dates: u.searchParams.get('dates')!, ctz: u.searchParams.get('ctz')!, details: u.searchParams.get('details')! };
};
const prop = (ics: string, name: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

afterEach(() => vi.restoreAllMocks());

describe('the link', () => {
  const url = buildGoogleCalendarUrl(source([iss()]), BEFORE);
  const p = parts(url);

  it('is Google\'s event-template address with exactly the five parameters we mean to send, in a fixed order', () => {
    expect(url.startsWith(`${GOOGLE_CALENDAR_TEMPLATE_URL}?action=TEMPLATE&text=`)).toBe(true);
    expect(GOOGLE_CALENDAR_TEMPLATE_URL).toBe('https://calendar.google.com/calendar/render');
    expect(p.keys).toEqual(['action', 'text', 'dates', 'ctz', 'details']);
    expect(p.u.searchParams.get('action')).toBe('TEMPLATE');
  });
  it('carries no location, coordinates, guests, calendar, reminders or recurrence', () => {
    for (const banned of ['location', 'add', 'src', 'targ', 'recur', 'erem', 'crm', 'trp', 'vcon', 'sprop', 'pprop']) expect(p.keys).not.toContain(banned);
  });
  it('the title is the approved one: "ISS 75° 11m" (full-pass maximum, AOS-to-LOS minutes, no buffers)', () => {
    expect(p.text).toBe('ISS 75° 11m');
    expect(p.text).toBe(calendarTitle([iss()]));
  });
  it('dates are UTC, start to end, with the 10-minute setup before and 5 minutes after: the same instants as the .ics file', () => {
    expect(p.dates).toBe('20261114T232204Z/20261114T234751Z');
    const ics = buildCalendarExport(source([iss()]), BEFORE).content;
    expect(p.dates).toBe(`${prop(ics, 'DTSTART')}/${prop(ics, 'DTEND')}`);
    expect(url).toContain('&dates=20261114T232204Z/20261114T234751Z&'); // the slash is literal, as in Google's own examples
  });
  it('ctz is the saved planning zone', () => {
    expect(p.ctz).toBe('America/Chicago');
    expect(parts(buildGoogleCalendarUrl(source([iss()], 'Asia/Kolkata'), BEFORE)).ctz).toBe('Asia/Kolkata');
    expect(parts(buildGoogleCalendarUrl(source([iss()], 'Pacific/Auckland'), BEFORE)).ctz).toBe('Pacific/Auckland');
  });
  it('details are the approved compact description as PLAIN TEXT with real line breaks (no HTML)', () => {
    expect(p.details).toBe(calendarDescription(source([iss()]), BEFORE));
    expect(p.details.split('\n').slice(0, 4)).toEqual(['ISS — Saturday, November 14, 2026', 'All times CST', '', 'Pass: 5:32:04–5:42:50 PM']);
    expect(p.details).not.toMatch(/<[a-z/][^>]*>/i);
    expect(p.details).not.toMatch(/&(?:lt|gt|amp|nbsp);/);
    expect(p.details.split('\n').slice(-2)).toEqual(['Static calendar copy—recheck times and status:', 'https://k1kfx.com/satellites/']);
    expect(url).toContain('%0A'); // newlines are percent-encoded
  });
  it('the whole link is plain ASCII with nothing that could break it in a message: no spaces, line breaks, quotes, parentheses or asterisks', () => {
    expect(url).toMatch(/^[\x21-\x7e]+$/);
    expect(url).not.toMatch(/[ \n\r"'()*<>\\]/);
  });
});

describe('several passes and alerts', () => {
  it('a multi-pass event keeps the approved multi-pass title and one description with every pass', () => {
    const p = parts(buildGoogleCalendarUrl(source([so50b(), iss(), so50a()]), BEFORE));
    expect(p.text).toBe('3 passes: ISS 75°, SO-50 62°, SO-50 70°');
    expect(p.dates).toBe('20261114T232204Z/20261115T020412Z');
    expect(p.details.startsWith('3 passes — Saturday, November 14, 2026\nAll times CST\nSpan: 2 h 27 min 08 s')).toBe(true);
    expect(p.details.match(/^Pass: /gm)).toHaveLength(3);
  });
  it('caller-supplied alerts (a lost eligibility from the latest re-check) come first in the description', () => {
    const p = parts(buildGoogleCalendarUrl(source([iss()], 'America/Chicago', { alerts: ['ISS no longer qualifies: no qualifying FM report in the last 72 hours. Re-check before the event.'] }), BEFORE));
    expect(p.details.split('\n')[0]).toBe('⚠ ISS no longer qualifies: no qualifying FM report in the last 72 hours. Re-check before the event.');
    expect(p.details.split('\n')[2]).toBe('ISS — Saturday, November 14, 2026');
  });
  it('a past event is labeled past in the description', () => {
    expect(parts(buildGoogleCalendarUrl(source([iss()]), Date.UTC(2026, 10, 16))).details.split('\n')[0]).toBe('Past event: these passes have already happened.');
  });
  it('a sunlight-limited pass keeps its sunlit-peak line right under the heading', () => {
    const ao = pass({ noradId: AO91, name: 'AO-91', riseMs: T1, setMs: T1 + 666_000, fullMaxElevationDeg: 85.2, eligibleMaxElevationDeg: 62.4, operatingMs: 492_000, ...EXTRAS });
    expect(parts(buildGoogleCalendarUrl(source([ao]), BEFORE)).details.split('\n')[3]).toMatch(/^Sunlight only: works only while the satellite is in sunlight; sunlit peak 62° \(pass peak 85°\); sunlit operating time /);
  });
});

describe('encoding', () => {
  it('survives every character that could break a link, and the non-ASCII ones in our own text', () => {
    const nasty = `a&b=c#d+e%f "q" (p) *s* !t 'u' ; , \\ / ? <b> 🛰 é`;
    const p = parts(buildGoogleCalendarUrl(source([iss()]), BEFORE, { titlePrefix: `${nasty} `, descriptionPrefix: nasty }));
    expect(p.text).toBe(`${nasty} ISS 75° 11m`);
    expect(p.details.startsWith(`${nasty}\n\nISS — Saturday`)).toBe(true);
    expect(p.details).toContain('Peak: 5:37:20 PM · 75°'); // · and ° round-trip
    expect(p.details).toContain('Direction: NNE → SSE'); // → round-trips
    expect(buildGoogleCalendarUrl(source([iss()]), BEFORE, { descriptionPrefix: nasty })).toMatch(/^[\x21-\x7e]+$/);
  });
  it('link lengths stay modest: about 0.8 KB for one pass, and a few KB for long events (no limit is documented, so this is recorded, not assumed)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => pass({ noradId: i % 2 ? SO50 : ISS, name: i % 2 ? 'SO-50' : 'ISS', riseMs: T1 + i * 35 * 60_000, setMs: T1 + i * 35 * 60_000 + 640_000, fullMaxElevationDeg: 60 + i, ...EXTRAS, aboveThreshold: { start: T1 + i * 35 * 60_000 + 100_000, end: T1 + i * 35 * 60_000 + 500_000 } }));
    const len = (n: number) => buildGoogleCalendarUrl(source(many(n)), BEFORE).length;
    expect(len(1)).toBeLessThan(1000);
    expect(len(3)).toBeLessThan(2200);
    expect(len(5)).toBeLessThan(3000);
    expect(len(8)).toBeLessThan(4200);
  });
});

describe('the same validation as the calendar file', () => {
  const broken: Array<[string, Partial<CalendarPass>]> = [
    ['LOS before AOS', { setMs: T1 - 60_000, peakMs: T1 - 90_000 }],
    ['LOS equal to AOS', { setMs: T1, peakMs: T1 }],
    ['NaN AOS', { riseMs: NaN }],
    ['peak outside the pass', { peakMs: T1 + 700_000 }],
    ['NaN elevation', { fullMaxElevationDeg: NaN }],
  ];
  it.each(broken)('%s: no link is produced', (_name, over) => {
    expect(() => buildGoogleCalendarUrl(source([iss(over)]), BEFORE)).toThrow(InvalidCalendarDataError);
  });
  it('an invalid time zone, export time or alerts list is rejected; so is an event with no passes', () => {
    expect(() => buildGoogleCalendarUrl(source([iss()], 'Mars/Olympus'), BEFORE)).toThrow(InvalidCalendarDataError);
    expect(() => buildGoogleCalendarUrl(source([iss()]), NaN)).toThrow(InvalidCalendarDataError);
    expect(() => buildGoogleCalendarUrl(source([iss()], 'America/Chicago', { alerts: [5 as unknown as string] }), BEFORE)).toThrow(InvalidCalendarDataError);
    expect(() => buildGoogleCalendarUrl(source([]), BEFORE)).toThrow(InvalidCalendarDataError);
  });
  it('a broken pass among valid ones rejects the whole event', () => {
    expect(() => buildGoogleCalendarUrl(source([iss(), so50a({ setMs: Date.UTC(2026, 10, 15, 0, 10, 30), peakMs: Date.UTC(2026, 10, 15, 0, 10, 30) })]), BEFORE)).toThrow(/pass 2 \(SO-50\)/);
  });
});

describe('SAMPLE labels', () => {
  it('prefix the title and the description for test links only; a normal link has none', () => {
    const plain = parts(buildGoogleCalendarUrl(source([iss()]), BEFORE));
    const sample = parts(buildGoogleCalendarUrl(source([iss()]), BEFORE, { titlePrefix: 'SAMPLE — ', descriptionPrefix: 'SAMPLE: made-up numbers.' }));
    expect(plain.text).toBe('ISS 75° 11m');
    expect(sample.text).toBe('SAMPLE — ISS 75° 11m');
    expect(sample.details.startsWith('SAMPLE: made-up numbers.\n\nISS — ')).toBe(true);
    expect(sample.dates).toBe(plain.dates);
  });
});

describe('a pure snapshot', () => {
  const deepFreeze = <T,>(o: T): T => {
    if (o && typeof o === 'object') for (const v of Object.values(o)) deepFreeze(v);
    return Object.freeze(o);
  };
  it('does not modify the saved event, is deterministic, and makes no network request', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    const s = deepFreeze(source([iss(), so50a()]));
    const first = buildGoogleCalendarUrl(s, BEFORE);
    expect(buildGoogleCalendarUrl(s, BEFORE)).toBe(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('even a full saved event (which holds the observer location) produces a link without it', () => {
    const full = { ...source([iss()]), location: { latDeg: 42.3517, lonDeg: -71.0642 }, selectedNoradIds: [ISS] };
    expect(buildGoogleCalendarUrl(full, BEFORE)).not.toMatch(/42\.35|71\.06|latDeg|lonDeg|location/);
  });
  it('imports only the approved calendar builder: no storage, network or page access', () => {
    const src = readFileSync('src/export/googleCalendar.ts', 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect([...new Set([...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]))].sort()).toEqual(['../domain/types.ts', './ics.ts']);
    for (const banned of ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'navigator.', 'document.', 'window.', 'globalThis']) expect(code).not.toContain(banned);
  });
  it('the link is identical in processes whose system time zone really differs', () => {
    const script = `
      import { buildGoogleCalendarUrl } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/export/googleCalendar.ts')).href)};
      const input = JSON.parse(process.env.SRC_JSON);
      process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(Date.UTC(2026, 10, 14, 23, 32, 4)).getTimezoneOffset(), url: buildGoogleCalendarUrl(input.source, input.exportedAt) }));`;
    const payload = JSON.stringify({ source: source([iss(), so50a()]), exportedAt: BEFORE });
    const runs = ['Pacific/Auckland', 'America/Chicago', 'Asia/Kolkata', 'UTC'].map((tz) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz, SRC_JSON: payload }, encoding: 'utf8' });
      expect(r.status, `${tz}: ${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout) as { zone: string; offset: number; url: string };
    });
    expect(runs.map((r) => r.offset)).toEqual([-780, 360, -330, 0]); // each process really was in a different zone
    for (const r of runs) expect(r.url).toBe(runs[0]!.url);
  }, 60_000);
});

describe('review fixes', () => {
  it('a "+" in the time zone is encoded, so it cannot be read as a space', () => {
    const url = buildGoogleCalendarUrl(source([iss()], 'Etc/GMT+5'), BEFORE);
    expect(url).toContain('&ctz=Etc/GMT%2B5&');
    expect(new URL(url).searchParams.get('ctz')).toBe('Etc/GMT+5');
    expect(new URL(buildGoogleCalendarUrl(source([iss()]), BEFORE)).searchParams.get('ctz')).toBe('America/Chicago');
  });
  it.each([
    ['elevation above 90', { fullMaxElevationDeg: 400 }, /invalid maximum elevation/],
    ['negative elevation', { fullMaxElevationDeg: -12 }, /invalid maximum elevation/],
    ['a pass longer than an hour', { setMs: T1 + 61 * 60_000, peakMs: T1 + 60_000 }, /longer than 60 minutes/],
    ['no satellite name', { name: undefined as unknown as string }, /no satellite name/],
    ['operating time longer than the pass', { operatingMs: 2 * 3600_000 }, /invalid operating time/],
    ['sunlit peak above the pass peak', { eligibleMaxElevationDeg: 89 }, /invalid sunlit elevation/],
  ])('rejects %s', (_n, over, re) => {
    expect(() => buildGoogleCalendarUrl(source([iss(over as Partial<CalendarPass>)]), BEFORE)).toThrow(re);
  });
  it('rejects a threshold interval outside the pass', () => {
    const p = { ...iss(), aboveThreshold: { start: T1 + 86_400_000, end: T1 + 86_400_000 + 1000 } };
    expect(() => buildGoogleCalendarUrl(source([p]), BEFORE)).toThrow(/outside the pass/);
  });
  it('rejects a missing time zone', () => {
    expect(() => buildGoogleCalendarUrl(source([iss()], 'America/Chicago', { timeZone: undefined as unknown as string }), BEFORE)).toThrow(/time zone/);
  });
});
