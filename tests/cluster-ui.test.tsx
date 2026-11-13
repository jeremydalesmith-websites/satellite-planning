// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { computePlan } from '../src/planner.ts';
import { clearLegacyEvents, countLegacyEvents, loadEvents, saveEvents } from '../src/storage.ts';
import { snapshotEvent } from '../src/saved/saved.ts';
import { PlanForm } from '../src/ui/PlanForm.tsx';
import { Results } from '../src/ui/Results.tsx';
import { SavedEvents } from '../src/ui/SavedEvents.tsx';
import { ceilMin, ceilSec, floorMin, floorSec, fmtSpan, fmtSpanMin } from '../src/ui/format.ts';
import { T0, at, geom } from './factory.ts';
import { elementsFixture } from './helpers.ts';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const heard = (key: string): [string, { reports: [number, 'H', number][] }] => [key, { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] }];
const status: StatusFile = {
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString(),
  satellites: Object.fromEntries([heard('SO-50_[FM]'), heard('ISS_[FM]'), heard('AO-91_[FM]')]),
};
const av = emptyAvailability();
for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
const inputs = {
  observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
  criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 2 },
  availability: av, range: { start: at(-120), end: at(400) }, selectedNoradIds: [27607, 25544, 43017],
};
const data = { elements: { ...elementsFixture, downloadedAt: new Date(T0).toISOString() }, status };

// SO-50 pass with fractional-second bounds (15:56:00.4 - 16:08:00.6 UTC), ISS pass 16:36:00 - 16:49:00 UTC.
const so50 = geom({ norad: 27607, rise: 56, set: 68, maxEl: 70, above: [60, 62] });
so50.riseMs += 400; so50.setMs += 600;
const iss = geom({ norad: 25544, rise: 96, set: 109, maxEl: 50, above: [101, 104] });
const plan = (passes = [so50, iss]) => computePlan(inputs, data, passes, [], [], T0);
const show = (p = plan()) => render(<Results inputs={inputs} result={p} nowMs={T0} isSaved={() => false} onSave={() => {}} statusProblem={null} />);

describe('event header shows the ACTUAL cluster to the minute, never rounded inward', () => {
  it('bounds are the earliest AOS and latest LOS shown to the minute (no seconds), with the exact elapsed time in minutes', () => {
    const { container } = show();
    const when = container.querySelector('.event .when')!.textContent!;
    // AOS 3:56:00.4 PM -> shown 3:56 PM; LOS 4:49:00.0 PM; exact elapsed 52 min 59.6 s -> 53 min
    expect(when).toContain('3:56 PM – 4:49 PM');
    expect(when).toContain('· 53 min');
    expect(when).not.toMatch(/:\d\d:\d\d/); // no seconds anywhere in the header
    expect(when).not.toMatch(/\d s\b/);
    expect(when).not.toMatch(/2\.5|150|hours/); // the maximum span is not shown as the event length
  });
  it('a LOS that is a fraction of a second into the next minute is shown rounded UP, so the header still contains the whole pass', () => {
    const lateIss = geom({ norad: 25544, rise: 96, set: 109, maxEl: 50, above: [101, 104] });
    lateIss.setMs += 400; // LOS 4:49:00.4 PM
    const p = plan([so50, lateIss]);
    const lastSet = Math.max(...p.windows[0]!.counted.map((c) => c.setMs));
    expect(ceilMin(lastSet)).toBeGreaterThanOrEqual(lastSet);
    expect(floorMin(p.windows[0]!.window.start)).toBeLessThanOrEqual(p.windows[0]!.window.start);
    const { container } = show(p);
    expect(container.querySelector('.event .when')!.textContent).toContain('3:56 PM – 4:50 PM'); // outward, not 4:49
  });
  it('individual pass details keep their seconds (AOS-LOS to the second, outward)', () => {
    const { container } = show();
    expect(container.querySelector('article.pass dl.key')!.textContent).toContain('3:56:00 PM – 4:08:01 PM');
  });
  it('the cluster is not padded to the selected maximum: its exact span is 52 min 59.6 s, not 2.5 hours', () => {
    const w = plan().windows[0]!;
    expect(w.window.end - w.window.start).toBe(3_179_600); // 15:56:00.4 -> 16:49:00.0
    expect(w.window.end - w.window.start).toBeLessThan(150 * 60_000);
  });
});

