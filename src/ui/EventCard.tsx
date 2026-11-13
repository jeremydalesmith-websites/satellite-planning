import { envelopesOverlap } from '../cluster/cluster.ts';
import type { EventWindow } from '../cluster/cluster.ts';
import type { Criteria } from '../domain/types.ts';
import type { PredictionMeta } from '../planner.ts';
import { PassCard } from './PassCard.tsx';
import { Timeline } from './Timeline.tsx';
import { fmtDay, fmtEndMin, fmtSpanMin, fmtStartMin, tzAbbrev } from './format.ts';

interface Props {
  event: EventWindow;
  rank: number;
  tz: string;
  criteria: Criteria;
  meta: PredictionMeta;
  saved: boolean;
  onSave: () => void;
}

/**
 * One cluster. The header shows the ACTUAL cluster: earliest full-pass AOS to latest full-pass LOS of the counted
 * passes, and the elapsed time between them (gaps included). Clock times are shown to the minute, rounded outward so the
 * header never appears to exclude part of a counted pass; the duration is the exact span to the nearest minute (never above
 * the maximum). The selected hours are only a maximum span, never padded in. Pass details keep seconds.
 */
export function EventCard({ event: e, rank, tz, criteria, meta, saved, onSave }: Props) {
  const overlapNames = (id: string) => {
    const a = e.alternatives.find((x) => x.passId === id)!;
    return e.counted.filter((c) => envelopesOverlap(c, a)).map((c) => c.name);
  };
  const ok = e.counted.length >= criteria.minOpportunities;
  const hasMore = e.alternatives.length + e.excluded.length > 0;

  return (
    <section className="card event" aria-labelledby={`ev-${rank}`}>
      <header>
        <div>
          <p className="rank">Option {rank}</p>
          <h3 id={`ev-${rank}`}>{fmtDay(e.window.start, tz)}</h3>
          <p className="when">
            <strong>{fmtStartMin(e.window.start, tz)} – {fmtEndMin(e.window.end, tz)}</strong> {tzAbbrev(e.window.start, tz)} · {fmtSpanMin(e.window.start, e.window.end)}
          </p>
        </div>
        <button type="button" className={saved ? 'secondary saved' : 'primary'} onClick={onSave} aria-pressed={saved}>
          {saved ? 'Saved ✓ (update)' : 'Save this event'}
        </button>
      </header>

      <p className="summary">
        <span className="big">{e.counted.length}</span> qualifying pass{e.counted.length === 1 ? '' : 'es'}
        {criteria.minOpportunities > 1 && (
          <>
            {' '}<span className="sep">·</span> <span className="big">{e.distinctSatellites}</span> satellite{e.distinctSatellites === 1 ? '' : 's'}
          </>
        )}
        {!ok && <span className="warn"> (below your minimum of {criteria.minOpportunities})</span>}
      </p>

      <Timeline window={e.window} tz={tz} items={e.counted.map((pass) => ({ pass, kind: 'counted' as const }))} />

      {e.counted.map((p) => <PassCard key={p.passId} pass={p} role="counted" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}

      {hasMore && (
        <details className="more">
          <summary>Details</summary>
          {e.alternatives.length > 0 && (
            <>
              <h4 className="group">{e.alternatives.length} overlapping alternative{e.alternatives.length === 1 ? '' : 's'}</h4>
              {e.alternatives.map((p) => <PassCard key={p.passId} pass={p} role="alternative" tz={tz} overlapNames={overlapNames(p.passId)} statusDownloadedAt={meta.statusDownloadedAt} />)}
            </>
          )}
          {e.excluded.length > 0 && (
            <>
              <h4 className="group">Other passes left out</h4>
              {e.excluded.map((p) => <PassCard key={p.passId} pass={p} role="excluded" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}
            </>
          )}
        </details>
      )}
    </section>
  );
}
