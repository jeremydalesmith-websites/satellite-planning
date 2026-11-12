// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { computePlan } from '../src/planner.ts';
import { DataFreshness } from '../src/ui/DataFreshness.tsx';
import { Results } from '../src/ui/Results.tsx';
import { T0, at, geom } from './factory.ts';
import { elementsFixture } from './helpers.ts';

afterEach(cleanup);

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
  criteria: { minElevationDeg: 40, durationMin: 150, minOpportunities: 1 },
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
    expect(screen.getByText(/promising event window/)).toBeTruthy();
  });
  it('keeps the concise provisional-prediction warning on the event card', () => {
    renderResults(T0);
    expect(screen.getAllByText(/Provisional plan\./).length).toBe(result.windows.length);
  });
  it('does not show a stale-data notice for fresh data', () => {
    renderResults(T0);
    expect(screen.queryByText(/days ago/)).toBeNull();
  });
});

describe('actionable warnings are preserved', () => {
  it('warns when the downloaded data is old', () => {
    renderResults(T0 + 10 * 86_400_000);
    expect(screen.getByText(/downloaded 10 days ago/)).toBeTruthy();
    expect(screen.getByText(/reports older than 72 hours cannot qualify a satellite/)).toBeTruthy();
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