describe('header duration: exact, to the nearest minute, never above the maximum', () => {
  it('fmtSpanMin rounds the EXACT elapsed time and never exceeds a whole-minute maximum', () => {
    const start = Date.UTC(2027, 0, 9, 10, 0, 0, 600);
    expect(fmtSpanMin(start, Date.UTC(2027, 0, 9, 12, 0, 0, 400))).toBe('2 h 00 min'); // exact 7199.8 s: not "2 h 01 min"
    expect(fmtSpanMin(0, 7_200_000)).toBe('2 h 00 min');
    expect(fmtSpanMin(0, 7_199_999)).toBe('2 h 00 min');
    expect(fmtSpanMin(0, 5_459_000)).toBe('1 h 31 min'); // 90 min 59 s
    expect(fmtSpanMin(0, 27 * 60_000 + 10_000)).toBe('27 min');
    const minutes = (s: string) => { const m = /(?:(\d+) h )?(\d+) min/.exec(s)!; return Number(m[1] ?? 0) * 60 + Number(m[2]); };
    for (const maxMin of [120, 150, 180]) {
      for (const exactMs of [maxMin * 60_000, maxMin * 60_000 - 1, maxMin * 60_000 - 29_999, maxMin * 60_000 - 30_001]) {
        expect(minutes(fmtSpanMin(1234, 1234 + exactMs))).toBeLessThanOrEqual(maxMin);
      }
    }
  });
  it('a cluster of exactly the maximum span is displayed as that maximum, not above it', () => {
    const a = geom({ norad: 27607, rise: 56, set: 68, maxEl: 70 });
    const b = geom({ norad: 25544, rise: 196, set: 206, maxEl: 50 }); // 56 -> 206 minutes = exactly 150
    const p = computePlan({ ...inputs, criteria: { ...inputs.criteria, maxSpanMin: 150 } }, data, [a, b], [], [], T0);
    expect(p.windows).toHaveLength(1);
    const { container } = show(p);
    expect(container.querySelector('.event .when')!.textContent).toContain('2 h 30 min');
  });
});

describe('format helpers never round a clock time inward', () => {
  it('floorSec/ceilSec move clock times outward, while fmtSpan measures the exact elapsed time', () => {
    for (const ms of [0, 1, 999, 1000, 1001, 123_456, 86_399_999]) {
      expect(floorSec(ms)).toBeLessThanOrEqual(ms);
      expect(ceilSec(ms)).toBeGreaterThanOrEqual(ms);
    }
    expect(fmtSpan(400, 60_600)).toBe('1 min 00 s'); // the duration is EXACT (60.2 s); only the clock times round outward
    expect(fmtSpan(0, 5_400_000 + 27_000)).toBe('1 h 30 min 27 s');
    expect(fmtSpan(0, 45_000)).toBe('45 s');
  });
});

