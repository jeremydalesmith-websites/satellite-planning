// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCalendarExport } from '../src/export/ics.ts';
import type { PredictionMeta } from '../src/planner.ts';
import { recheckSavedEvent } from '../src/saved/recheck.ts';
import { isSavedEvent, snapshotEvent } from '../src/saved/saved.ts';
import type { SavedEvent } from '../src/saved/saved.ts';
import { downloadTextFile } from '../src/ui/download.ts';
import { SavedEvents } from '../src/ui/SavedEvents.tsx';
import { SO50, T0, assessed, at, iv } from './factory.ts';

/**
 * "Add to calendar" on saved-event cards. The file is built from the event AS SAVED (saved times and details, never recalculated
 * ones); the only thing taken from the current re-check is a lost-eligibility warning, which goes at the top. No network, no
 * change to storage, and an unusable event shows a message instead of crashing.
 */
vi.mock('../src/saved/recheck.ts', () => ({ recheckSavedEvent: vi.fn() }));
const recheck = vi.mocked(recheckSavedEvent);

const ISS = 25544;
const meta: PredictionMeta = { generatedAtMs: at(-1000), elementsDownloadedAt: new Date(at(-1000)).toISOString(), statusDownloadedAt: null, epochs: {} };
const criteria = { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 1 };
const NOW = T0; // the page's "now": before every event below unless a test says otherwise

const makeEvent = (id: string, rise: number, set: number, norad = ISS): SavedEvent => {
  const a = assessed({ norad, rise, set, maxEl: 60 });
  return snapshotEvent({ window: iv(rise, set), counted: [a], distinctSatellites: 1, totalOperatingMs: a.operatingMs }, { latDeg: 42.35, lonDeg: -71.06 }, 'America/Chicago', criteria, meta, at(-500), id);
};
/** An event saved before the optional details existed. */
const stripDetails = (ev: SavedEvent): SavedEvent => ({
  ...ev,
  original: { ...ev.original, counted: ev.original.counted.map(({ riseAzDeg, setAzDeg, aboveThreshold, sunlight, ...rest }) => { void [riseAzDeg, setAzDeg, aboveThreshold, sunlight]; return rest; }) },
});

const notOk = { ok: false as const, message: 'Current orbital and status data could not be loaded, so eligibility could not be re-confirmed.' };
const okOutcome = (lost: Array<{ noradId: number; name: string; peakMs: number; reason: string }> = []) => ({
  ok: true as const,
  recheck: { evaluation: { counted: [], alternatives: [], edge: [], excluded: [] }, changes: [], lostEligibility: lost, countNow: 0, countBefore: 1, meetsMinimum: false },
  passed: false, nowMs: NOW, skippedNote: null, statusDownloadedAt: null,
}) as unknown as ReturnType<typeof recheckSavedEvent>;

interface Download { filename: string; mime: string; text: string }
let downloads: Download[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
  vi.setSystemTime(NOW);
  downloads = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => { const u = `blob:test-${n++}`; blobs.set(u, b); return u; }),
    revokeObjectURL: vi.fn(),
  }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href) ?? blobs.get(this.getAttribute('href') ?? '');
    downloads.push({ filename: this.download, mime: blob?.type ?? '', text: (blob as unknown as { __text?: string })?.__text ?? '' });
  });
  // jsdom's Blob has no text(): remember the text a Blob was made from
  const RealBlob = Blob;
  vi.stubGlobal('Blob', class extends RealBlob { __text: string; constructor(parts: BlobPart[], o?: BlobPropertyBag) { super(parts, o); this.__text = parts.join(''); } });
  recheck.mockReturnValue(notOk);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); recheck.mockReset(); });

const show = (events: SavedEvent[], nowMs = NOW) => render(<SavedEvents events={events} data={null} nowMs={nowMs} onDelete={() => {}} />);
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);
const prop = (ics: string, name: string) => unfold(ics).find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
const unescape = (v: string) => v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
const description = (ics: string) => unescape(prop(ics, 'DESCRIPTION')!);

