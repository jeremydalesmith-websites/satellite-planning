// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { computePlan } from '../src/planner.ts';
import { loadPrefs, savePrefs } from '../src/storage.ts';
import { snapshotEvent } from '../src/saved/saved.ts';
import { AvailabilityGrid } from '../src/ui/AvailabilityGrid.tsx';
import { PlanForm } from '../src/ui/PlanForm.tsx';
import { Results } from '../src/ui/Results.tsx';
import { SavedEvents } from '../src/ui/SavedEvents.tsx';
import { validateForm } from '../src/ui/validate.ts';
import type { FormFields } from '../src/ui/validate.ts';
import { T0, at, geom } from './factory.ts';
import { elementsFixture } from './helpers.ts';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const heard = (key: string): [string, { reports: [number, 'H', number][] }] => [key, { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] }];
const status: StatusFile = { schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString(), satellites: Object.fromEntries([heard('SO-50_[FM]'), heard('ISS_[FM]')]) };
const fullDay = () => {
  const av = emptyAvailability();
  for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
  av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
  return av;
};
const inputs = (minOpportunities: number) => ({
  observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
  criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities },
  availability: fullDay(), range: { start: at(-120), end: at(600) }, selectedNoradIds: [27607, 25544],
});
const passes = () => [
  geom({ norad: 27607, rise: 56, set: 68, maxEl: 62 }),
  geom({ norad: 25544, rise: 96, set: 109, maxEl: 88 }),
  geom({ norad: 27607, rise: 140, set: 152, maxEl: 75 }),
];
const planFor = (min: number) => computePlan(inputs(min), { elements: elementsFixture, status }, passes(), [], [], T0);
const show = (min: number, result = planFor(min), minElevationDeg?: number) =>
  render(<Results inputs={minElevationDeg ? { ...inputs(min), criteria: { ...inputs(min).criteria, minElevationDeg } } : inputs(min)} result={result} nowMs={T0} isSaved={() => false} onSave={() => {}} statusProblem={null} />);

describe('Minimum passes: the field', () => {
  it('is labelled "Minimum passes" (not "Opportunities needed")', () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(screen.getByLabelText(/^Minimum passes/)).toBeTruthy();
    expect(screen.queryByLabelText(/Opportunities needed/)).toBeNull();
    expect((screen.getByLabelText(/^Minimum passes/) as HTMLInputElement).value).toBe('3'); // the default is unchanged
  });
  const base = (): FormFields => {
    const a = emptyAvailability();
    a.selected.evening[6] = true;
    return { latText: '42.35', lonText: '-71.06', timeZone: 'UTC', startDate: '2027-01-09', endDate: '2027-02-05', minElevationText: '60', durationMin: 150, minOpportunitiesText: '1', availability: a };
  };
  it('accepts 1 (and 60° or higher), and still rejects 0, 11, decimals and blanks', () => {
    const ok = validateForm(base(), Date.UTC(2027, 0, 9));
    expect(ok.errors).toEqual([]);
    expect(ok.inputs!.criteria).toEqual({ minElevationDeg: 60, maxSpanMin: 150, minOpportunities: 1 });
    for (const bad of ['0', '11', '1.5', '', 'x']) {
      const r = validateForm({ ...base(), minOpportunitiesText: bad }, Date.UTC(2027, 0, 9));
      expect(r.errors.map((e) => e.field)).toContain('minOpportunitiesText');
      expect(r.errors.find((e) => e.field === 'minOpportunitiesText')!.message).toBe('Choose a whole number of passes from 1 to 10.');
    }
  });
  it('a search with Minimum passes = 1 goes ahead and passes 1 through', async () => {
    const onSearch = vi.fn();
    const a = emptyAvailability();
    a.selected.evening[6] = true;
    savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'UTC', minElevationText: '60', durationMin: 150, minOpportunitiesText: '1', availability: a });
    render(<PlanForm busy={false} onSearch={onSearch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0]![0].criteria).toMatchObject({ minElevationDeg: 60, minOpportunities: 1 });
  });
});

describe('Maximum span is hidden when there is no cluster to constrain', () => {
  const span = () => screen.queryByText('Maximum span');
  it('shown for 2 or more, hidden for 1, and back again, keeping the chosen hours', async () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(span()).not.toBeNull(); // default 3
    await userEvent.click(screen.getByLabelText('3 hours'));
    const min = screen.getByLabelText(/^Minimum passes/);
    await userEvent.clear(min);
    await userEvent.type(min, '1');
    expect(span()).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Maximum span' })).toBeNull();
    await userEvent.clear(min);
    await userEvent.type(min, '2');
    expect(span()).not.toBeNull();
    expect((screen.getByLabelText('3 hours') as HTMLInputElement).checked).toBe(true); // the choice was kept
    expect(loadPrefs().durationMin).toBe(180);
  });
});

