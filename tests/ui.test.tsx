// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability, mergedDayRanges } from '../src/availability/availability.ts';
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
    expect(r.inputs!.criteria).toEqual({ minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 3 });
  });
  it('never infers a location: blank coordinates are errors', () => {
    const r = validateForm({ ...good(), latText: '', lonText: '' }, NOW);
    expect(r.inputs).toBeNull();
    expect(r.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['latText', 'lonText']));
  });
  it.each([
    [{ latText: '91' }, 'latText'], [{ latText: 'abc' }, 'latText'], [{ lonText: '-181' }, 'lonText'],
    [{ timeZone: 'Mars/Olympus' }, 'timeZone'], [{ minElevationText: '4' }, 'minElevationText'],
    [{ minElevationText: '86' }, 'minElevationText'], [{ minOpportunitiesText: '0' }, 'minOpportunitiesText'],
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
    // Titled "Availability" with no explanatory paragraphs; the time zone is not repeated here (it is in the form's compact line).
    expect(screen.getByText('Availability')).toBeTruthy();
    expect(screen.queryByText(/Set time ranges/)).toBeNull(); // no intro paragraph
    expect(screen.queryByText(/not sunrise or sunset/)).toBeNull();
    expect(screen.queryByText('America/New_York')).toBeNull();
  });
  describe('Check all / Uncheck all', () => {
    const custom = () => {
      const a = emptyAvailability();
      a.periods = { morning: { startMin: 6 * 60, endMin: 11 * 60 }, midday: { startMin: 11 * 60, endMin: 15 * 60 }, evening: { startMin: 18 * 60, endMin: 23 * 60 } };
      a.selected.morning[1] = true; // partially selected to start with
      a.selected.evening[6] = true;
      return a;
    };
    const cellCount = (v: ReturnType<typeof emptyAvailability>) => Object.values(v.selected).reduce((n, row) => n + row.length, 0);

    it('are compact non-submit buttons placed below the whole grid, inside the Availability section', () => {
      const { container } = render(<AvailabilityGrid value={emptyAvailability()} onChange={() => {}} />);
      const check = screen.getByRole('button', { name: 'Check all' });
      const uncheck = screen.getByRole('button', { name: 'Uncheck all' });
      expect(check.getAttribute('type')).toBe('button');
      expect(uncheck.getAttribute('type')).toBe('button');
      const actions = container.querySelector('.grid-actions')!;
      const table = container.querySelector('table.grid')!;
      expect(table.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // actions come after the grid (after the Evening row)
      expect(container.querySelector('fieldset.avail')!.contains(actions)).toBe(true);
      const lastRow = table.querySelector('tbody tr:last-child')!;
      expect(lastRow.textContent).toContain('Evening');
      expect(lastRow.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(check.compareDocumentPosition(uncheck) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // side by side, Check all first
      expect(actions.className).toBe('grid-actions'); // centering is done by the stylesheet (see .grid-actions), not by extra markup
    });
    it('Check all checks exactly the 21 day x period boxes and leaves the time ranges alone', async () => {
      const onChange = vi.fn();
      const start = custom();
      render(<AvailabilityGrid value={start} onChange={onChange} />);
      await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0]![0] as ReturnType<typeof emptyAvailability>;
      expect(cellCount(next)).toBe(21);
      for (const row of Object.values(next.selected)) expect(row.every((x) => x === true)).toBe(true);
      expect(next.periods).toEqual(start.periods); // ranges untouched
    });
    it('Uncheck all clears all 21 boxes, including partly selected ones, and leaves the time ranges alone', async () => {
      const onChange = vi.fn();
      const start = custom();
      render(<AvailabilityGrid value={start} onChange={onChange} />);
      await userEvent.click(screen.getByRole('button', { name: 'Uncheck all' }));
      const next = onChange.mock.calls[0]![0] as ReturnType<typeof emptyAvailability>;
      expect(cellCount(next)).toBe(21);
      for (const row of Object.values(next.selected)) expect(row.every((x) => x === false)).toBe(true);
      expect(next.periods).toEqual(start.periods);
    });
    it('do not mutate the value they were given', async () => {
      const start = custom();
      const copy = JSON.stringify(start);
      render(<AvailabilityGrid value={start} onChange={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
      expect(JSON.stringify(start)).toBe(copy);
    });
    it('the "How your selection combines" display is gone, while the merging logic still works', () => {
      render(<AvailabilityGrid value={emptyAvailability()} onChange={() => {}} />);
      expect(screen.queryByText('How your selection combines')).toBeNull();
      const a = emptyAvailability();
      a.selected.midday[1] = true;
      a.selected.evening[1] = true; // adjacent periods still merge into one block (Monday 12:00-22:00)
      expect(mergedDayRanges(a, 1)).toEqual([[12 * 60, 22 * 60]]);
    });
  });
  it('reports a toggle through onChange with the right cell', async () => {
    const onChange = vi.fn();
    render(<AvailabilityGrid value={emptyAvailability()} onChange={onChange} timeZone="UTC" />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tuesday midday' }));
    const next = onChange.mock.calls[0]![0];
    expect(next.selected.midday[2]).toBe(true);
    expect(next.selected.midday.filter(Boolean)).toHaveLength(1);
  });
  it('adjacent periods still merge into one block (logic kept; the on-screen preview was removed)', () => {
    const v = emptyAvailability();
    v.selected.midday[6] = true; v.selected.evening[6] = true;
    render(<AvailabilityGrid value={v} onChange={() => {}} timeZone="UTC" />);
    expect(screen.queryByText(/12:00 PM–10:00 PM/)).toBeNull(); // no preview display
    expect(mergedDayRanges(v, 6)).toEqual([[12 * 60, 22 * 60]]); // Saturday midday + evening = one 12:00-22:00 block
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
    expect((screen.getByLabelText(/^Minimum passes/) as HTMLInputElement).value).toBe('3');
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByText(/^Timezone:/).textContent).toContain(browserTz);
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
    expect(screen.getByText(/^Timezone:/).textContent).toContain('Pacific/Auckland');
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
    expect(screen.getByText('Requirements')).toBeTruthy();
    expect(screen.queryByText('Pass requirements')).toBeNull();
    expect(screen.queryByText('What counts as a good pass?')).toBeNull();
    expect(text).not.toContain('Higher elevation means a stronger, longer pass');
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

describe('availability Check all / Uncheck all inside the plan form', () => {
  const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];
  it('do not trigger a search, persist through the existing settings, and change nothing else', async () => {
    const onSearch = vi.fn();
    savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'Pacific/Auckland', minElevationText: '55', durationMin: 180, minOpportunitiesText: '4', availability: emptyAvailability(), selectedIds: [27607] });
    render(<PlanForm busy={false} onSearch={onSearch} />);
    expect(boxes()).toHaveLength(21);
    await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
    expect(onSearch).not.toHaveBeenCalled(); // type=button: no form submit
    expect(boxes().every((b) => b.checked)).toBe(true);
    const saved = loadPrefs();
    for (const row of Object.values(saved.availability!.selected)) expect(row).toEqual(Array(7).fill(true));
    // nothing else changed
    expect(saved.timeZone).toBe('Pacific/Auckland');
    expect(saved.latText).toBe('42.35');
    expect(saved.minElevationText).toBe('55');
    expect(saved.durationMin).toBe(180);
    expect(saved.minOpportunitiesText).toBe('4');
    expect(saved.selectedIds).toEqual([27607]);
    expect(saved.availability!.periods).toEqual(emptyAvailability().periods);

    await userEvent.click(screen.getByRole('button', { name: 'Uncheck all' }));
    expect(onSearch).not.toHaveBeenCalled();
    expect(boxes().every((b) => !b.checked)).toBe(true);
    for (const row of Object.values(loadPrefs().availability!.selected)) expect(row).toEqual(Array(7).fill(false));
  });
  it('individual checkbox editing still works after Check all', async () => {
    render(<PlanForm busy={false} onSearch={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Saturday evening' }));
    expect((screen.getByRole('checkbox', { name: 'Saturday evening' }) as HTMLInputElement).checked).toBe(false);
    expect(boxes().filter((b) => b.checked)).toHaveLength(20);
    const saved = loadPrefs().availability!.selected;
    expect(saved.evening[6]).toBe(false);
    expect(saved.evening[5]).toBe(true);
  });
  it('leave the time ranges and the satellite selection alone', async () => {
    const heard = { reports: [[Math.floor((NOW - 3_600_000) / 1000), 'H', 0]] as [number, 'H', number][] };
    const elig = evaluateEligibility({ schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(), satellites: { 'SO-50_[FM]': heard, 'ISS_[FM]': heard } } as StatusFile, NOW);
    render(<PlanForm busy={false} onSearch={() => {}} eligibility={elig} />);
    const sat = () => (screen.getAllByRole('checkbox') as HTMLInputElement[]).filter((b) => /^(ISS|SO-50)/.test(b.getAttribute('aria-label') ?? b.closest('label')?.textContent ?? '')).map((b) => b.checked);
    const before = sat();
    const rangesBefore = (screen.getAllByDisplayValue(/^\d\d:\d\d$/) as HTMLInputElement[]).map((i) => i.value);
    await userEvent.click(screen.getByRole('button', { name: 'Check all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Uncheck all' }));
    expect(sat()).toEqual(before);
    expect((screen.getAllByDisplayValue(/^\d\d:\d\d$/) as HTMLInputElement[]).map((i) => i.value)).toEqual(rangesBefore);
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
  it('lists the satellites as one vertical list: one row per satellite, no columns', () => {
    const { container } = render(<PlanForm busy={false} onSearch={() => {}} eligibility={eligNoAo91} />);
    const items = container.querySelectorAll('.sat-list > li');
    expect(items.length).toBe(3); // ISS, SO-50 and AO-123 are eligible in this test data
    items.forEach((li) => expect(li.querySelectorAll('input[type=checkbox]').length).toBe(1)); // checkbox, name and badges share one row (label)
    expect(container.querySelector('.sat-list')!.tagName).toBe('UL');
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

describe('satellite picker: report tally and the corroborated-misses warning', () => {
  const sec = (hoursAgo: number) => Math.floor((NOW - hoursAgo * 3_600_000) / 1000);
  const statusFile: StatusFile = {
    schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(),
    satellites: {
      'ISS_[FM]': { reports: [[sec(1), 'H', 0], [sec(2), 'H', 1]] },
      'SO-50_[FM]': { reports: [[sec(1), 'N', 0], [sec(2), 'H', 1], [sec(3), 'H', 2]] }, // one newer miss: no warning
      'AO-91_[FM]': { reports: [[sec(1), 'N', 0], [sec(2), 'N', 1], [sec(4), 'H', 2]] }, // corroborated newer misses: warning
    },
  };
  const elig = evaluateEligibility(statusFile, NOW);
  const row = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) }) as HTMLInputElement;

  it('every satellite heard in the window has a checkbox and shows its tally', () => {
    render(<PlanForm busy={false} onSearch={() => {}} eligibility={elig} />);
    expect(row('ISS').closest('label')!.textContent).toContain('2 heard');
    expect(row('SO-50').closest('label')!.textContent).toContain('2 heard · 1 not heard');
    expect(row('AO-91').closest('label')!.textContent).toContain('1 heard · 2 not heard');
  });
  it('only the corroborated case carries the warning; a first-time visitor finds it unticked, and ticking it is honoured', async () => {
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} eligibility={elig} />);
    expect(row('AO-91').closest('label')!.textContent).toContain('⚠ newest 2 reports are misses');
    expect(row('SO-50').closest('label')!.textContent).not.toContain('⚠');
    expect([row('ISS').checked, row('SO-50').checked, row('AO-91').checked]).toEqual([true, true, false]);
    await userEvent.click(row('AO-91'));
    expect(row('AO-91').checked).toBe(true);
    expect(loadPrefs().selectedIds).toEqual([25544, 27607, 43017]); // the explicit choice is stored exactly as made
  });
});
