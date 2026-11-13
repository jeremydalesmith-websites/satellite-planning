// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGoogleCalendarUrl } from '../src/export/googleCalendar.ts';
import type { PredictionMeta } from '../src/planner.ts';
import { recheckSavedEvent } from '../src/saved/recheck.ts';
import { isSavedEvent, snapshotEvent } from '../src/saved/saved.ts';
import type { SavedEvent } from '../src/saved/saved.ts';
import { SavedEvents } from '../src/ui/SavedEvents.tsx';
import { SO50, T0, assessed, at, iv } from './factory.ts';

/**
 * "Add to Google Calendar" on saved-event cards: an ordinary link that opens Google Calendar with the event prefilled. It is built
 * from the event AS SAVED (saved times and details, never recalculated ones); the only thing taken from the current re-check is a
 * lost-eligibility warning, which goes first in the description. No network, no change to storage, and an unusable event shows a
 * message instead of a link.
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
  vi.setSystemTime(NOW);
  recheck.mockReturnValue(notOk);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); recheck.mockReset(); });

const show = (events: SavedEvent[], nowMs = NOW) => render(<SavedEvents events={events} data={null} nowMs={nowMs} onDelete={() => {}} />);
const linkOf = (card: HTMLElement) => within(card).getByRole('link', { name: 'Add to Google Calendar' }) as HTMLAnchorElement;
const fields = (href: string) => {
  const u = new URL(href);
  return { text: u.searchParams.get('text')!, dates: u.searchParams.get('dates')!, ctz: u.searchParams.get('ctz')!, details: u.searchParams.get('details')! };
};

describe('the link', () => {
  it('is on every saved-event card, beside Delete, opening Google Calendar in a new tab', () => {
    show([makeEvent('a', 120, 131), makeEvent('b', 300, 311)]);
    const links = screen.getAllByRole('link', { name: 'Add to Google Calendar' }) as HTMLAnchorElement[];
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(l.href.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&text=')).toBe(true);
      expect(l.getAttribute('target')).toBe('_blank');
      expect(l.getAttribute('rel')).toBe('noopener noreferrer');
      expect(l.className).toBe('button-link');
      expect(l.parentElement!.querySelector('button.danger')).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /Add to calendar/i })).toBeNull(); // the old download button is gone
  });
  it('prefills the approved title, buffered dates, zone and compact plain-text description from the SAVED event', () => {
    show([makeEvent('a', 120, 131)]);
    const f = fields(linkOf(screen.getByRole('article')).href);
    expect(f.text).toBe('ISS 60° 11m');
    expect(f.dates).toBe('20270109T165000Z/20270109T171600Z'); // saved AOS 17:00 UTC minus 10 min; saved LOS 17:11 UTC plus 5 min
    expect(f.ctz).toBe('America/Chicago');
    expect(f.details.split('\n').slice(0, 4)).toEqual(['ISS — Saturday, January 9, 2027', 'All times CST', '', 'Pass: 11:00:00–11:11:00 AM']);
    expect(f.details).not.toMatch(/<[a-z/][^>]*>/i);
  });
  it('is exactly what the builder makes from the saved event, whatever the re-check says', () => {
    const ev = makeEvent('a', 120, 131);
    const expected = buildGoogleCalendarUrl({ ...ev, alerts: [] }, NOW);
    show([ev]);
    expect(linkOf(screen.getByRole('article')).href).toBe(expected);
    cleanup();
    recheck.mockReturnValue(okOutcome()); // re-check available and showing nothing lost
    show([ev]);
    expect(linkOf(screen.getByRole('article')).href).toBe(expected);
  });
  it('says it opens Google Calendar to save there, and that it is a one-time copy that will not update', () => {
    show([makeEvent('a', 120, 131)]);
    const note = screen.getByRole('article').textContent!;
    expect(note).toMatch(/opens Google Calendar with this event filled in; save it there/);
    expect(note).toMatch(/one-time copy of the saved plan and will not update if predictions change/);
  });
  it('makes no network request, and does not change the saved events or storage', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network access is not allowed'); });
    vi.stubGlobal('fetch', fetchSpy);
    const ev = makeEvent('a', 120, 131);
    const before = JSON.stringify(ev);
    localStorage.setItem('sentinel', 'x');
    show([ev]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(ev)).toBe(before);
    expect(localStorage.length).toBe(1);
    localStorage.clear();
  });
});

describe('a current lost-eligibility warning goes first', () => {
  const lost = [{ noradId: ISS, name: 'ISS', peakMs: at(125), reason: 'no qualifying FM report in the last 72 hours' }];
  it('is the first line of the description, and the saved times are unchanged', () => {
    const ev = makeEvent('a', 120, 131);
    recheck.mockReturnValue(okOutcome(lost));
    show([ev]);
    const f = fields(linkOf(screen.getByRole('article')).href);
    expect(f.details.split('\n')[0]).toBe('⚠ ISS no longer qualifies: no qualifying FM report in the last 72 hours. Re-check before the event.');
    expect(f.details.split('\n')[2]).toBe('ISS — Saturday, January 9, 2027');
    expect(f.dates).toBe('20270109T165000Z/20270109T171600Z');
  });
  it('is absent when nothing was lost, and when the re-check could not run (nothing is guessed)', () => {
    const ev = makeEvent('a', 120, 131);
    recheck.mockReturnValue(okOutcome());
    show([ev]);
    expect(fields(linkOf(screen.getByRole('article')).href).details).not.toContain('⚠');
    cleanup();
    recheck.mockReturnValue(notOk);
    show([ev]);
    expect(fields(linkOf(screen.getByRole('article')).href).details).not.toContain('⚠');
  });
});

describe('older, newer, past and unusable events', () => {
  it('a newly saved event carries directions and the threshold interval; an older event gets one note and no invented details', () => {
    const fresh = makeEvent('new', 120, 131);
    show([fresh]);
    const d = fields(linkOf(screen.getByRole('article')).href).details;
    expect(d).toContain('Direction: N → SSW'); // the test geometry rises at 10° and sets at 200°
    expect(d).toMatch(/Above 40°: .*–.* · 2 min 00 s/);
    expect(d).not.toContain('not saved');
    cleanup();
    show([stripDetails(fresh)]);
    const o = fields(linkOf(screen.getByRole('article')).href).details;
    expect(o).not.toMatch(/^Direction|^Above /m);
    expect(o.match(/Some details were not saved with this older event/g)).toHaveLength(1);
    expect(o).toContain('Pass: 11:00:00–11:11:00 AM');
  });
  it('a past event still has the link, and the description says it is past', () => {
    show([makeEvent('old', 120, 131)], at(10_000));
    expect(fields(linkOf(screen.getByRole('article')).href).details.split('\n')[0]).toBe('Past event: these passes have already happened.');
  });
  it('a past event gets no "re-check before the event" warning, even if the re-check reports a loss', () => {
    recheck.mockReturnValue({ ...(okOutcome([{ noradId: ISS, name: 'ISS', peakMs: at(125), reason: 'no qualifying FM report' }]) as object), passed: true } as unknown as ReturnType<typeof recheckSavedEvent>);
    show([makeEvent('old', 120, 131)], at(10_000));
    const d = fields(linkOf(screen.getByRole('article')).href).details;
    expect(d.split('\n')[0]).toBe('Past event: these passes have already happened.');
    expect(d).not.toContain('⚠');
  });
  it('an event whose saved pass data is broken shows a message instead of a link, and the other cards are unaffected', () => {
    const ev = makeEvent('bad', 120, 131);
    const broken: SavedEvent = { ...ev, original: { ...ev.original, counted: [{ ...ev.original.counted[0]!, setMs: ev.original.counted[0]!.riseMs - 60_000 }] } };
    show([broken, makeEvent('ok', 300, 311)]);
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]!).queryByRole('link', { name: 'Add to Google Calendar' })).toBeNull();
    expect((within(cards[0]!).getByRole('button', { name: 'Add to Google Calendar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(cards[0]!).getByRole('alert').textContent).toBe('Cannot export: pass 1 (ISS) has a LOS at or before its AOS. Nothing can be added to a calendar for this event.');
    expect(linkOf(cards[1]!).href).toContain('calendar.google.com');
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
    expect(JSON.stringify(old)).toBe(before);
    expect(Object.keys(old.original.counted[0]!)).not.toContain('riseAzDeg');
  });
  it('a direction that could not be computed is left out (not stored as NaN/null) and the link still works', () => {
    const a = assessed({ norad: ISS, rise: 120, set: 131, maxEl: 60 });
    const ev = snapshotEvent({ window: iv(120, 131), counted: [{ ...a, riseAzDeg: NaN }], distinctSatellites: 1, totalOperatingMs: a.operatingMs }, { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'n');
    const p = JSON.parse(JSON.stringify(ev)).original.counted[0];
    expect('riseAzDeg' in p).toBe(false);
    show([ev]);
    expect(linkOf(screen.getByRole('article')).href).toContain('calendar.google.com');
  });
  it('a pass that never reached the threshold is stored as null (not "unknown")', () => {
    const a = assessed({ norad: SO50, rise: 120, set: 131, maxEl: 60, above: null });
    const ev = snapshotEvent({ window: iv(120, 131), counted: [a], distinctSatellites: 1, totalOperatingMs: a.operatingMs }, { latDeg: 1, lonDeg: 2 }, 'UTC', criteria, meta, at(0), 'n');
    expect(ev.original.counted[0]!.aboveThreshold).toBeNull();
  });
});