describe('results: single-pass wording and order', () => {
  it('heading, hint and cards use "qualifying pass(es)" and singular wording, ranked by elevation', () => {
    const { container } = show(1);
    expect(screen.getByRole('heading', { level: 2, name: '3 qualifying passes' })).toBeTruthy();
    const hint = container.querySelector('.hint')!.textContent!;
    expect(hint).toMatch(/Single passes reaching a peak of 40° or higher/);
    expect(hint).toMatch(/ranked by maximum elevation \(highest first; earlier first on a tie\)/);
    expect(hint).not.toMatch(/Clusters|maximum span/i);
    const summaries = [...container.querySelectorAll('.event .summary')].map((s) => s.textContent!.trim());
    expect(summaries).toEqual(['1 qualifying pass', '1 qualifying pass', '1 qualifying pass']); // singular, no satellite count
    const order = [...container.querySelectorAll('.event article.pass h4')].map((h) => h.textContent);
    expect(order).toEqual(['ISS', 'SO-50', 'SO-50']); // 88°, 75°, 62°
    const elev = [...container.querySelectorAll('.event article.pass dl.key > div:nth-child(3) dd')].map((d) => parseInt(d.textContent!, 10));
    expect(elev).toEqual([88, 75, 62]);
  });
  it('one result reads "1 qualifying pass" in the heading too', () => {
    const one = computePlan({ ...inputs(1), criteria: { ...inputs(1).criteria, minElevationDeg: 80 } }, { elements: elementsFixture, status }, passes(), [], [], T0);
    show(1, one);
    expect(screen.getByRole('heading', { level: 2, name: '1 qualifying pass' })).toBeTruthy();
  });
  it('says how many exist when the display limit cuts the list', () => {
    const r = planFor(1);
    show(1, { ...r, windowsTotal: 150 });
    expect(screen.getByRole('heading', { level: 2, name: '150 qualifying passes' })).toBeTruthy();
    expect(screen.getByText(/Showing the highest 3 of 150/)).toBeTruthy();
  });
  it('an empty single-pass result explains itself without cluster wording', () => {
    const none = computePlan({ ...inputs(1), criteria: { ...inputs(1).criteria, minElevationDeg: 85 } }, { elements: elementsFixture, status }, [geom({ norad: 27607, rise: 56, set: 68, maxEl: 60 })], [], [], T0);
    expect(none.windows).toEqual([]);
    const { container } = show(1, none, 85);
    expect(screen.getByRole('heading', { level: 2, name: 'No qualifying passes' })).toBeTruthy();
    expect(container.querySelector('.no-results')!.textContent).toMatch(/No pass of a selected, eligible satellite reaches a peak of 85°/);
    expect(container.textContent).not.toMatch(/cluster/i);
  });
  it('2 or more minimum passes keeps the cluster wording and satellite count', () => {
    const { container } = show(2);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/promising event window/);
    expect(container.querySelector('.hint')!.textContent).toMatch(/Clusters of at least 2 separate passes/);
    expect(container.querySelector('.event .summary')!.textContent).toMatch(/3 qualifying passes\s*·\s*2 satellites/); // all three passes fit one cluster
  });
});

describe('saved events from single passes', () => {
  it('describe the requirement in the singular', () => {
    const meta = { generatedAtMs: T0, elementsDownloadedAt: new Date(T0).toISOString(), statusDownloadedAt: null, epochs: {} };
    const ev = snapshotEvent(planFor(1).windows[0]!, { latDeg: 1, lonDeg: 2 }, 'UTC', inputs(1).criteria, meta, T0, 'x', [27607, 25544]);
    const { container } = render(<SavedEvents events={[ev]} data={null} nowMs={T0} onDelete={() => {}} />);
    expect(container.querySelector('article.saved')!.textContent).toMatch(/Needs at least 1 pass peaking at 40°\+/);
  });
});

