import type { Interval } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';
import { fmtTime } from './format.ts';

export interface TimelineItem {
  pass: PassAssessment;
  kind: 'counted' | 'alternative';
}

interface Props {
  /** The actual cluster (or fixed saved) interval. The axis is scaled to it with modest padding. */
  window: Interval;
  items: TimelineItem[];
  tz: string;
}

/** Pick a tick step that gives at most about six ticks across the cluster. */
function tickStepMs(spanMs: number): number {
  for (const min of [5, 10, 15, 30, 60, 120]) if (spanMs / (min * 60_000) <= 6) return min * 60_000;
  return 180 * 60_000;
}

/**
 * Compact visual timeline. Decorative: the pass cards below carry the same information as text.
 * The axis is the cluster interval plus a small VISUAL pad; the pad never changes a displayed or saved boundary.
 * Each lane shows the FULL pass (AOS to LOS). Where operation is permitted the bar is solid; portions where it is
 * prohibited (Earth's shadow, for sunlight-dependent repeaters) are hatched, so the full pass is never implied to be
 * available for transmission.
 */
export function Timeline({ window, items, tz }: Props) {
  const span = Math.max(1, window.end - window.start);
  const pad = Math.max(span * 0.04, 60_000);
  const lo = window.start - pad;
  const hi = window.end + pad;
  const total = hi - lo;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - lo) / total) * 100))}%`;
  const wpct = (a: number, b: number) => `calc(${pct(b)} - ${pct(a)})`;
  const step = tickStepMs(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  const sorted = [...items].sort((a, b) => a.pass.riseMs - b.pass.riseMs);

  return (
    <div className="timeline" aria-hidden="true">
      <div className="tl-axis">
        {ticks.map((t) => (
          <span key={t} className="tick" style={{ left: pct(t) }}>
            <i />
            {fmtTime(t, tz)}
          </span>
        ))}
      </div>
      {sorted.map((it) => {
        const p = it.pass;
        const mid = (p.riseMs + p.setMs) / 2;
        const late = (mid - lo) / total > 0.62;
        return (
          <div className="tl-lane" key={p.passId}>
            <span className={`tl-full ${p.sunlightRestricted ? 'restricted' : 'open'}`} style={{ left: pct(p.riseMs), width: wpct(p.riseMs, p.setMs) }} />
            {p.operatingIntervals.map((o, i) => (
              <span key={i} className={`tl-op ${it.kind}`} style={{ left: pct(o.start), width: `max(4px, ${wpct(o.start, o.end)})` }} />
            ))}
            <span className={`tl-label ${late ? 'before' : 'after'}`} style={late ? { right: `calc(100% - ${pct(p.riseMs)} + 4px)` } : { left: `calc(${pct(p.setMs)} + 4px)` }}>
              {p.name} {p.fullMaxElevationDeg.toFixed(0)}°
            </span>
          </div>
        );
      })}
      <div className="tl-legend">
        {sorted.some((i) => !i.pass.sunlightRestricted) && <span><i className="sw counted" /> Full pass</span>}
        {sorted.some((i) => i.pass.sunlightRestricted) && <span><i className="sw counted" /> Sunlit operating interval</span>}
        {sorted.some((i) => i.pass.sunlightRestricted && i.pass.shadowMs > 0) && <span><i className="sw shadow" /> Not permitted (Earth’s shadow)</span>}
      </div>
    </div>
  );
}
