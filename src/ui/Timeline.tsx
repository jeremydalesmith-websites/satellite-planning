import type { Interval } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import { fmtTime } from './format.ts';

export interface TimelineItem {
  pass: PassAssessment;
  kind: 'counted' | 'alternative' | 'conditional';
}

interface Props {
  window: Interval;
  items: TimelineItem[];
  tz: string;
}

/** Compact visual timeline. Decorative: the pass cards below carry the same information as text. */
export function Timeline({ window, items, tz }: Props) {
  const span = window.end - window.start;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - window.start) / span) * 100))}%`;
  const hours: number[] = [];
  const firstHour = Math.ceil(window.start / 1_800_000) * 1_800_000;
  for (let t = firstHour; t < window.end; t += 1_800_000) hours.push(t);
  const sorted = [...items].filter((i) => i.pass.operating).sort((a, b) => a.pass.operating!.start - b.pass.operating!.start);

  return (
    <div className="timeline" aria-hidden="true">
      <div className="tl-axis">
        {hours.map((t) => (
          <span key={t} className="tick" style={{ left: pct(t) }}>
            <i />
            {fmtTime(t, tz)}
          </span>
        ))}
      </div>
      {sorted.map((it) => {
        const o = it.pass.operating!;
        const mid = (o.start + o.end) / 2;
        const late = (mid - window.start) / span > 0.6;
        return (
          <div className="tl-lane" key={it.pass.passId}>
            <span className="tl-pass" style={{ left: pct(Math.max(it.pass.riseMs, window.start)), width: `calc(${pct(Math.min(it.pass.setMs, window.end))} - ${pct(Math.max(it.pass.riseMs, window.start))})` }} />
            <span className={`tl-op ${it.kind}`} style={{ left: pct(o.start), width: `max(6px, calc(${pct(o.end)} - ${pct(o.start)}))` }} />
            <span className={`tl-label ${late ? 'before' : 'after'}`} style={late ? { right: `calc(100% - ${pct(o.start)} + 4px)` } : { left: `calc(${pct(o.end)} + 4px)` }}>
              {it.pass.name} {it.pass.fullMaxElevationDeg.toFixed(0)}°
            </span>
          </div>
        );
      })}
      <div className="tl-legend">
        <span><i className="sw counted" /> counted</span>
        <span><i className="sw alternative" /> overlaps</span>
        <span><i className="sw conditional" /> conditional</span>
        <span><i className="sw line" /> whole pass</span>
      </div>
    </div>
  );
}