describe('Weekend shortcut', () => {
  const cells = (v: ReturnType<typeof emptyAvailability>) => Object.fromEntries((['morning', 'midday', 'evening'] as const).map((p) => [p, v.selected[p]]));
  const noisy = () => {
    const a = emptyAvailability();
    a.periods = { morning: { startMin: 6 * 60, endMin: 11 * 60 }, midday: { startMin: 11 * 60, endMin: 15 * 60 }, evening: { startMin: 18 * 60, endMin: 23 * 60 } };
    a.selected.morning[2] = true; a.selected.midday[4] = true; a.selected.evening[5] = true; a.selected.evening[0] = true;
    return a;
  };

  it('sits at the top of the grid header, directly above the per-day controls, as a non-submit button', () => {
    const { container } = render(<AvailabilityGrid value={emptyAvailability()} onChange={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Weekend' });
    expect(btn.getAttribute('type')).toBe('button');
    const head = container.querySelector('table.grid thead')!;
    expect(head.contains(btn)).toBe(true);
    expect(head.querySelectorAll('button.day-btn')).toHaveLength(7);
    const dayRow = head.querySelector('button.day-btn')!.closest('tr')!;
    expect(btn.closest('tr')!.compareDocumentPosition(dayRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // Weekend row comes first
  });
  it('selects Saturday and Sunday in all three periods and clears Monday to Friday, leaving the time ranges alone', async () => {
    const onChange = vi.fn();
    const start = noisy();
    render(<AvailabilityGrid value={start} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as ReturnType<typeof emptyAvailability>;
    for (const row of Object.values(cells(next))) expect(row).toEqual([true, false, false, false, false, false, true]); // Sun on, Mon-Fri off, Sat on
    expect(next.periods).toEqual(start.periods);
  });
  it('does not mutate its input and is idempotent', async () => {
    const start = noisy();
    const copy = JSON.stringify(start);
    const onChange = vi.fn();
    const { rerender } = render(<AvailabilityGrid value={start} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    expect(JSON.stringify(start)).toBe(copy);
    const once = onChange.mock.calls[0]![0];
    rerender(<AvailabilityGrid value={once} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    expect(onChange.mock.calls[1]![0]).toEqual(once);
  });
  it('shows a pressed state only while the selection is exactly the weekend', () => {
    const wk = emptyAvailability();
    for (const p of ['morning', 'midday', 'evening'] as const) { wk.selected[p][0] = true; wk.selected[p][6] = true; }
    const { rerender } = render(<AvailabilityGrid value={wk} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Weekend' }).getAttribute('aria-pressed')).toBe('true');
    wk.selected.midday[3] = true; // add a Wednesday
    rerender(<AvailabilityGrid value={{ ...wk }} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Weekend' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('in the plan form: no search, persisted, dates and time ranges unchanged, individual boxes still editable', async () => {
    const onSearch = vi.fn();
    const a = noisy();
    savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'UTC', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: a, selectedIds: [27607] });
    render(<PlanForm busy={false} onSearch={onSearch} />);
    const start = (screen.getByLabelText('Start date') as HTMLInputElement).value;
    const end = (screen.getByLabelText('End date') as HTMLInputElement).value;
    const ranges = (screen.getAllByDisplayValue(/^\d\d:\d\d$/) as HTMLInputElement[]).map((i) => i.value);
    await userEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    expect(onSearch).not.toHaveBeenCalled();
    const checked = (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter((b) => b.checked).map((b) => b.getAttribute('aria-label'));
    expect(checked.sort()).toEqual(['Saturday evening', 'Saturday midday', 'Saturday morning', 'Sunday evening', 'Sunday midday', 'Sunday morning'].sort());
    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe(start);
    expect((screen.getByLabelText('End date') as HTMLInputElement).value).toBe(end);
    expect((screen.getAllByDisplayValue(/^\d\d:\d\d$/) as HTMLInputElement[]).map((i) => i.value)).toEqual(ranges);
    const saved = loadPrefs();
    expect(saved.availability!.selected.morning).toEqual([true, false, false, false, false, false, true]);
    expect(saved.availability!.periods).toEqual(a.periods);
    expect(saved.selectedIds).toEqual([27607]); // satellite selection untouched
    // still editable afterwards
    fireEvent.click(screen.getByRole('checkbox', { name: 'Saturday evening' }));
    expect((screen.getByRole('checkbox', { name: 'Saturday evening' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wednesday midday' }));
    expect((screen.getByRole('checkbox', { name: 'Wednesday midday' }) as HTMLInputElement).checked).toBe(true);
  });
  it('works together with Check all and Uncheck all', async () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Weekend' }));
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).filter((b) => b.checked)).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Uncheck all' }));
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).filter((b) => b.checked)).toHaveLength(0);
  });
});

void within;
