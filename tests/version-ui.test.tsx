// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAvailability } from '../src/availability/availability.ts';
import type { StatusFile } from '../src/data/ingest.ts';
import { RELOAD_MESSAGE, WORKER_FAILED_MESSAGE } from '../src/data/version.ts';
import { savePrefs } from '../src/storage.ts';
import { App } from '../src/ui/App.tsx';
import { FIXTURE_DOWNLOAD_MS, elementsFixture } from './helpers.ts';

const published = vi.hoisted(() => ({ newer: false }));
vi.mock('../src/data/version.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/version.ts')>()),
  newerVersionPublished: async () => published.newer,
}));

/**
 * A page opened before an update: the published planner (or its calculation script) has changed under it.
 * It must say "reload", clearly, instead of failing silently or crashing.
 */
const NOW = FIXTURE_DOWNLOAD_MS + 3_600_000;
const status = (): StatusFile => ({
  schema: 1, source: { name: 't', url: 'u', license: 'x' }, downloadedAt: new Date(NOW).toISOString(),
  satellites: { 'SO-50_[FM]': { reports: [[Math.floor((NOW - 1_800_000) / 1000), 'H', 0]] } },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const av = emptyAvailability();
  for (const d of [0, 1, 2, 3, 4, 5, 6]) for (const p of ['morning', 'midday', 'evening'] as const) av.selected[p][d] = true;
  savePrefs({ latText: '42.35', lonText: '-71.06', timeZone: 'UTC', minElevationText: '40', durationMin: 150, minOpportunitiesText: '1', availability: av, selectedIds: [27607] });
  vi.stubGlobal('fetch', vi.fn(async (u: URL | string) => {
    const files: Record<string, unknown> = { 'elements.json': elementsFixture, 'status.json': status() };
    const key = Object.keys(files).find((k) => String(u).endsWith(k));
    return new Response(key ? JSON.stringify(files[key]) : 'nope', { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); published.newer = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function searchApp() {
  render(<App />);
  await screen.findByText('Data and timing'); // data loaded
  fireEvent.click(screen.getByRole('button', { name: 'Find event windows' }));
}

describe('a page older than the published planner', () => {
  it('a search says to reload, calculates nothing, and does not crash', async () => {
    published.newer = true;
    await searchApp();
    expect((await screen.findByRole('alert')).textContent).toBe(RELOAD_MESSAGE);
    expect(screen.queryByText(/Calculating passes/)).toBeNull();
    expect(document.querySelector('section.results')).toBeNull();
  });
  it('if the calculation script cannot be loaded (it was removed by the update), the message says to reload', async () => {
    class BrokenWorker {
      onerror: ((e: { message: string }) => void) | null = null;
      onmessage: unknown = null;
      postMessage() { queueMicrotask(() => this.onerror?.({ message: '' })); }
      terminate() {}
    }
    vi.stubGlobal('Worker', BrokenWorker);
    await searchApp();
    expect((await screen.findByRole('alert')).textContent).toBe(WORKER_FAILED_MESSAGE);
  });
});

describe('newerVersionPublished (the real check)', () => {
  const real = async (build: string, f: typeof fetch) => (await vi.importActual<typeof import('../src/data/version.ts')>('../src/data/version.ts')).newerVersionPublished(build, f);
  const stub = (body: unknown, status = 200) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('is true only when version.json names a different build', async () => {
    expect(await real('abc123', stub({ build: 'def456' }))).toBe(true);
    expect(await real('abc123', stub({ build: 'abc123' }))).toBe(false);
  });
  it('is false whenever it cannot tell: no file, bad JSON, offline, a malformed body, or a dev/unknown build', async () => {
    expect(await real('abc123', stub('nope', 404))).toBe(false);
    expect(await real('abc123', stub('<html>'))).toBe(false);
    expect(await real('abc123', stub({ build: 42 }))).toBe(false);
    expect(await real('abc123', stub({}))).toBe(false);
    expect(await real('abc123', (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBe(false);
    expect(await real('dev', stub({ build: 'zzz' }))).toBe(false);
    expect(await real('unknown', stub({ build: 'zzz' }))).toBe(false);
  });
  it('asks the server to revalidate (no stale cached version file)', async () => {
    const f = stub({ build: 'abc123' });
    await real('abc123', f);
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1]).toMatchObject({ cache: 'no-cache' });
  });
});

describe('index.html', () => {
  it('has a fallback that replaces a blank page when the app script or stylesheet fails to load', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('index.html', 'utf8');
    expect(html).toContain("addEventListener('error'");
    expect(html).toContain('The planner could not be loaded');
    expect(html.indexOf("addEventListener('error'")).toBeLessThan(html.indexOf('type="module"')); // registered before the app script
  });
});
