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
  const caveats: string[] = [];
  if (tier !== 'near-term') caveats.push(`${TIER_TEXT[tier].label}. ${TIER_TEXT[tier].note}`);
  const sched = e.counted.filter((c) => c.status.scheduleDependent);
  if (sched.length) caveats.push(`${[...new Set(sched.map((c) => c.name))].join(', ')} operate${sched.length === 1 ? 's' : ''} only at certain times; recent reports say active, but that may change.`);
  const lit = e.counted.filter((c) => c.sunlightRestricted && c.sunlight !== 'illuminated');
  if (lit.length) caveats.push(`${[...new Set(lit.map((c) => c.name))].join(', ')} can only be used while sunlit; only the sunlit part of the pass is counted.`);
  if (e.conditional.length) caveats.push(`${e.conditional.length} more pass${e.conditional.length === 1 ? '' : 'es'} could happen here but ${e.conditional.length === 1 ? 'is' : 'are'} not counted because the repeater status is unconfirmed.`);
  if (e.edge.length) caveats.push(`${e.edge.length} pass${e.edge.length === 1 ? ' is' : 'es are'} cut off by the start or end of the event and ${e.edge.length === 1 ? 'is' : 'are'} not counted.`);
  if (e.similarWindows > 0) caveats.push(`${e.similarWindows} nearly identical window${e.similarWindows === 1 ? '' : 's'} (same day, mostly overlapping) folded into this one.`);

  const overlapNames = (id: string) => {
    const a = e.alternatives.find((x) => x.passId === id)!;
    return e.counted.filter((c) => overlaps(c.operating!, a.operating!)).map((c) => c.name);
  };
  const dur = (e.window.end - e.window.start) / 3_600_000;
  const ok = e.counted.length >= criteria.minOpportunities;

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
        <span className={`tier ${tier}`}>{TIER_TEXT[tier].label}</span>
      </p>

      <Timeline
        window={e.window}
        tz={tz}
        items={[
          ...e.counted.map((pass) => ({ pass, kind: 'counted' as const })),
          ...e.alternatives.map((pass) => ({ pass, kind: 'alternative' as const })),
          ...e.conditional.map((pass) => ({ pass, kind: 'conditional' as const })),
        ]}
      />

      {caveats.length > 0 && (
        <ul className="caveats" aria-label="Things to know">
          {caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      )}

      <h4 className="group">Counted passes</h4>
      {e.counted.map((p) => <PassCard key={p.passId} pass={p} role="counted" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}

      {e.alternatives.length > 0 && (
        <details>
          <summary>{e.alternatives.length} overlapping alternative{e.alternatives.length === 1 ? '' : 's'}</summary>
          {e.alternatives.map((p) => <PassCard key={p.passId} pass={p} role="alternative" tz={tz} overlapNames={overlapNames(p.passId)} statusDownloadedAt={meta.statusDownloadedAt} />)}
        </details>
      )}
      {e.conditional.length > 0 && (
        <details>
          <summary>{e.conditional.length} conditional pass{e.conditional.length === 1 ? '' : 'es'} (status unconfirmed)</summary>
          {e.conditional.map((p) => <PassCard key={p.passId} pass={p} role="conditional" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}
        </details>
      )}
      {(e.edge.length > 0 || e.excluded.length > 0) && (
        <details>
          <summary>{e.edge.length + e.excluded.length} other pass{e.edge.length + e.excluded.length === 1 ? '' : 'es'} left out, and why</summary>
          {e.edge.map((p) => <PassCard key={p.passId} pass={p} role="edge" tz={tz} window={e.window} statusDownloadedAt={meta.statusDownloadedAt} />)}
          {e.excluded.map((p) => <PassCard key={p.passId} pass={p} role="excluded" tz={tz} statusDownloadedAt={meta.statusDownloadedAt} />)}
        </details>
      )}
    </section>
  );
}
