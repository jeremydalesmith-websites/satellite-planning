import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  emptyAvailability, expandAvailability, hasAnySelection, mergedDayRanges, rangeFromDates, validateAvailability,
} from '../src/availability/availability.ts';
import type { AvailabilitySettings } from '../src/availability/availability.ts';

const NY = 'America/New_York';
const HOUR = 3_600_000;
const wide = (tz: string, from: string, to: string) => ({
  start: DateTime.fromISO(from, { zone: tz }).toMillis(),
  end: DateTime.fromISO(to, { zone: tz }).toMillis(),
});
const sel = (s: AvailabilitySettings, period: 'morning' | 'midday' | 'evening', days: number[]) => {
  days.forEach((d) => (s.selected[period][d] = true));
  return s;
};
const local = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc HH:mm');

describe('explicit selection', () => {
  it('starts with nothing selected and refuses to treat that as "all hours"', () => {
    const s = emptyAvailability();
    expect(hasAnySelection(s)).toBe(false);
    expect(expandAvailability(s, NY, wide(NY, '2027-01-01', '2027-02-01'))).toEqual([]);
  });
  it('rejects an end time that is not after the start', () => {
    const s = emptyAvailability();
    s.periods.morning = { startMin: 600, endMin: 600 };
    expect(validateAvailability(s)).toHaveLength(1);
  });
});

describe('adjacent / overlapping periods merge', () => {
  it('Midday + Evening on Saturday become one 12:00–22:00 block', () => {
    const s = emptyAvailability();
    sel(s, 'midday', [6]); sel(s, 'evening', [6]);
    const out = expandAvailability(s, NY, wide(NY, '2027-01-03', '2027-01-10')); // Sun..Sun
    expect(out).toHaveLength(1);
    expect(local(out[0]!.start, NY)).toBe('Sat 12:00');
    expect(local(out[0]!.end, NY)).toBe('Sat 22:00');
    expect(mergedDayRanges(s, 6)).toEqual([[720, 1320]]);
  });
  it('non-adjacent periods (Morning + Evening) stay separate', () => {
    const s = emptyAvailability();
    sel(s, 'morning', [6]); sel(s, 'evening', [6]);
    expect(expandAvailability(s, NY, wide(NY, '2027-01-03', '2027-01-10'))).toHaveLength(2);
  });
  it('custom overlapping boundaries merge instead of double counting', () => {
    const s = emptyAvailability();
    s.periods.morning = { startMin: 8 * 60, endMin: 13 * 60 };
    s.periods.midday = { startMin: 12 * 60, endMin: 15 * 60 };
    sel(s, 'morning', [0]); sel(s, 'midday', [0]);
    expect(mergedDayRanges(s, 0)).toEqual([[480, 900]]);
  });
  it('unchecked periods are unavailable', () => {
    const s = emptyAvailability();
    sel(s, 'evening', [2]);
    const out = expandAvailability(s, NY, wide(NY, '2027-01-03', '2027-01-10'));
    expect(out).toHaveLength(1);
    expect(local(out[0]!.start, NY)).toBe('Tue 17:00');
  });
});

describe('time zones and daylight-saving transitions', () => {
  it('keeps wall-clock noon–5 pm across spring-forward (US 2027-03-14): same local hours, different UTC offset', () => {
    const s = emptyAvailability();
    sel(s, 'midday', [0]); // Sundays
    const out = expandAvailability(s, NY, wide(NY, '2027-03-07', '2027-03-22'));
    const starts = out.map((i) => local(i.start, NY));
    expect(starts).toEqual(['Sun 12:00', 'Sun 12:00', 'Sun 12:00']);
    // Mar 7 is EST (UTC-5) -> 17:00Z; Mar 14 and 21 are EDT (UTC-4) -> 16:00Z
    expect(new Date(out[0]!.start).getUTCHours()).toBe(17);
    expect(new Date(out[1]!.start).getUTCHours()).toBe(16);
    out.forEach((i) => expect(i.end - i.start).toBe(5 * HOUR));
  });
  it('a period spanning the 2 am spring-forward gap is 1 hour shorter in elapsed time', () => {
    const s = emptyAvailability();
    s.periods.morning = { startMin: 0, endMin: 7 * 60 };
    sel(s, 'morning', [0]);
    const out = expandAvailability(s, NY, wide(NY, '2027-03-14', '2027-03-15'));
    expect(out).toHaveLength(1);
    expect((out[0]!.end - out[0]!.start) / HOUR).toBe(6); // 00:00–07:00 local, but 02:00–03:00 does not exist
  });
  it('a period spanning the fall-back repeat (US 2027-11-07) is 1 hour longer in elapsed time', () => {
    const s = emptyAvailability();
    s.periods.morning = { startMin: 0, endMin: 7 * 60 };
    sel(s, 'morning', [0]);
    const out = expandAvailability(s, NY, wide(NY, '2027-11-07', '2027-11-08'));
    expect((out[0]!.end - out[0]!.start) / HOUR).toBe(8);
  });
  it('the same settings give different absolute instants in different zones', () => {
    const s = emptyAvailability();
    sel(s, 'evening', [6]);
    const ny = expandAvailability(s, NY, { start: Date.UTC(2027, 0, 8), end: Date.UTC(2027, 0, 12) });
    const la = expandAvailability(s, 'America/Los_Angeles', { start: Date.UTC(2027, 0, 8), end: Date.UTC(2027, 0, 12) });
    expect(la[0]!.start - ny[0]!.start).toBe(3 * HOUR);
  });
  it('a southern-hemisphere zone with the opposite DST season is handled', () => {
    const s = emptyAvailability();
    sel(s, 'evening', [6]);
    const out = expandAvailability(s, 'Australia/Sydney', wide('Australia/Sydney', '2027-04-01', '2027-04-12'));
    out.forEach((i) => expect(local(i.start, 'Australia/Sydney')).toBe('Sat 17:00'));
  });
});

describe('date range', () => {
  it('allows exactly 42 days but not 43', () => {
    const now = Date.UTC(2027, 0, 1, 12);
    expect(rangeFromDates('2027-01-01', '2027-02-11', NY, now).errors).toEqual([]); // 42 days inclusive
    expect(rangeFromDates('2027-01-01', '2027-02-12', NY, now).errors[0]).toMatch(/at most 42/);
  });
  it('rejects reversed and past-only ranges, and never starts before now', () => {
    const now = Date.UTC(2027, 0, 10, 15);
    expect(rangeFromDates('2027-01-12', '2027-01-10', NY, now).errors[0]).toMatch(/not be before/);
    expect(rangeFromDates('2027-01-01', '2027-01-05', NY, now).errors[0]).toMatch(/past/);
    expect(rangeFromDates('2027-01-10', '2027-01-12', NY, now).range!.start).toBe(now);
  });
  it('the end date is inclusive through local midnight (DST-safe 23/25-hour days)', () => {
    const r = rangeFromDates('2027-03-14', '2027-03-14', NY, 0).range!;
    expect((r.end - r.start) / HOUR).toBe(23);
  });
});
