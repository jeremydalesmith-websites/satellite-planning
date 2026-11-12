// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import { loadData } from '../src/data/load.ts';
import { loadEvents, loadPrefs, saveEvents, savePrefs } from '../src/storage.ts';
import { AvailabilityGrid } from '../src/ui/AvailabilityGrid.tsx';
import { PlanForm } from '../src/ui/PlanForm.tsx';
import { validateForm } from '../src/ui/validate.ts';
import type { FormFields } from '../src/ui/validate.ts';
import { elementsFixture, statusFixture } from './helpers.ts';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const NOW = Date.UTC(2027, 0, 9, 12);
const good = (): FormFields => {
  const a = emptyAvailability();
  a.selected.evening[6] = true;
  return { latText: '42.35', lonText: '-71.06', timeZone: 'America/New_York', startDate: '2027-01-09', endDate: '2027-02-05', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: a };
};

describe('form validation messages', () => {
  it('accepts a complete form', () => {
    const r = validateForm(good(), NOW);
    expect(r.errors).toEqual([]);
    expect(r.inputs!.criteria).toEqual({ minElevationDeg: 40, durationMin: 150, minOpportunities: 3 });
  });
  it('never infers a location: blank coordinates are errors', () => {
    const r = validateForm({ ...good(), latText: '', lonText: '' }, NOW);
    expect(r.inputs).toBeNull();
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['latText', 'lonText']));
  });
  it.each([
    [{ latText: '91' }, 'latText'], [{ latText: 'abc' }, 'latText'], [{ lonText: '-181' }, 'lonText'],
    [{ timeZone: 'Mars/Olympus' }, 'timeZone'], [{ minElevationText: '4' }, 'minElevationText'],
    [{ minElevationText: '86' }, 'minElevationText'], [{ minOpportunitiesText: '1' }, 'minOpportunitiesText'],
    [{ minOpportunitiesText: '2.5' }, 'minOpportunitiesText'], [{ endDate: '2027-03-01' }, 'endDate'],
  ] as const)('%j is rejected on %s', (patch, field) => {
    const r = validateForm({ ...good(), ...patch }, NOW);
    expect(r.errors.some((e) => e.field === field)).toBe(true);
  });
  it('allows 2 opportunities', () => {
    expect(validateForm({ ...good(), minOpportunitiesText: '2' }, NOW).errors).toEqual([]);
  });
  it('requires an explicit availability selection (never silently searches all hours)', () => {
    const r = validateForm({ ...good(), availability: emptyAvailability() }, NOW);
    expect(r.inputs).toBeNull();
    expect(r.errors.find((e) => e.field === 'availability')!.message).toMatch(/Select when you are available/);
  });
});