describe('the button', () => {
  it('is on every saved-event card, beside Delete, with the same plain button styling', () => {
    show([makeEvent('a', 120, 131), makeEvent('b', 300, 311)]);
    const buttons = screen.getAllByRole('button', { name: 'Add to calendar' });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.getAttribute('type')).toBe('button');
      expect(b.className).toBe(''); // no special class: the default button look, unlike the red Delete
      expect(b.parentElement!.querySelector('button.danger')).toBeTruthy();
    }
  });
  it('downloads ONE .ics file named from the event, with the calendar MIME type', () => {
    show([makeEvent('a', 120, 131)]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.filename).toMatch(/^ISS-60deg-11m-20270109-1100\.ics$/);
    expect(downloads[0]!.mime).toBe('text/calendar;charset=utf-8');
    expect(downloads[0]!.text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  });
  it('tells the person it is a static copy that will not update', () => {
    show([makeEvent('a', 120, 131)]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    const note = screen.getByRole('status').textContent!;
    expect(note).toMatch(/Calendar file downloaded \(ISS-60deg-11m-20270109-1100\.ics\)/);
    expect(note).toMatch(/static copy of the saved plan and will not update if predictions change/);
  });
  it('makes no network request and does not change the saved events', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    const ev = makeEvent('a', 120, 131);
    const before = JSON.stringify(ev);
    localStorage.setItem('sentinel', 'x');
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(ev)).toBe(before);
    expect(localStorage.length).toBe(1); // nothing was written
    localStorage.clear();
  });
});

