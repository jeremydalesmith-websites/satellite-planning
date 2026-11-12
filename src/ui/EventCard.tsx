import { overlaps } from '../domain/intervals.ts';
import type { EventWindow } from '../cluster/cluster.ts';
import type { Criteria } from '../domain/types.ts';
import { TIER_TEXT, horizonTier, worstTier } from '../orbit/horizon.ts';
import type { PredictionMeta } from '../planner.ts';
import { PassCard } from './PassCard.tsx';
import { Timeline } from './Timeline.tsx';
import { fmtDay, fmtTime, tzAbbrev } from './format.ts';

interface Props {
  event: EventWindow;
  rank: number;
  tz: string;
  criteria: Criteria;
  meta: PredictionMeta;
  saved: boolean;
  onSave: () => void;
}

export function EventCard({ event: e, rank, tz, criteria, meta, saved, onSave }: Props) {
  const tier = worstTier(e.counted.map((c) => horizonTier(c.peakMs, meta.epochs[c.noradId] ?? meta.generatedAtMs)));
  // One concise warning. Repeater reports are evidence of operation now, not of the event date.
  const warning = `Provisional plan. ${TIER_TEXT[tier].short} Repeater status reflects recent reports, not the event date.`;

  const overlapNames = (id: string) => {
    const a = e.alternatives.find((x) => x.passId === id)!;
    return e.counted.filter((c) => overlaps(c.operating!, a.operating!)).map((c) => c.name);
  };
  const dur = (e.window.end - e.window.start) / 3_600_000;
  const ok = e.counted.length >= criteria.minOpportunities;
  const hasMore = e.alternatives.length + e.edge.length + e.excluded.length > 0 || e.similarWindows > 0;

  return (
    <section className="card event" aria-labelledby={`ev-${rank}`}>
      <header>
        <div>
          <p className="rank">Option {rank}</p>
          <h3 id={`ev-${rank}`}>{fmtDay(e.window.start, tz)}</h3>
          <p className="when">
            <strong>{fmtTime(e.window.start, tz)} – {fmtTime(e.window.end, tz)}</strong> {tzAbbrev(e.window.start, tz)} · {dur} hours
          </p>
        </div>
        <button type="button" className={saved ? 'secondary saved' : 'primary'} onClick={onSave} aria-pressed={saved}>
          {saved ? 'Saved ✓ (update)' : 'Save this event'}
        </button>
      </header>

      <p className="summary">
        <span className="big">{e.counted.length}</span> qualifying passes{' '}
        <span className="sep">·</span> <span className="big">{e.distinctSatellites}</span> satellite{e.distinctSatellites === 1 ? '' : 's'}
        {!ok && <span className="warn"> (below your minimum of {criteria.minOpportunities})</span>}
      </p>

      <Timeline window={e.window} tz={tz} items={e.counted.map((pass) => ({ pass, kind: 'counted' as const }))} />

      <p className="warning" role="note">{warning}</p>

      {e.counted.map((p) => <PassCard key={p.passId} pass={p} role="counted" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}

      {hasMore && (
        <details className="more">
          <summary>Details</summary>
          {e.similarWindows > 0 && (
            <p className="hint small">{e.similarWindows} nearly identical window{e.similarWindows === 1 ? '' : 's'} (same day, mostly overlapping) folded into this one.</p>
          )}
          {e.alternatives.length > 0 && (
            <>
              <h4 className="group">{e.alternatives.length} overlapping alternative{e.alternatives.length === 1 ? '' : 's'}</h4>
              {e.alternatives.map((p) => <PassCard key={p.passId} pass={p} role="alternative" tz={tz} overlapNames={overlapNames(p.passId)} statusDownloadedAt={meta.statusDownloadedAt} />)}
            </>
          )}
          {(e.edge.length > 0 || e.excluded.length > 0) && (
            <>
              <h4 className="group">Other passes left out</h4>
              {e.edge.map((p) => <PassCard key={p.passId} pass={p} role="edge" tz={tz} window={e.window} statusDownloadedAt={meta.statusDownloadedAt} />)}
              {e.excluded.map((p) => <PassCard key={p.passId} pass={p} role="excluded" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}
            </>
          )}
        </details>
      )}
    </section>
  );
}
