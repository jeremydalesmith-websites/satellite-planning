// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import { loadData } from '../src/data/load.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { computePlan } from '../src/planner.ts';
import { savePrefs } from '../src/storage.ts';
import { App } from '../src/ui/App.tsx';
import { PlanForm } from '../src/ui/PlanForm.tsx';
import { Results } from '../src/ui/Results.tsx';
import { T0, at, geom } from './factory.ts';
import { elementsFixture } from './helpers.ts';

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const heard = (key: string): [string, { reports: [number, 'H', number][] }] => [key, { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] }];
const status = (downloadedMs = T0): StatusFile => ({
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(downloadedMs).toISOString(),
  satellites: Object.fromEntries([heard('SO-50_[FM]'), heard('ISS_[FM]')]),
});
const fullDay = () => {
  const av = emptyAvailability();
  for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
  av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
  return av;
};
const inputs = {
  observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
  criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 2 },
  availability: fullDay(), range: { start: at(-120), end: at(600) }, selectedNoradIds: [27607, 25544],
};

describe('finding 1: pressing Search uses the time of the click, not the time of the last edit', () => {
  it('a form filled in yesterday and searched this morning starts its range at the click time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 0, 9, 12, 0, 0)); // the form is filled in at 12:00
    const av = emptyAvailability();
    av.selected.evening[6] = true;
    savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'UTC', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: av });
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    vi.setSystemTime(Date.UTC(2027, 0, 10, 9, 30, 0)); // ... and searched 21.5 hours later with no edit in between
    fireEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0]![0].range.start).toBeGreaterThanOrEqual(Date.UTC(2027, 0, 10, 9, 30, 0));
  });
});

