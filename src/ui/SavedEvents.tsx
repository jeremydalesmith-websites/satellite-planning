import { useMemo } from 'react';
import { ACTIVITIES } from '../catalog/catalog.ts';
import type { LoadedData } from '../planner.ts';
import { recheckSavedEvent } from '../saved/recheck.ts';
import type { SavedEvent } from '../saved/saved.ts';
import { PassCard } from './PassCard.tsx';
import { Timeline } from './Timeline.tsx';
import { fmtDateTime, fmtDay, fmtEndMin, fmtSpanMin, fmtStartMin, fmtTime, tzAbbrev } from './format.ts';

interface Props {
  events: SavedEvent[];
  data: LoadedData | null;
  nowMs: number;
  onDelete: (id: string) => void;
  /** Entries saved by an earlier version (fixed-window model): left untouched, not shown, removable on request. */
  legacyCount?: number;
  onClearLegacy?: () => void;
}

function LegacyNotice({ count, onClear }: { count: number; onClear?: () => void }) {
  if (count <= 0) return null;
  return (
    <p className="notice warn" role="note">
      {count} saved event{count === 1 ? ' was' : 's were'} made with an earlier version of this planner (a different event model) and cannot be shown or re-checked here. {count === 1 ? 'It is' : 'They are'} still stored, untouched.
      {onClear && <> <button type="button" className="link" onClick={onClear}>Remove {count === 1 ? 'it' : 'them'}</button></>}
    </p>
  );
}

export function SavedEvents({ events, data, nowMs, onDelete, legacyCount = 0, onClearLegacy }: Props) {
  if (events.length === 0) {
    return (
      <section className="card">
        <h2>Saved events</h2>
        <LegacyNotice count={legacyCount} onClear={onClearLegacy} />
        <p>No saved events yet. Save one from the search results; its date and time stay fixed.</p>
      </section>
    );
  }
  const sorted = [...events].sort((a, b) => a.window.start - b.window.start);
  return (
    <section aria-labelledby="saved-title">
      <h2 id="saved-title">Saved events</h2>
      <LegacyNotice count={legacyCount} onClear={onClearLegacy} />
      <p className="hint">Saved event times stay fixed. Satellite status is checked using previously downloaded reports.</p>
      {sorted.map((ev) => <SavedCard key={ev.id} ev={ev} data={data} nowMs={nowMs} onDelete={() => onDelete(ev.id)} />)}
    </section>
  );
}

function SavedCard({ ev, data, nowMs, onDelete }: { ev: SavedEvent; data: LoadedData | null; nowMs: number; onDelete: () => void }) {
  const out = useMemo(() => recheckSavedEvent(ev, data, nowMs), [ev, data, nowMs]);
  const tz = ev.timeZone;
  const c = ev.criteria;

  return (
    <article className="card event saved" aria-label={`Saved event ${fmtDay(ev.window.start, tz)}`}>
      <header>
        <div>
          <h3>{fmtDay(ev.window.start, tz)}</h3>
          <p className="when">
            <strong>{fmtStartMin(ev.window.start, tz)} – {fmtEndMin(ev.window.end, tz)}</strong> {tzAbbrev(ev.window.start, tz)} · {fmtSpanMin(ev.window.start, ev.window.end)}
          </p>
          <p className="hint small">
            Needs {c.minOpportunities === 1 ? 'at least 1 pass' : `${c.minOpportunities}+ passes`} peaking at {c.minElevationDeg}°+ · location {ev.location.latDeg.toFixed(2)}, {ev.location.lonDeg.toFixed(2)} · saved {fmtDateTime(ev.savedAtMs, tz)}
          </p>
        </div>
        <button type="button" className="danger" onClick={onDelete}>Delete</button>
      </header>

      <p className="summary">
        When saved: <strong>{ev.original.counted.length}</strong> passes from <strong>{ev.original.distinctSatellites}</strong> satellite{ev.original.distinctSatellites === 1 ? '' : 's'}
        {out.ok && <> · Now: <strong>{out.recheck.countNow}</strong> passes</>}
      </p>

      {!out.ok && <p className="notice warn" role="note">{out.message}</p>}
      {out.ok && out.passed && <p className="notice" role="note">This event is in the past.</p>}
      {out.ok && out.skippedNote && <p className="notice" role="note">{out.skippedNote}</p>}

      {out.ok && !out.passed && !out.recheck.meetsMinimum && (
        <p className="alert-box" role="alert">
          <strong>Heads up:</strong> with current data this saved interval has {out.recheck.countNow} qualifying pass{out.recheck.countNow === 1 ? '' : 'es'}, below the {c.minOpportunities} you asked for. The event has not been moved. You may want to search for an alternative.
        </p>
      )}
      {out.ok && !out.passed && out.recheck.meetsMinimum && out.recheck.changes.length === 0 && (
        <p className="ok-box">No meaningful changes since you saved it.</p>
      )}
      {out.ok && out.recheck.lostEligibility.length > 0 && (
        <div className="alert-box" role="alert">
          <h4>Eligibility changed</h4>
          <ul>
            {out.recheck.lostEligibility.map((l, i) => (
              <li key={i}>{l.name} (peak {fmtTime(l.peakMs, tz)}): {l.reason}. It no longer counts; the saved date and time have not moved.</li>
            ))}
          </ul>
        </div>
      )}
      {out.ok && out.recheck.changes.some((x) => x.kind !== 'eligibility') && (
        <div className="changes">
          <h4>What changed</h4>
          <ul>{out.recheck.changes.filter((x) => x.kind !== 'eligibility').map((x, i) => <li key={i} className={x.kind}>{x.text}</li>)}</ul>
        </div>
      )}

      {out.ok ? (
        <>
          <Timeline window={ev.window} tz={tz} items={out.recheck.evaluation.counted.map((pass) => ({ pass, kind: 'counted' as const }))} />
          <h4 className="group">Counted now</h4>
          {out.recheck.evaluation.counted.length === 0 && <p>None.</p>}
          {out.recheck.evaluation.counted.map((p) => (
            <PassCard key={p.passId} pass={p} role="counted" tz={tz} statusDownloadedAt={out.statusDownloadedAt} />
          ))}
        </>
      ) : (
        <>
          <h4 className="group">As saved (eligibility not re-confirmed)</h4>
          <ul>
            {ev.original.counted.map((o, i) => (
              <li key={i}>{o.name}: peak {fmtTime(o.peakMs, tz)}, {o.fullMaxElevationDeg.toFixed(0)}° ({ACTIVITIES.find((a) => a.noradId === o.noradId)?.bandConfig ?? ''})</li>
            ))}
          </ul>
        </>
      )}
      <p className="hint small">
        Original prediction: orbital data downloaded {fmtDateTime(Date.parse(ev.original.meta.elementsDownloadedAt), tz)}, calculated {fmtDateTime(ev.original.meta.generatedAtMs, tz)}.
      </p>
    </article>
  );
}
