// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import { loadData } from '../src/data/load.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { evaluateEligibility } from '../src/eligibility/eligibility.ts';
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
    // Titled "Availability" with the short intro; the time zone is no longer repeated here (it is in the form's compact line).
    expect(screen.getByText('Availability')).toBeTruthy();
    expect(screen.getByText('Set time ranges, then check the days you’re available.')).toBeTruthy();
    expect(screen.queryByText('America/New_York')).toBeNull();
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
  it('defaults: 40°, 3 opportunities, 28-day range, browser time zone shown on a compact line and editable via Change', async () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect((screen.getByLabelText(/Minimum peak elevation/) as HTMLInputElement).value).toBe('40');
    expect((screen.getByLabelText(/Opportunities needed/) as HTMLInputElement).value).toBe('3');
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByText(/^Times:/).textContent).toContain(browserTz);
    expect(screen.queryByLabelText('Time zone')).toBeNull(); // the editable control is hidden until "Change"
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect((screen.getByLabelText('Time zone') as HTMLInputElement).value).toBe(browserTz);
    const from = (screen.getByLabelText('Start date') as HTMLInputElement).value;
    const to = (screen.getByLabelText('End date') as HTMLInputElement).value;
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(27); // 28 inclusive days
  });
  it('a saved time zone is preserved and shown; the browser zone is only the default when nothing is saved', () => {
    savePrefs({ latText: '', lonText: '', timeZone: 'Pacific/Auckland', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: emptyAvailability() });
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(screen.getByText(/^Times:/).textContent).toContain('Pacific/Auckland');
  });
  it('the removed explanatory text is gone, the dates use a dash with accessible labels, and nothing claims the zone comes from coordinates', () => {
    const { container } = render(<PlanForm busy={false} onSearch={() => {}} />);
    const text = container.textContent ?? '';
    for (const gone of [
      'Find available event windows with multiple FM satellite passes',
      'Planning only: this finds clusters',
      'Your location is never guessed',
      'Up to 42 days. Dates more than a week',
      'Search from',
    ]) expect(text).not.toContain(gone);
    expect(screen.getByText('Dates')).toBeTruthy();
    expect(screen.getByText('Location')).toBeTruthy();
    expect(screen.queryByText('Where will the event be?')).toBeNull();
    expect(screen.getByLabelText(/^Latitude/)).toBeTruthy();
    expect(screen.getByLabelText(/^Longitude/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use my location' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use my current location' })).toBeNull();
    expect(screen.getByLabelText('Start date')).toBeTruthy();
    expect(screen.getByLabelText('End date')).toBeTruthy();
    expect(text).toContain('–');
    expect(text).not.toMatch(/coordinates.*time ?zone|time ?zone.*(from|detected|determined).*(coordinates|location)/i);
  });
  it('invalid ranges and the 42-day limit are reported as errors, and only when relevant', async () => {
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    expect(screen.queryByText(/at most 42 days/)).toBeNull(); // no permanent explanatory text
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-03-15' } }); // 74 days
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(within(screen.getByRole('alert')).getByText(/at most 42 days/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-01' } }); // before the start
    expect(within(screen.getByRole('alert')).getByText(/end date must not be before the start date/i)).toBeTruthy();
    expect(onSearch).not.toHaveBeenCalled();
  });
  it('an invalid time zone reveals the time zone field with its error, without clicking Change', async () => {
    savePrefs({ latText: '', lonText: '', timeZone: 'Not/AZone', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: emptyAvailability() });
    render(<PlanForm busy={false} onSearch={() => {}} />);
    expect(screen.queryByLabelText('Time zone')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(screen.getByLabelText(/^Time zone/)).toBeTruthy();
    expect(screen.getAllByText(/valid time zone name/).length).toBeGreaterThan(0);
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
    await userEvent.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });
});

describe('satellite selection', () => {
  const heard = { reports: [[Math.floor((NOW - 3_600_000) / 1000), 'H', 0]] as [number, 'H', number][] };
  const file = (keys: string[]): StatusFile => ({
    schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(),
    satellites: Object.fromEntries(keys.map((k) => [k, heard])),
  });
  const eligNoAo91 = evaluateEligibility(file(['SO-50_[FM]', 'ISS_[FM]', 'AO-123_[FM]']), NOW);
  const eligAll = evaluateEligibility(file(['SO-50_[FM]', 'ISS_[FM]', 'AO-123_[FM]', 'AO-91_[FM]']), NOW);
  const box = (re: RegExp) => screen.getByRole('checkbox', { name: re }) as HTMLInputElement;

  it('lists only eligible satellites; ISS and SO-50 start selected, other eligible ones start unchecked', () => {
    render(<PlanForm busy={false} onSearch={() => {}} eligibility={eligNoAo91} />);
    expect(box(/^ISS/).checked).toBe(true);
    expect(box(/^SO-50/).checked).toBe(true);
    expect(box(/^AO-123/).checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: /^AO-91/ })).toBeNull(); // ineligible: not offered
    expect(screen.queryByRole('checkbox', { name: /^TEVEL/ })).toBeNull();
  });
  it('keeps the block compact: no explanatory paragraph beside the selection controls (timestamps live in the footer details)', () => {
    const { container } = render(<PlanForm busy={false} onSearch={() => {}} eligibility={eligNoAo91} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Only satellites with a/);
    expect(text).not.toMatch(/searching does not download/i);
    expect(screen.getByText('Satellites to consider')).toBeTruthy();
  });
  it('a temporarily ineligible satellite stays selected; unchecked satellites are never reselected', async () => {
    const onSearch = vi.fn();
    const { rerender } = render(<PlanForm busy={false} onSearch={onSearch} eligibility={eligNoAo91} />);
    expect(screen.getByText(/Still selected, but not eligible right now: AO-91/)).toBeTruthy();
    await userEvent.click(box(/^ISS/)); // user unchecks ISS
    await userEvent.type(screen.getByPlaceholderText('e.g. 42.35'), '42.35');
    await userEvent.type(screen.getByPlaceholderText('e.g. -71.06'), '-71.06');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Saturday evening' }));
    await userEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    const sent: number[] = onSearch.mock.calls[0]![0].selectedNoradIds;
    expect(sent).toContain(43017); // AO-91 still selected although ineligible right now
    expect(sent).toContain(27607);
    expect(sent).not.toContain(25544);
    expect(loadPrefs().selectedIds).toEqual(sent);

    // Later AO-91 becomes eligible again: it returns, still selected; ISS stays unchecked.
    rerender(<PlanForm busy={false} onSearch={onSearch} eligibility={eligAll} />);
    expect(box(/^AO-91/).checked).toBe(true);
    expect(box(/^ISS/).checked).toBe(false);
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
    expect(r.ok && r.statusProblem).toMatch(/none will be planned/);
  });
});

describe('data URL resolution (base path)', () => {
  const o = 'https://example.org';
  it('absolute base is anchored to the base, whatever the page URL is (e.g. visited without a trailing slash)', async () => {
    const { dataUrl } = await import('../src/data/load.ts');
    expect(dataUrl('data/elements.json', '/satellites/', o, o + '/satellites').href).toBe(o + '/satellites/data/elements.json');
  });
  it('relative base resolves against the page, so one build works from any sub-directory', async () => {
    const { dataUrl } = await import('../src/data/load.ts');
    expect(dataUrl('data/elements.json', './', o, o + '/a/b/').href).toBe(o + '/a/b/data/elements.json');
    expect(dataUrl('data/elements.json', './', o, o + '/satellites/').href).toBe(o + '/satellites/data/elements.json');
  });
});
