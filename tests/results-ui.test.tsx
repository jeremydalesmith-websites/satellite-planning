// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App.tsx';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { computePlan } from '../src/planner.ts';
import { DataFreshness } from '../src/ui/DataFreshness.tsx';
import { Results } from '../src/ui/Results.tsx';
import { T0, at, geom } from './factory.ts';
import { elementsFixture } from './helpers.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The routine data box is gone from the results: its timestamps live only in the collapsed footer. */
const status: StatusFile = {
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(T0).toISOString(),
  satellites: { 'SO-50_[FM]': { reports: [[Math.floor((T0 - 3_600_000) / 1000), 'H', 0]] } },
};
const av = emptyAvailability();
for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p].fill(true);
av.periods = { morning: { startMin: 0, endMin: 480 }, midday: { startMin: 480, endMin: 960 }, evening: { startMin: 960, endMin: 1440 } };
const inputs = {
  observer: { latDeg: 0, lonDeg: 0, heightKm: 0 }, timeZone: 'UTC',
  criteria: { minElevationDeg: 40, maxSpanMin: 150, minOpportunities: 1 },
  availability: av, range: { start: at(-120), end: at(400) }, selectedNoradIds: [27607],
};
const result = computePlan(inputs, { elements: { ...elementsFixture, downloadedAt: new Date(T0).toISOString() }, status }, [geom({ norad: 27607, rise: 56, set: 68, maxEl: 70, above: [60, 64] })], [], [], T0);
const renderResults = (nowMs: number, statusProblem: string | null = null) =>
  render(<Results inputs={inputs} result={result} nowMs={nowMs} isSaved={() => false} onSave={() => {}} statusProblem={statusProblem} />);

describe('results lead straight into the event cards', () => {
  it('shows no metadata box: none of the routine timestamps appears in the results', () => {
    const { container } = renderResults(T0);
    const text = container.textContent ?? '';
    expect(result.windows.length).toBeGreaterThan(0);
    for (const label of ['Orbital data downloaded', 'Orbital elements dated', 'Status reports downloaded', 'Eligibility last checked', 'Eligibility checked', 'Predictions calculated', 'Data freshness']) {
      expect(text).not.toContain(label);
    }
    expect(container.querySelector('dl.fresh')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/qualifying pass/); // this fixture uses 1 minimum pass: single-pass mode
  });
  it('does not repeat a provisional-planning paragraph on any event card (the one note lives in the footer)', () => {
    const { container } = renderResults(T0);
    expect(result.windows.length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/Provisional plan|Planning estimates only|re-check before the event/i);
    expect(container.querySelector('.warning')).toBeNull();
  });
  it('does not show a stale-data notice for fresh data (only the small status-age hint)', () => {
    const { container } = renderResults(T0);
    expect(container.querySelector('.notice.warn')).toBeNull();
    expect(screen.queryByText(/days ago/)).toBeNull();
  });
});

describe('actionable warnings are preserved', () => {
  it('warns when the STATUS data is old (judged from the status download time, not the orbital download)', () => {
    renderResults(T0 + 10 * 86_400_000); // status was downloaded at T0
    expect(screen.getByText(/Status updated 10 days ago/)).toBeTruthy();
    expect(screen.getByText(/older than 72 hours cannot qualify a satellite/)).toBeTruthy();
  });
  it('shows the status-data-unavailable message', () => {
    renderResults(T0, 'Operating-status data is unavailable (HTTP 500). No satellite can be confirmed eligible without it, so none will be planned.');
    expect(screen.getByText(/Operating-status data is unavailable/)).toBeTruthy();
  });
  it('the collapsed diagnostics still explain exclusions, but carry no routine timestamps', () => {
    const { container } = renderResults(T0);
    const diag = container.querySelector('details.diagnostics')!;
    expect(diag.textContent).toMatch(/searching does not download new reports/);
    expect(diag.textContent).not.toMatch(/\b20\d\d\b|\b(AM|PM)\b/); // no dates or clock times
  });
});

describe('the footer data block', () => {
  it('carries all five routine items, including the download-vs-check distinction', () => {
    const { container } = render(
      <DataFreshness
        orbitalDownloadedAt={new Date(T0).toISOString()}
        epochs={[T0 - 86_400_000, T0 - 2 * 86_400_000]}
        statusDownloadedAt={new Date(T0 - 3_600_000).toISOString()}
        eligibilityCheckedAtMs={T0}
        predictionsCalculatedAtMs={T0}
        tz="UTC"
      />,
    );
    const text = container.textContent ?? '';
    for (const label of ['Orbital data downloaded', 'Orbital elements dated (epoch)', 'Status reports downloaded', 'Eligibility last checked', 'Predictions calculated']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('nothing is re-downloaded by searching');
  });
  it('says plainly when nothing is available or no search has run', () => {
    const { container } = render(
      <DataFreshness orbitalDownloadedAt={new Date(T0).toISOString()} epochs={[]} statusDownloadedAt={null} eligibilityCheckedAtMs={T0} predictionsCalculatedAtMs={null} tz="UTC" />,
    );
    expect(container.textContent).toContain('unavailable: no satellite can be confirmed');
    expect(container.textContent).toContain('not yet (run a search)');
  });
});

describe('the footer carries the one concise planning note', () => {
  it('shows it once, in the collapsed footer, alongside the data timing', async () => {
    const files: Record<string, unknown> = { 'elements.json': elementsFixture, 'status.json': status };
    vi.stubGlobal('fetch', vi.fn(async (u: URL | string) => {
      const key = Object.keys(files).find((k) => String(u).endsWith(k));
      return new Response(key ? JSON.stringify(files[key]) : 'nope', { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }));
    const { container } = render(<App />);
    await screen.findByText('Data and timing');
    const footer = container.querySelector('footer details')!;
    expect(footer.hasAttribute('open')).toBe(false); // collapsed by default
    const note = 'Planning estimates only. Recheck pass times and repeater status before the event.';
    expect((footer.textContent ?? '').split(note).length - 1).toBe(1);
    expect(container.querySelector('main')!.textContent).not.toContain('Planning estimates only');
  });
});