describe('the file uses the SAVED times and details', () => {
  it('is exactly what the builder makes from the saved event, whatever the re-check says', () => {
    const ev = makeEvent('a', 120, 131);
    const expected = buildCalendarExport({ ...ev, alerts: [] }, NOW).content;
    // re-check unavailable
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(downloads[0]!.text).toBe(expected);
    // re-check available and showing very different predictions: still the saved times
    cleanup();
    recheck.mockReturnValue(okOutcome());
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(downloads[1]!.text).toBe(expected);
    expect(prop(downloads[1]!.text, 'DTSTART')).toBe('20270109T165000Z'); // saved AOS 17:00 UTC minus 10 minutes
    expect(prop(downloads[1]!.text, 'DTEND')).toBe('20270109T171600Z'); // saved LOS 17:11 UTC plus 5 minutes
  });
  it('start is 10 minutes before the saved AOS and end is 5 minutes after the saved LOS', () => {
    const ev = makeEvent('a', 120, 131);
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    const start = prop(downloads[0]!.text, 'DTSTART')!;
    const end = prop(downloads[0]!.text, 'DTEND')!;
    const ms = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
    expect(ms(start)).toBeLessThanOrEqual(ev.window.start - 10 * 60_000);
    expect(ms(start)).toBeGreaterThan(ev.window.start - 10 * 60_000 - 1000);
    expect(ms(end)).toBeGreaterThanOrEqual(ev.window.end + 5 * 60_000);
    expect(ms(end)).toBeLessThan(ev.window.end + 5 * 60_000 + 1000);
  });
  it('a newly saved event carries directions and the threshold interval; an older event gets one note and no invented details', () => {
    const fresh = makeEvent('new', 120, 131);
    show([fresh]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    const d = description(downloads[0]!.text);
    expect(d).toContain('Direction: N → SSW'); // the test geometry rises at 10° and sets at 200°
    expect(d).toMatch(/Above 40°: .*–.* · 2 min 00 s/);
    expect(d).not.toContain('not saved');
    cleanup();
    show([stripDetails(fresh)]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    const o = description(downloads[1]!.text);
    expect(o).not.toMatch(/^Direction|^Above /m);
    expect(o.match(/Some details were not saved with this older event/g)).toHaveLength(1);
    expect(o).toContain('Pass: 11:00:00–11:11:00 AM'); // everything that WAS saved is exact
  });
});

describe('a current lost-eligibility warning goes first', () => {
  const lost = [{ noradId: ISS, name: 'ISS', peakMs: at(125), reason: 'no qualifying FM report in the last 72 hours' }];
  it('is the first line of the description, and the saved times are unchanged', () => {
    const ev = makeEvent('a', 120, 131);
    recheck.mockReturnValue(okOutcome(lost));
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    const d = description(downloads[0]!.text);
    expect(d.split('\n')[0]).toBe('⚠ ISS no longer qualifies: no qualifying FM report in the last 72 hours. Re-check before the event.');
    expect(d.split('\n')[2]).toBe('ISS — Saturday, January 9, 2027'); // the heading follows the warning
    expect(prop(downloads[0]!.text, 'DTSTART')).toBe(prop(buildCalendarExport({ ...ev, alerts: [] }, NOW).content, 'DTSTART'));
  });
  it('is absent when nothing was lost, and when the re-check could not run (nothing is guessed)', () => {
    const ev = makeEvent('a', 120, 131);
    recheck.mockReturnValue(okOutcome());
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(description(downloads[0]!.text)).not.toContain('⚠');
    cleanup();
    recheck.mockReturnValue(notOk);
    show([ev]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(description(downloads[1]!.text)).not.toContain('⚠');
  });
});

describe('past events and unusable events', () => {
  it('a past event still exports, and the file says it is past', () => {
    const ev = makeEvent('old', 120, 131);
    show([ev], at(10_000));
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(downloads).toHaveLength(1);
    // the builder's "now" is the system clock: move it past the event
    cleanup();
    vi.setSystemTime(at(10_000));
    show([ev], at(10_000));
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(description(downloads[1]!.text).split('\n')[0]).toBe('Past event: these passes have already happened.');
  });
  it('an event whose saved pass data is broken shows a message, downloads nothing, and does not crash the page', () => {
    const ev = makeEvent('bad', 120, 131);
    const broken: SavedEvent = { ...ev, original: { ...ev.original, counted: [{ ...ev.original.counted[0]!, setMs: ev.original.counted[0]!.riseMs - 60_000 }] } };
    show([broken, makeEvent('ok', 300, 311)]);
    const cards = screen.getAllByRole('article');
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Add to calendar' }));
    expect(downloads).toHaveLength(0);
    expect(within(cards[0]!).getByRole('alert').textContent).toMatch(/Cannot export: pass 1 \(ISS\) has a LOS at or before its AOS\. Nothing was downloaded\./);
    // the other card still works
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Add to calendar' }));
    expect(downloads).toHaveLength(1);
  });
});

describe('newly saved events store the optional details; existing events are untouched', () => {
  it('snapshotEvent keeps directions, the threshold interval and sunlight, and the event still validates and round-trips through JSON', () => {
    const ev = makeEvent('a', 120, 131);
    const p = ev.original.counted[0]!;
    expect(p.riseAzDeg).toBe(10);
    expect(p.setAzDeg).toBe(200);
    expect(p.aboveThreshold).toEqual(iv(124.5, 126.5)); // 1 minute either side of the peak in the test geometry
    expect(p.sunlight).toBe('illuminated');
    expect(isSavedEvent(JSON.parse(JSON.stringify(ev)))).toBe(true);
  });
  it('an event saved before these fields existed is still valid and is not modified', () => {
    const old = stripDetails(makeEvent('a', 120, 131));
    const before = JSON.stringify(old);
    expect(isSavedEvent(JSON.parse(before))).toBe(true);
    show([old]);
    fireEvent.click(screen.getByRole('button', { name: 'Add to calendar' }));
    expect(JSON.stringify(old)).toBe(before);
    expect(Object.keys(old.original.counted[0]!)).not.toContain('riseAzDeg');
  });
  it('a pass that never reached the threshold is stored as null (not "unknown")', () => {
    const a = assessed({ norad: SO50, rise: 120, set: 131, maxEl: 60, above: null });
    const ev = snapshotEvent({ window: iv(120, 131), counted: [a], distinctSatellites: 1, totalOperatingMs: a.operatingMs }, { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'n');
    expect(ev.original.counted[0]!.aboveThreshold).toBeNull();
  });
});

describe('downloadTextFile', () => {
  it('makes a Blob of the right type, clicks a hidden download link once, removes it, and releases the address later', () => {
    const create = vi.mocked(URL.createObjectURL);
    const revoke = vi.mocked(URL.revokeObjectURL);
    downloadTextFile('x.ics', 'BEGIN:VCALENDAR', 'text/calendar;charset=utf-8');
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0]![0] as Blob).type).toBe('text/calendar;charset=utf-8');
    expect(downloads).toEqual([{ filename: 'x.ics', mime: 'text/calendar;charset=utf-8', text: 'BEGIN:VCALENDAR' }]);
    expect(document.querySelector('a[download]')).toBeNull(); // removed again
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_001);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

