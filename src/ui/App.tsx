import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { consideredIds, evaluateEligibility } from '../eligibility/eligibility.ts';
import { loadData } from '../data/load.ts';
import type { LoadResult } from '../data/load.ts';
import { predictInWorker } from '../orbit/client.ts';
import type { PredictHandle } from '../orbit/client.ts';
import { computePlan, predictionThresholds, usableElements } from '../planner.ts';
import type { PlanInputs, PlanResult } from '../planner.ts';
import { snapshotEvent } from '../saved/saved.ts';
import type { SavedEvent } from '../saved/saved.ts';
import { loadEvents, saveEvents } from '../storage.ts';
import { PlanForm } from './PlanForm.tsx';
import { Results } from './Results.tsx';
import { SavedEvents } from './SavedEvents.tsx';
import { SOURCES } from '../catalog/catalog.ts';
import { browserTimeZone } from './PlanForm.tsx';
import { DataFreshness } from './DataFreshness.tsx';

type Tab = 'plan' | 'saved';
type Search =
  | { state: 'idle' }
  | { state: 'running'; done: number; total: number; name: string }
  | { state: 'error'; message: string }
  | { state: 'done'; inputs: PlanInputs; result: PlanResult; nowMs: number };

export function App() {
  const [tab, setTab] = useState<Tab>('plan');
  const [load, setLoad] = useState<LoadResult | null>(null);
  const [search, setSearch] = useState<Search>({ state: 'idle' });
  const [events, setEvents] = useState<SavedEvent[]>(() => loadEvents());
  const [storageWarn, setStorageWarn] = useState(false);
  const handle = useRef<PredictHandle | null>(null);
  // Current-time snapshot for the picker and the Saved tab. Taken again every time a tab is opened,
  // so reopening saved events re-evaluates eligibility against the time NOW, not page-load time.
  // (A search takes its own single snapshot inside runSearch.)
  const [nowMs, setNowMs] = useState(() => Date.now());
  const openTab = (t: Tab) => {
    setNowMs(Date.now());
    setTab(t);
  };

  useEffect(() => {
    let cancelled = false;
    loadData().then((r) => !cancelled && setLoad(r));
    return () => {
      cancelled = true;
      handle.current?.cancel();
    };
  }, []);

  const data = load?.ok ? load.data : null;
  const eligibility = useMemo(() => (data ? evaluateEligibility(data.status, nowMs) : null), [data, nowMs]);

  const runSearch = useCallback(
    async (inputs: PlanInputs) => {
      if (!data) return;
      handle.current?.cancel();
      const now = Date.now(); // the ONE time snapshot for this whole search
      const { usable, skipped } = usableElements(data.elements, now);
      if (usable.length === 0) {
        setSearch({ state: 'error', message: 'No satellite has orbital data recent enough to predict from. Nothing was calculated.' });
        return;
      }
      // Only satellites that are eligible now AND selected are predicted at all.
      const considered = consideredIds(evaluateEligibility(data.status, now), inputs.selectedNoradIds);
      const toPredict = usable.filter((s) => considered.has(s.noradId));
      if (toPredict.length === 0) {
        setSearch({ state: 'done', inputs, result: computePlan(inputs, data, [], [], skipped, now, now), nowMs: now });
        setTimeout(() => document.getElementById('results-title')?.focus(), 50);
        return;
      }
      setSearch({ state: 'running', done: 0, total: toPredict.length, name: '' });
      const h = predictInWorker(
        {
          elements: toPredict,
          observer: inputs.observer,
          startMs: inputs.range.start,
          endMs: inputs.range.end,
          thresholdsDeg: predictionThresholds(inputs.criteria.minElevationDeg),
        },
        (done, total, name) => setSearch({ state: 'running', done, total, name }),
      );
      handle.current = h;
      try {
        const run = await h.promise;
        const result = computePlan(inputs, data, run.passes, run.errors, skipped, now, now);
        setSearch({ state: 'done', inputs, result, nowMs: now });
        setTimeout(() => document.getElementById('results-title')?.focus(), 50);
      } catch (e) {
        setSearch({ state: 'error', message: `The calculation failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    [data],
  );

  const persist = (list: SavedEvent[]) => {
    setEvents(list);
    setStorageWarn(!saveEvents(list));
  };

  const sameEvent = (e: SavedEvent, start: number, end: number, inputs: PlanInputs) =>
    e.window.start === start && e.window.end === end &&
    e.location.latDeg === inputs.observer.latDeg && e.location.lonDeg === inputs.observer.lonDeg;

  const save = (idx: number) => {
    if (search.state !== 'done') return;
    const { inputs, result } = search;
    const w = result.windows[idx];
    if (!w) return;
    const snap = snapshotEvent(
      w,
      { latDeg: inputs.observer.latDeg, lonDeg: inputs.observer.lonDeg },
      inputs.timeZone,
      inputs.criteria,
      result.meta,
      Date.now(),
    );
    persist([...events.filter((e) => !sameEvent(e, w.window.start, w.window.end, inputs)), snap]);
  };

  return (
    <div className="app">
      <header className="top">
        <h1>FM Satellite Event Planner</h1>
        <nav aria-label="Sections">
          <button type="button" className={tab === 'plan' ? 'tab on' : 'tab'} aria-current={tab === 'plan' ? 'page' : undefined} onClick={() => openTab('plan')}>Plan</button>
          <button type="button" className={tab === 'saved' ? 'tab on' : 'tab'} aria-current={tab === 'saved' ? 'page' : undefined} onClick={() => openTab('saved')}>
            Saved events{events.length ? ` (${events.length})` : ''}
          </button>
        </nav>
      </header>

      <main>
        {load === null && <p className="card" role="status">Loading orbital data…</p>}
        {load && !load.ok && (
          <div className="card alert-box" role="alert">
            <h2>Data unavailable</h2>
            <p>{load.message}</p>
            <p>Nothing is estimated or made up in its place. If you are running this site yourself, run <code>npm start</code> (it downloads the data first), or <code>npm run refresh-data</code>, then reload.</p>
          </div>
        )}
        {load?.ok && load.statusProblem && tab === 'plan' && <p className="notice warn" role="note">{load.statusProblem}</p>}
        {storageWarn && <p className="notice warn" role="alert">Your browser blocked saving. Saved events will be lost when you close this page.</p>}

        {tab === 'plan' && (
          <>
            <PlanForm busy={search.state === 'running' || !data} onSearch={runSearch} eligibility={eligibility} />
            {search.state === 'running' && (
              <p className="card progress" role="status" aria-live="polite">
                Calculating passes… {search.done} of {search.total}{search.name ? ` (${search.name})` : ''}
                <progress max={search.total} value={search.done} />
              </p>
            )}
            {search.state === 'error' && <p className="card alert-box" role="alert">{search.message}</p>}
            {search.state === 'done' && (
              <Results
                inputs={search.inputs}
                result={search.result}
                nowMs={search.nowMs}
                statusProblem={load?.ok ? load.statusProblem : null}
                isSaved={(s, e) => events.some((x) => sameEvent(x, s, e, search.inputs))}
                onSave={save}
              />
            )}
          </>
        )}
        {tab === 'saved' && (
          <SavedEvents events={events} data={data} nowMs={nowMs} onDelete={(id) => persist(events.filter((e) => e.id !== id))} />
        )}
      </main>

      <footer>
        <details>
          <summary>About this planner, data sources and limits</summary>
          <ul>
            <li>Orbits are calculated in your browser with SGP4 (satellite.js) from public orbital elements published by <a href={SOURCES.amsatTle.url}>AMSAT</a>.</li>
            {data && (
              <li>
                <strong>Data and timing</strong>
                <DataFreshness
                  orbitalDownloadedAt={data.elements.downloadedAt}
                  epochs={data.elements.sets.map((s) => s.epochMs)}
                  statusDownloadedAt={data.status?.downloadedAt ?? null}
                  eligibilityCheckedAtMs={search.state === 'done' ? search.nowMs : nowMs}
                  predictionsCalculatedAtMs={search.state === 'done' ? search.result.meta.generatedAtMs : null}
                  tz={browserTimeZone()}
                />
              </li>
            )}
            <li>Repeater activity comes from volunteer reports on the <a href={SOURCES.amsatStatus.url}>AMSAT status page</a> (reports licensed CC BY 4.0). A satellite is considered only with a “heard” report for its FM repeater in the last 72 hours; a heard beacon does not count.</li>
            <li>Frequencies and operating notes were copied by hand from <a href={SOURCES.amsatFm.url}>AMSAT’s FM satellite page</a>; they are not live and may be out of date.</li>
            <li>Predictions weeks ahead are estimates, not second-accurate. Re-check close to the event; saved events do this for you when opened.</li>
            <li>Only FM voice repeaters on 2 m / 70 cm are planned. No live tracking, Doppler, SSTV, or linear transponders in this version.</li>
          </ul>
        </details>
      </footer>
    </div>
  );
}