describe('validation: a date range that has fully passed is reported when Search is clicked', () => {
  const prime = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 0, 9, 12, 0, 0)); // the form is filled in on 9 Jan with its default 28-day range
    const av = emptyAvailability();
    av.selected.evening[6] = true;
    savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'UTC', minElevationText: '40', durationMin: 150, minOpportunitiesText: '3', availability: av });
  };
  it('shows the fresh error instead of silently doing nothing, and does not search', () => {
    prime();
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    vi.setSystemTime(Date.UTC(2027, 2, 1, 9, 0, 0)); // searched on 1 March: the whole range (to 5 Feb) is now in the past
    fireEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/entirely in the past/);
    expect(document.getElementById('end-err')!.textContent).toMatch(/entirely in the past/); // also next to the dates
  });
  it('the error clears once the dates are corrected, and a valid search then goes ahead', () => {
    prime();
    const onSearch = vi.fn();
    render(<PlanForm busy={false} onSearch={onSearch} />);
    vi.setSystemTime(Date.UTC(2027, 2, 1, 9, 0, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(screen.queryByRole('alert')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-02' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-03-20' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});

describe('finding 5: result cards have stable, unique keys', () => {
  it('two clusters that start at the same instant do not trigger React\'s duplicate-key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A starts both clusters. B (30-40) and C (30-45) overlap, so {A,B} (ending 40) and the better {A,C} (ending 45) are two
    // distinct clusters that share the same start time.
    const passes = [
      geom({ norad: 27607, rise: 10, set: 20, maxEl: 60 }),
      geom({ norad: 25544, rise: 30, set: 40, maxEl: 60 }),
      geom({ norad: 27607, rise: 30, set: 45, maxEl: 60 }),
    ];
    const plan = computePlan(inputs, { elements: elementsFixture, status: status() }, passes, [], [], T0);
    const starts = plan.windows.map((w) => w.window.start);
    expect(plan.windows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(starts).size).toBeLessThan(starts.length); // precondition: a start time alone is NOT unique
    render(<Results inputs={inputs} result={plan} nowMs={T0} isSaved={() => false} onSave={() => {}} statusProblem={null} />);
    expect(errors.mock.calls.some((c) => /same key|unique "key"/i.test(String(c[0]) + String(c[1])))).toBe(false);
    expect(document.querySelectorAll('section.event')).toHaveLength(plan.windows.length);
  });
});

describe('finding 7: a malformed status file fails closed with an understandable message', () => {
  const respond = (files: Record<string, unknown>) =>
    vi.stubGlobal('fetch', vi.fn(async (u: URL | string) => {
      const key = Object.keys(files).find((k) => String(u).endsWith(k));
      return new Response(key ? JSON.stringify(files[key]) : 'nope', { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }));
  const malformed = { ...status(), satellites: { 'SO-50_[FM]': {}, 'ISS_[FM]': { reports: 'oops' } } };

  it('loadData treats it as unavailable status data, with the reason', async () => {
    respond({ 'elements.json': elementsFixture, 'status.json': malformed });
    const r = await loadData();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBeNull();
      expect(r.statusProblem).toMatch(/malformed/);
      expect(r.statusProblem).toMatch(/SO-50_\[FM\]/);
      expect(r.statusProblem).toMatch(/none will be planned/);
    }
  });
  it('the whole app renders (no crash) and shows the data problem instead of any eligible satellite', async () => {
    respond({ 'elements.json': elementsFixture, 'status.json': malformed });
    const { container } = render(<App />);
    await screen.findByText(/Operating-status data is unavailable/);
    expect(container.textContent).toMatch(/malformed/);
    expect(container.querySelector('.sat-list')).toBeNull(); // nothing can be confirmed eligible, so nothing is offered
  });
});

describe('data freshness: a compact status-age indicator, judged from the STATUS download time', () => {
  const planWith = (statusDownloadedMs: number | null, elementsDownloadedMs = T0) =>
    computePlan(inputs, { elements: { ...elementsFixture, downloadedAt: new Date(elementsDownloadedMs).toISOString() }, status: statusDownloadedMs === null ? null : status(statusDownloadedMs) },
      [geom({ norad: 27607, rise: 56, set: 68, maxEl: 70 }), geom({ norad: 25544, rise: 96, set: 109, maxEl: 50 })], [], [], T0);
  const show = (p: ReturnType<typeof planWith>, nowMs: number, statusProblem: string | null = null) =>
    render(<Results inputs={inputs} result={p} nowMs={nowMs} isSaved={() => false} onSave={() => {}} statusProblem={statusProblem} />);
  const H = 3_600_000;

  it('shows "Status updated 2 hours ago." as a small hint, not a warning, and no metadata box', () => {
    const { container } = show(planWith(T0 - 2 * H), T0);
    expect(container.querySelector('.status-age')!.textContent).toBe('Status updated 2 hours ago.');
    expect(container.querySelector('.notice.warn')).toBeNull();
    expect(container.querySelector('dl.fresh')).toBeNull();
    for (const label of ['Orbital data downloaded', 'Eligibility last checked', 'Predictions calculated']) expect(container.textContent).not.toContain(label);
  });
  it('wording: just now, minutes, singular hour', () => {
    expect(show(planWith(T0), T0).container.querySelector('.status-age')!.textContent).toBe('Status updated just now.');
    cleanup();
    expect(show(planWith(T0 - 5 * 60_000), T0).container.querySelector('.status-age')!.textContent).toBe('Status updated 5 minutes ago.');
    cleanup();
    expect(show(planWith(T0 - 1 * H), T0).container.querySelector('.status-age')!.textContent).toBe('Status updated 1 hour ago.');
  });
  it('turns into a warning after 24 hours: newer reports are not included', () => {
    const { container } = show(planWith(T0 - 30 * H), T0);
    const warn = container.querySelector('.notice.warn')!;
    expect(warn.textContent).toMatch(/Status updated 30 hours ago/);
    expect(warn.textContent).toMatch(/Reports filed since then are not included/);
    expect(container.querySelector('.status-age')).toBeNull(); // not shown twice
  });
  it('beyond 72 hours it says plainly that nothing can qualify', () => {
    const { container } = show(planWith(T0 - 5 * 24 * H), T0);
    expect(container.querySelector('.notice.warn')!.textContent).toMatch(/Status updated 5 days ago.*older than 72 hours cannot qualify a satellite/);
  });
  it('is judged from the STATUS download time: old orbital data with fresh status gives no status warning', () => {
    const { container } = show(planWith(T0 - 1 * H, T0 - 10 * 24 * H), T0);
    expect(container.querySelector('.notice.warn')).toBeNull();
    expect(container.querySelector('.status-age')!.textContent).toBe('Status updated 1 hour ago.');
  });
  it('and old status with fresh orbital data does warn', () => {
    const { container } = show(planWith(T0 - 40 * H, T0), T0);
    expect(container.querySelector('.notice.warn')).not.toBeNull();
  });
  it('missing status is clear without a duplicate: one compact line, or the load problem alone', () => {
    const none = planWith(null);
    expect(show(none, T0).container.querySelector('.status-age')!.textContent).toBe('Status data unavailable.');
    cleanup();
    const withProblem = show(none, T0, 'Operating-status data is unavailable (HTTP 404). No satellite can be confirmed eligible without it, so none will be planned.');
    expect(withProblem.container.querySelector('.status-age')).toBeNull();
    expect(withProblem.container.textContent).toMatch(/Operating-status data is unavailable \(HTTP 404\)/);
  });
});

describe('page heading', () => {
  it('shows "Satellite Pass Planner" with the new subtitle', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: URL | string) => {
      const files: Record<string, unknown> = { 'elements.json': elementsFixture, 'status.json': status() };
      const key = Object.keys(files).find((k) => String(u).endsWith(k));
      return new Response(key ? JSON.stringify(files[key]) : 'nope', { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }));
    const { container } = render(<App />);
    expect(container.querySelector('h1')!.textContent).toBe('Satellite Pass Planner');
    expect(container.querySelector('.subtitle')!.textContent).toBe('Find FM satellite pass clusters for your next club event.');
    await screen.findByText('Data and timing'); // let the data load settle before the test ends
  });
});
