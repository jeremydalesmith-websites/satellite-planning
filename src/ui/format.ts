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
 * Displayed CLOCK TIMES are rounded OUTWARD to whole seconds (start down, end up) so a header or card can never appear to
 * exclude part of a pass. That is a display matter only: durations are computed from the EXACT timestamps (below), so a
 * cluster that satisfies the maximum span can never be displayed as longer than it, and scheduling constraints always use
 * exact times.
 */
export const floorSec = (ms: Ms): Ms => Math.floor(ms / 1000) * 1000;
export const ceilSec = (ms: Ms): Ms => Math.ceil(ms / 1000) * 1000;
export const fmtStartSec = (ms: Ms, tz: string) => fmtTimeSec(floorSec(ms), tz);
export const fmtEndSec = (ms: Ms, tz: string) => fmtTimeSec(ceilSec(ms), tz);
/** Exact elapsed time between two instants, rounded to the nearest second, e.g. "1 h 30 min 27 s", "10 min 49 s", "45 s". */
export function fmtSpan(startMs: Ms, endMs: Ms): string {
  const total = Math.round((endMs - startMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} h` : '', h || m ? `${h ? String(m).padStart(2, '0') : m} min` : '', `${h || m ? String(s).padStart(2, '0') : s} s`].filter(Boolean).join(' ');
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function fmtAgo(ms: Ms, nowMs: Ms): string {
  const d = Math.max(0, nowMs - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const days = Math.floor(h / 24);
  return `${days} days ago`;
}

/**
 * EVENT HEADERS show minutes only. The clock times round OUTWARD to the minute (start down, end up) so the header never
 * appears to exclude part of a counted pass; the elapsed duration is the EXACT span rounded to the nearest minute. Because
 * the selected maximum span is a whole number of minutes and the exact span never exceeds it, the displayed duration can
 * never be larger than the maximum. Individual pass details keep seconds (see fmtStartSec / fmtEndSec / fmtSpan).
 */
export const floorMin = (ms: Ms): Ms => Math.floor(ms / 60_000) * 60_000;
export const ceilMin = (ms: Ms): Ms => Math.ceil(ms / 60_000) * 60_000;
export const fmtStartMin = (ms: Ms, tz: string) => fmtTime(floorMin(ms), tz);
export const fmtEndMin = (ms: Ms, tz: string) => fmtTime(ceilMin(ms), tz);
/** Exact elapsed time rounded to the nearest minute: "1 h 31 min", "45 min", "2 h 00 min". */
export function fmtSpanMin(startMs: Ms, endMs: Ms): string {
  const total = Math.round((endMs - startMs) / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
