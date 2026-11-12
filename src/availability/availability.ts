/**
 * Weekly availability -> normalized absolute intervals.
 *
 * The UI collects a simple Sunday–Saturday × {Morning, Midday, Evening} grid, but
 * everything downstream (the cluster finder) only ever sees a list of absolute
 * UTC Intervals. Date-specific blocks, recurrence rules or family calendars can
 * later be added by producing more intervals, with no change to the cluster code.
 *
 * Time zones: period boundaries are LOCAL WALL-CLOCK times in the selected IANA
 * zone, converted to absolute instants with Luxon per calendar day. That keeps
 * "noon–5 p.m." meaning noon–5 p.m. across daylight-saving changes (the interval
 * is 4 h or 6 h long on a transition day if the transition falls inside it).
 * Nonexistent wall times (spring-forward gap) move forward to the first valid
 * instant; ambiguous ones (fall-back) take the earlier instant (Luxon default).
 */
import { DateTime } from 'luxon';
import { MAX_SEARCH_DAYS } from '../domain/policy.ts';
import { clipList, normalizeIntervals } from '../domain/intervals.ts';
import type { Interval, Ms } from '../domain/types.ts';

export const PERIOD_IDS = ['morning', 'midday', 'evening'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];
export const PERIOD_LABELS: Record<PeriodId, string> = { morning: 'Morning', midday: 'Midday', evening: 'Evening' };
export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Minutes after local midnight; 1440 means the following midnight. */
export interface PeriodDef {
  startMin: number;
  endMin: number;
}

export interface AvailabilitySettings {
  periods: Record<PeriodId, PeriodDef>;
  /** selected[period][weekday], Sunday = 0 … Saturday = 6. */
  selected: Record<PeriodId, boolean[]>;
}

export const DEFAULT_PERIODS: Record<PeriodId, PeriodDef> = {
  morning: { startMin: 7 * 60, endMin: 12 * 60 },
  midday: { startMin: 12 * 60, endMin: 17 * 60 },
  evening: { startMin: 17 * 60, endMin: 22 * 60 },
};

/** Nothing is selected by default: the user must choose their availability explicitly. */
export function emptyAvailability(): AvailabilitySettings {
  return {
    periods: structuredClone(DEFAULT_PERIODS),
    selected: { morning: Array(7).fill(false), midday: Array(7).fill(false), evening: Array(7).fill(false) },
  };
}

export function hasAnySelection(s: AvailabilitySettings): boolean {
  return PERIOD_IDS.some((p) => s.selected[p].some(Boolean));
}

export function validateAvailability(s: AvailabilitySettings): string[] {
  const errors: string[] = [];
  for (const p of PERIOD_IDS) {
    const { startMin, endMin } = s.periods[p];
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || startMin < 0 || endMin > 1440) {
      errors.push(`${PERIOD_LABELS[p]}: times must be within one day.`);
    } else if (endMin <= startMin) {
      errors.push(`${PERIOD_LABELS[p]}: the end time must be after the start time.`);
    }
  }
  return errors;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  return DateTime.now().setZone(tz).isValid;
}

function wallTime(day: DateTime, minutes: number, zone: string): DateTime {
  if (minutes >= 1440) return day.plus({ days: 1 }).startOf('day');
  return DateTime.fromObject(
    { year: day.year, month: day.month, day: day.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    { zone },
  );
}

/**
 * Expand weekly settings into merged absolute intervals within `range`.
 * Adjacent or overlapping selected periods are merged (e.g. Midday + Evening
 * with the default boundaries becomes one 12:00–22:00 block).
 */
export function expandAvailability(s: AvailabilitySettings, timeZone: string, range: Interval): Interval[] {
  const first = DateTime.fromMillis(range.start, { zone: timeZone }).startOf('day').minus({ days: 1 });
  const out: Interval[] = [];
  for (let day = first; day.toMillis() <= range.end; day = day.plus({ days: 1 }).startOf('day')) {
    const weekday = day.weekday % 7; // luxon: Mon=1..Sun=7 -> Sun=0
    for (const p of PERIOD_IDS) {
      if (!s.selected[p][weekday]) continue;
      const def = s.periods[p];
      if (def.endMin <= def.startMin) continue;
      out.push({
        start: wallTime(day, def.startMin, timeZone).toMillis(),
        end: wallTime(day, def.endMin, timeZone).toMillis(),
      });
    }
  }
  return clipList(normalizeIntervals(out), range);
}

export interface RangeResult {
  range: Interval | null;
  errors: string[];
}

/**
 * Turn two local calendar dates (YYYY-MM-DD, inclusive) into an absolute range.
 * Starts no earlier than `nowMs` (past times cannot host a future event).
 */
export function rangeFromDates(startDate: string, endDate: string, timeZone: string, nowMs: Ms): RangeResult {
  const errors: string[] = [];
  const a = DateTime.fromISO(startDate, { zone: timeZone });
  const b = DateTime.fromISO(endDate, { zone: timeZone });
  if (!a.isValid) errors.push('Enter a valid start date.');
  if (!b.isValid) errors.push('Enter a valid end date.');
  if (errors.length) return { range: null, errors };
  if (b < a) errors.push('The end date must not be before the start date.');
  const days = Math.round(b.startOf('day').diff(a.startOf('day'), 'days').days) + 1;
  if (days > MAX_SEARCH_DAYS) errors.push(`Search at most ${MAX_SEARCH_DAYS} days at a time (you chose ${days}).`);
  if (errors.length) return { range: null, errors };
  const end = b.plus({ days: 1 }).startOf('day').toMillis();
  const start = Math.max(a.startOf('day').toMillis(), nowMs);
  if (end <= start) return { range: null, errors: ['That date range is entirely in the past.'] };
  return { range: { start, end }, errors };
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDate(ms: Ms, timeZone: string): string {
  return DateTime.fromMillis(ms, { zone: timeZone }).toISODate() ?? '';
}

export function addDays(date: string, n: number, timeZone: string): string {
  return DateTime.fromISO(date, { zone: timeZone }).plus({ days: n }).toISODate() ?? date;
}

/** Merged local-time ranges (minutes after midnight) selected for one weekday, for display. */
export function mergedDayRanges(s: AvailabilitySettings, weekday: number): Array<[number, number]> {
  const raw = PERIOD_IDS.filter((p) => s.selected[p][weekday]).map((p) => ({
    start: s.periods[p].startMin,
    end: s.periods[p].endMin,
  }));
  return normalizeIntervals(raw.filter((r) => r.end > r.start)).map((i) => [i.start, i.end]);
}

export function formatMinutes(min: number): string {
  if (min >= 1440) return '12:00 AM (next day)';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "07:30" <-> minutes, for <input type="time">. */
export function minutesToInput(min: number): string {
  const m = Math.min(1439, Math.max(0, min));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function inputToMinutes(v: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