describe('pass card: full pass up front, details behind Details, no ambiguous "usable time"', () => {
  it('main row shows AOS-LOS, peak, max elevation and full pass; "Time above" is inside Details', () => {
    const { container } = show();
    const card = container.querySelector('article.pass')!;
    const main = card.querySelector('dl.key')!.textContent!;
    for (const label of ['AOS–LOS', 'Peak', 'Max elevation', 'Duration']) expect(main).toContain(label);
    expect(main).not.toContain('Full pass'); // the individual pass duration is now labelled "Duration"
    expect(main).toContain('12 min 00 s'); // exact 12 min 00.2 s; the clock times beside it show 3:56:00 PM – 4:08:01 PM (outward)
    expect(main).not.toContain('Time above');
    const details = card.querySelector('details.more')!;
    expect(details.textContent).toContain('Time above 40°');
  });
  it('the label "usable time" is gone everywhere in the results', () => {
    const { container } = show();
    expect(container.textContent).not.toMatch(/usable (time|portion|point)/i);
  });
  it('"Sunlit operating time" appears only for a sunlight-restricted pass whose permitted time is shorter than the full pass', () => {
    const ao = geom({ norad: 43017, rise: 56, set: 68, maxEl: 70, sun: [[56, 61, true, 55], [61, 68, false, 70]] });
    const { container } = show(plan([ao, iss]));
    const cards = [...container.querySelectorAll('article.pass')];
    const aoCard = cards.find((c) => c.querySelector('h4')!.textContent === 'AO-91')!;
    const issCard = cards.find((c) => c.querySelector('h4')!.textContent === 'ISS')!;
    expect(aoCard.querySelector('dl.key')!.textContent).toContain('Sunlit operating time');
    expect(aoCard.querySelector('dl.key')!.textContent).toContain('5 min 00 s');
    expect(issCard.querySelector('dl.key')!.textContent).not.toContain('Sunlit operating time');
    expect(aoCard.querySelector('details.more')!.textContent).toContain('Sunlit operating interval');
  });
});

describe('timeline scales to the actual cluster', () => {
  it('lanes sit inside the axis with a small visual pad, while the header keeps the exact bounds', () => {
    const { container } = show();
    const lanes = [...container.querySelectorAll('.tl-lane .tl-full')] as HTMLElement[];
    expect(lanes).toHaveLength(2);
    const left = (el: HTMLElement) => parseFloat(el.style.left);
    expect(left(lanes[0]!)).toBeGreaterThan(0); // padded, not flush with the edge
    expect(left(lanes[0]!)).toBeLessThan(10); // but modest
    expect(container.querySelector('.event .when')!.textContent).toContain('3:56 PM – 4:49 PM'); // pad does not change the header
  });
  it('marks the shadowed part of a sunlight-restricted pass as not permitted', () => {
    const ao = geom({ norad: 43017, rise: 56, set: 68, maxEl: 70, sun: [[56, 61, true, 55], [61, 68, false, 70]] });
    const { container } = show(plan([ao, iss]));
    expect(container.querySelector('.tl-full.restricted')).not.toBeNull();
    expect(container.querySelector('.tl-legend')!.textContent).toContain('Not permitted (Earth’s shadow)');
    expect(container.querySelector('.tl-legend')!.textContent).toContain('Sunlit operating interval');
  });
});

describe('results introduction', () => {
  it('is the count and the sort control only: no requirements paragraph and no satellites list', () => {
    const { container } = show();
    expect(container.querySelector('.results-intro .hint:not(.small)')).toBeNull();
    expect(container.querySelector('section.results > .hint:not(.small)')).toBeNull();
    expect(container.textContent).not.toMatch(/Satellites considered|Clusters of at least|maximum span of/);
    expect(container.querySelector('h2')!.textContent).toMatch(/^\d+ results?$/);
  });
});

describe('the span control', () => {
  it('is labelled "Maximum span"', () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(screen.getByText('Maximum span')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Maximum span' })).toBeTruthy();
    expect(screen.queryByText('Maximum cluster span')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Event duration' })).toBeNull();
  });
  it('passes the chosen hours to the search as the maximum cluster span', async () => {
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    await userEvent.type(screen.getByPlaceholderText('e.g. 42.35'), '42.35');
    await userEvent.type(screen.getByPlaceholderText('e.g. -71.06'), '-71.06');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Saturday evening' }));
    await userEvent.click(screen.getByLabelText('3 hours'));
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch.mock.calls[0]![0].criteria.maxSpanMin).toBe(180);
  });
});

