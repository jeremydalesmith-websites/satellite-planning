import type { Ms } from '../domain/types.ts';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    cache.set(key, f);
  }
  return f;
}

export const fmtTime = (ms: Ms, tz: string) => fmt(tz, { hour: 'numeric', minute: '2-digit' }).format(ms);
export const fmtTimeSec = (ms: Ms, tz: string) => fmt(tz, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(ms);
export const fmtDay = (ms: Ms, tz: string) => fmt(tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(ms);
export const fmtDayShort = (ms: Ms, tz: string) => fmt(tz, { weekday: 'short', month: 'short', day: 'numeric' }).format(ms);
export const fmtDateTime = (ms: Ms, tz: string) => fmt(tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
export const tzAbbrev = (ms: Ms, tz: string) =>
  fmt(tz, { timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? tz;

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (az: number) => COMPASS[Math.round(az / 22.5) % 16] ?? '';

export function ago(ms: Ms, nowMs: Ms): string {
  const d = nowMs - ms;
  if (d < 0) return 'just now';
  const h = d / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(d / 60_000))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Displayed bounds are rounded OUTWARD to whole seconds (start down, end up) so a header or card can never appear to
 * exclude part of a pass. Durations shown next to them are computed from these same displayed bounds.
 */
export const floorSec = (ms: Ms): Ms => Math.floor(ms / 1000) * 1000;
export const ceilSec = (ms: Ms): Ms => Math.ceil(ms / 1000) * 1000;
export const fmtStartSec = (ms: Ms, tz: string) => fmtTimeSec(floorSec(ms), tz);
export const fmtEndSec = (ms: Ms, tz: string) => fmtTimeSec(ceilSec(ms), tz);
/** Elapsed time between two instants, as displayed (outward-rounded), e.g. "1 h 30 min 27 s", "10 min 49 s", "45 s". */
export function fmtSpan(startMs: Ms, endMs: Ms): string {
  const total = Math.round((ceilSec(endMs) - floorSec(startMs)) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} h` : '', h || m ? `${m} min` : '', `${h || m ? String(s).padStart(2, '0') : s} s`].filter(Boolean).join(' ');
}