describe('availability grid', () => {
  it('exposes one labelled checkbox per day and period, unchecked by default', () => {
    render(<AvailabilityGrid value={emptyAvailability()} onChange={() => {}} timeZone="America/New_York" />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(21);
    boxes.forEach((b) => expect((b as HTMLInputElement).checked).toBe(false));
    expect(screen.getByRole('checkbox', { name: 'Saturday evening' })).toBeTruthy();
    expect(screen.getByText('America/New_York')).toBeTruthy(); // timezone shown next to the grid
  });
  it('reports a toggle through onChange with the right cell', async () => {
    const onChange = vi.fn();
    render(<AvailabilityGrid value={emptyAvailability()} onChange={onChange} timeZone="UTC" />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tuesday midday' }));
    const next = onChange.mock.calls[0]![0];
    expect(next.selected.midday[2]).toBe(true);
    expect(next.selected.midday.filter(Boolean)).toHaveLength(1);
  });
  it('shows merged blocks for adjacent periods', () => {
    const v = emptyAvailability();
    v.selected.midday[6] = true; v.selected.evening[6] = true;
    render(<AvailabilityGrid value={v} onChange={() => {}} timeZone="UTC" />);
    expect(screen.getByText(/12:00 PM–10:00 PM/)).toBeTruthy();
  });
  it('lets you edit period boundaries', async () => {
    const onChange = vi.fn();
    render(<AvailabilityGrid value={emptyAvailability()} onChange={onChange} timeZone="UTC" />);
    const start = screen.getByLabelText('Morning starts at') as HTMLInputElement;
    expect(start.value).toBe('07:00');
    await userEvent.clear(start);
    await userEvent.type(start, '08:30');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('plan form', () => {
  it('shows useful messages when searching with nothing filled in, and does not search', async () => {
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/latitude/i)).toBeTruthy();
    expect(within(alert).getByText(/Select when you are available/)).toBeTruthy();
    expect(onSearch).not.toHaveBeenCalled();
  });
  it('defaults: 40°, 3 opportunities, 28-day range, browser timezone visible and editable', () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect((screen.getByLabelText(/Minimum peak elevation/) as HTMLInputElement).value).toBe('40');
    expect((screen.getByLabelText(/Opportunities needed/) as HTMLInputElement).value).toBe('3');
    const tz = screen.getByLabelText('Time zone') as HTMLInputElement;
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const from = (screen.getByLabelText('Search from') as HTMLInputElement).value;
    const to = (screen.getByLabelText('through') as HTMLInputElement).value;
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(27); // 28 inclusive days
  });
  it('calls onSearch with parsed inputs when valid, and persists preferences locally', async () => {
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    await userEvent.type(screen.getByPlaceholderText('e.g. 42.35'), '42.35');
    await userEvent.type(screen.getByPlaceholderText('e.g. -71.06'), '-71.06');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Saturday evening' }));
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0]![0].observer).toMatchObject({ latDeg: 42.35, lonDeg: -71.06 });
    expect(loadPrefs().availability!.selected.evening[6]).toBe(true);
    expect(loadPrefs().latText).toBe('42.35');
  });
  it('never calls the geolocation API unless the button is pressed', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });
});

describe('local storage robustness', () => {
  it('ignores corrupt stored data', () => {
    localStorage.setItem('satplanner.prefs.v1', '{not json');
    localStorage.setItem('satplanner.events.v1', JSON.stringify([{ nonsense: true }]));
    expect(loadPrefs()).toEqual({});
    expect(loadEvents()).toEqual([]);
  });
  it('survives storage being blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(saveEvents([])).toBe(false);
    expect(savePrefs({ latText: '', lonText: '', timeZone: 'UTC', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: emptyAvailability() })).toBe(false);
  });
});

describe('data loading', () => {
  const respond = (map: Record<string, { status?: number; body: string }>) =>
    vi.stubGlobal('fetch', vi.fn(async (u: URL) => {
      const key = Object.keys(map).find((k) => String(u).endsWith(k));
      const r = key ? map[key]! : { status: 404, body: '<html>nope</html>' };
      return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }));

  it('loads both files when present', async () => {
    respond({ 'data/elements.json': { body: JSON.stringify(elementsFixture) }, 'data/status.json': { body: JSON.stringify(statusFixture) } });
    const r = await loadData();
    expect(r.ok && r.data.status !== null && r.statusProblem === null).toBe(true);
  });
  it('missing orbital data is a hard, honest failure (no fabricated fallback)', async () => {
    respond({});
    const r = await loadData();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Orbital data could not be loaded/);
  });
  it('an HTML page served in place of JSON is detected', async () => {
    respond({ 'data/elements.json': { body: '<!doctype html><html></html>' } });
    const r = await loadData();
    expect(!r.ok && r.message).toMatch(/not valid JSON/);
  });
  it('missing status data degrades gracefully: orbital data still loads, status flagged unavailable', async () => {
    respond({ 'data/elements.json': { body: JSON.stringify(elementsFixture) } });
    const r = await loadData();
    expect(r.ok && r.data.status).toBeNull();
    expect(r.ok && r.statusProblem).toMatch(/unconfirmed/);
  });
});