describe('saved events: new format, and old-format entries handled without deleting them', () => {
  const meta = { generatedAtMs: T0, elementsDownloadedAt: new Date(T0).toISOString(), statusDownloadedAt: null, epochs: {} };
  const legacyEntry = { schema: 1, id: 'old-1', savedAtMs: 1, window: { start: 1, end: 2 }, location: { latDeg: 1, lonDeg: 2 }, timeZone: 'UTC', criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 3 }, original: { counted: [], distinctSatellites: 0, totalOperatingMs: 0, meta } };
  const fresh = () => snapshotEvent(plan().windows[0]!, { latDeg: 1, lonDeg: 2 }, 'UTC', inputs.criteria, meta, T0, 'new-1');

  it('old entries are not shown and not re-checked, but are NOT deleted when a new event is saved', () => {
    localStorage.setItem('satplanner.events.v1', JSON.stringify([legacyEntry]));
    expect(loadEvents()).toEqual([]);
    expect(countLegacyEvents()).toBe(1);
    expect(saveEvents([fresh()])).toBe(true);
    expect(countLegacyEvents()).toBe(1); // still stored, untouched
    expect(loadEvents().map((e) => e.id)).toEqual(['new-1']);
    expect(JSON.parse(localStorage.getItem('satplanner.events.v1')!).find((e: { id: string }) => e.id === 'old-1')).toEqual(legacyEntry); // byte-for-byte content
  });
  it('removing them is an explicit action that touches only the old-format entries', () => {
    localStorage.setItem('satplanner.events.v1', JSON.stringify([legacyEntry, fresh()]));
    expect(clearLegacyEvents()).toBe(true);
    expect(countLegacyEvents()).toBe(0);
    expect(loadEvents().map((e) => e.id)).toEqual(['new-1']);
  });
  it('the Saved tab explains old entries and offers an explicit remove button; nothing happens until it is pressed', async () => {
    const onClear = vi.fn();
    render(<SavedEvents events={[]} data={null} nowMs={T0} onDelete={() => {}} legacyCount={2} onClearLegacy={onClear} />);
    const note = screen.getByText(/2 saved events were made with an earlier version/);
    expect(note.textContent).toMatch(/still stored, untouched/);
    expect(onClear).not.toHaveBeenCalled();
    fireEvent.click(within(note).getByRole('button', { name: 'Remove them' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
  it('a new saved event shows the saved cluster interval exactly as in its header', () => {
    const ev = fresh();
    const { container } = render(<SavedEvents events={[ev]} data={null} nowMs={T0} onDelete={() => {}} />);
    expect(container.querySelector('article.saved .when')!.textContent).toContain('3:56 PM – 4:49 PM UTC · 53 min');
  });
});

describe('wording and structure', () => {
  it('the individual pass card keeps the timeline legend wording ("Full pass") but labels the pass length "Duration"', () => {
    const { container } = show();
    expect(container.querySelector('.tl-legend')!.textContent).toContain('Full pass'); // legend untouched
    expect(container.querySelector('article.pass dl.key')!.textContent).toContain('Duration');
  });
  it('the AOS-LOS range is marked as secondary (muted gray via the stylesheet)', () => {
    const { container } = show();
    expect(container.querySelector('article.pass dl.key .aos-los')).not.toBeNull();
    expect(container.querySelector('article.pass dl.key .aos-los dt')!.textContent).toBe('AOS–LOS');
  });
  it('Saved events: the empty state no longer claims a "fresh data" re-check, and the introduction is the new sentence', () => {
    const empty = render(<SavedEvents events={[]} data={null} nowMs={T0} onDelete={() => {}} />);
    expect(empty.container.textContent).not.toMatch(/fresh data|re-checked here/i);
    expect(empty.container.textContent).toContain('No saved events yet. Save one from the search results; its date and time stay fixed.');
    empty.unmount();
    const meta = { generatedAtMs: T0, elementsDownloadedAt: new Date(T0).toISOString(), statusDownloadedAt: null, epochs: {} };
    const ev = snapshotEvent(plan().windows[0]!, { latDeg: 1, lonDeg: 2 }, 'UTC', inputs.criteria, meta, T0, 'x');
    const full = render(<SavedEvents events={[ev]} data={null} nowMs={T0} onDelete={() => {}} />);
    const intro = full.container.querySelector('p.hint')!.textContent;
    expect(intro).toBe('Saved event times stay fixed. Satellite status is checked using previously downloaded reports.');
  });
});
