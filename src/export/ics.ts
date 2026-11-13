/**
 * Calendar (.ics) export of a SAVED event: a pure builder with no network access and no storage access.
 *
 * What it exports is the saved plan exactly as saved. It never recomputes a prediction and never "fills in" a missing detail
 * from current data. The calendar entry is a STATIC SNAPSHOT: nothing updates it, and the planner's latest re-check may
 * differ (the description says so).
 *
 * Calendar times: start = first saved AOS minus the setup buffer (rounded down to a whole second); end = last saved LOS plus
 * the post-pass buffer (rounded up to a whole second), and never shorter than the minimum length. All DTSTART/DTEND values
 * are written in UTC, so they are unambiguous without a time-zone definition. The description shows clock times in the
 * event's saved planning zone (with the zone name) and in UTC.
 *
 * Deliberately NOT included: observer coordinates, callsigns, alarms, attendees, a location. The VEVENT has a stable UID and
 * SEQUENCE 0; whether a calendar app replaces an earlier import with the same UID or creates a duplicate depends on the app
 * and is not promised here.
 */
import { ACTIVITIES, compactBands } from '../catalog/catalog.ts';
import type { FmActivity } from '../catalog/catalog.ts';
import { CALENDAR_MIN_EVENT_MIN, CALENDAR_POST_MIN, CALENDAR_SETUP_MIN, PLANNER_URL } from '../domain/policy.ts';
import type { Criteria, Interval, Ms } from '../domain/types.ts';
import type { SavedOpportunity } from '../saved/saved.ts';

/**
 * Details that NEWLY saved events will carry (a later stage adds them to SavedOpportunity). Older saved events lack them, and
 * they are never reconstructed from current predictions: the export says once that some details were not stored.
 */
export interface StoredPassExtras {
  riseAzDeg?: number;
  setAzDeg?: number;
  /** null = stored, and the pass never reached the threshold; undefined = not stored. */
  aboveThreshold?: Interval | null;
  /** Sunlight at the satellite over the whole pass. */
  sunlight?: 'illuminated' | 'partly-eclipsed' | 'eclipsed';
}
export type CalendarPass = SavedOpportunity & StoredPassExtras;

/** The part of a saved event the export needs (any SavedEvent fits). */
export interface CalendarSource {
  id: string;
  savedAtMs: Ms;
  window: Interval;
  timeZone: string;
  criteria: Pick<Criteria, 'minElevationDeg'>;
  original: { counted: readonly CalendarPass[] };
}

export interface CalendarTimes {
  /** Calendar start: the setup time begins here. */
  startMs: Ms;
  firstAosMs: Ms;
  lastLosMs: Ms;
  /** Calendar end. */
  endMs: Ms;
  /** True when the end had to be moved out to satisfy the minimum length. */
  extendedToMinimum: boolean;
}

export const ICS_MIME = 'text/calendar;charset=utf-8';
const MIN = 60_000;
const CRLF = '\r\n';

/** Thrown for saved data that cannot make a trustworthy calendar entry. Nothing is ever exported from such data. */
export class InvalidCalendarDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCalendarDataError';
  }
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Refuse broken pass data outright: no counted passes; a timestamp that is not a finite number; LOS at or before AOS; a peak
 * outside the pass (the peak may sit exactly on AOS or LOS); a non-finite elevation or operating time; and optional stored
 * details that are not finite or run backwards. The minimum-length rule below is a display preference for VALID passes and is
 * never used to make a broken pass look acceptable.
 */
export function validatePasses(passes: readonly CalendarPass[]): void {
  if (passes.length === 0) throw new InvalidCalendarDataError('A saved event with no counted passes cannot be exported.');
  passes.forEach((p, i) => {
    const who = `pass ${i + 1} (${String(p.name)})`;
    const bad = (why: string): never => {
      throw new InvalidCalendarDataError(`Cannot export: ${who} ${why}.`);
    };
    if (!isTime(p.riseMs)) bad('has an invalid AOS time');
    if (!isTime(p.setMs)) bad('has an invalid LOS time');
    if (!isTime(p.peakMs)) bad('has an invalid peak time');
    if (!(p.setMs > p.riseMs)) bad('has a LOS at or before its AOS');
    if (p.peakMs < p.riseMs || p.peakMs > p.setMs) bad('has a peak outside the pass');
    if (!isNumber(p.fullMaxElevationDeg)) bad('has an invalid maximum elevation');
    if (!isNumber(p.operatingMs) || p.operatingMs < 0) bad('has an invalid operating time');
    if (p.eligibleMaxElevationDeg !== null && !isNumber(p.eligibleMaxElevationDeg)) bad('has an invalid sunlit elevation');
    if (p.riseAzDeg !== undefined && !isNumber(p.riseAzDeg)) bad('has an invalid rise direction');
    if (p.setAzDeg !== undefined && !isNumber(p.setAzDeg)) bad('has an invalid set direction');
    if (p.aboveThreshold) {
      if (!isTime(p.aboveThreshold.start) || !isTime(p.aboveThreshold.end)) bad('has an invalid time-above-threshold interval');
      if (p.aboveThreshold.end < p.aboveThreshold.start) bad('has a time-above-threshold interval that runs backwards');
    }
  });
}

function validateContext(source: CalendarSource, exportedAtMs: Ms): void {
  if (!isTime(exportedAtMs)) throw new InvalidCalendarDataError('Cannot export: the export time is invalid.');
  if (!isTime(source.savedAtMs)) throw new InvalidCalendarDataError('Cannot export: the saved time is invalid.');
  if (!isNumber(source.criteria.minElevationDeg)) throw new InvalidCalendarDataError('Cannot export: the saved elevation threshold is invalid.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: source.timeZone });
  } catch {
    throw new InvalidCalendarDataError(`Cannot export: the saved time zone "${String(source.timeZone)}" is not valid.`);
  }
}

const inTimeOrder = (passes: readonly CalendarPass[]): CalendarPass[] => {
  validatePasses(passes);
  return [...passes].sort((a, b) => a.riseMs - b.riseMs || a.setMs - b.setMs || a.noradId - b.noradId);
};

/**
 * The display preference that a calendar entry is at least this long. A pure timing helper: it only ever moves an END later and
 * knows nothing about passes. With valid passes the buffers already exceed the minimum, so it changes nothing there.
 */
export function enforceMinimumLength(startMs: Ms, endMs: Ms, minMinutes: number = CALENDAR_MIN_EVENT_MIN): { endMs: Ms; extended: boolean } {
  const minimumEnd = startMs + minMinutes * MIN;
  return endMs < minimumEnd ? { endMs: minimumEnd, extended: true } : { endMs, extended: false };
}

/** Start, end and the key instants of the calendar entry, from the saved passes only (invalid passes are refused). */
export function calendarTimes(passes: readonly CalendarPass[]): CalendarTimes {
  validatePasses(passes);
  const firstAosMs = Math.min(...passes.map((p) => p.riseMs));
  const lastLosMs = Math.max(...passes.map((p) => p.setMs));
  const startMs = Math.floor((firstAosMs - CALENDAR_SETUP_MIN * MIN) / 1000) * 1000;
  const bufferedEnd = Math.ceil((lastLosMs + CALENDAR_POST_MIN * MIN) / 1000) * 1000;
  const { endMs, extended } = enforceMinimumLength(startMs, bufferedEnd);
  return { startMs, firstAosMs, lastLosMs, endMs, extendedToMinimum: extended };
}

/* ------------------------------------------------------------------ title */

const maxElevation = (p: CalendarPass) => Math.round(p.fullMaxElevationDeg);
const passMinutes = (p: CalendarPass) => Math.round((p.setMs - p.riseMs) / MIN);

/**
 * Single pass: "ISS 75° 11m" (full-pass maximum elevation, and AOS-to-LOS duration, each rounded to the nearest unit; no
 * buffers). Several passes: "3 passes: ISS 75°, SO-50 62°, SO-50 70°" in time order; with more than 4, the first 3 and "+N more".
 * The overall span is not in the title (it is in the description).
 */
export function calendarTitle(passes: readonly CalendarPass[]): string {
  const ordered = inTimeOrder(passes);
  if (ordered.length === 0) throw new Error('A saved event with no counted passes cannot be exported.');
  if (ordered.length === 1) {
    const p = ordered[0]!;
    return `${p.name} ${maxElevation(p)}° ${passMinutes(p)}m`;
  }
  const entry = (p: CalendarPass) => `${p.name} ${maxElevation(p)}°`;
  const shown = ordered.length > 4 ? [...ordered.slice(0, 3).map(entry), `+${ordered.length - 3} more`] : ordered.map(entry);
  return `${ordered.length} passes: ${shown.join(', ')}`;
}

/* ------------------------------------------------------------------ description */

// Intl uses a narrow no-break space before AM/PM in current ICU data; keep the text plain.
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const zoned = (ms: Ms, tz: string, opts: Intl.DateTimeFormatOptions) => plain(new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms));
const FULL: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' };
const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
const utcFull = (ms: Ms) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const utcClock = (ms: Ms) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const full = (ms: Ms, tz: string) => `${zoned(ms, tz, FULL)} (${utcFull(ms)})`;

/** "10 min 46 s"; "2 h 01 min 12 s" from an hour up. */
export function exactDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h} h ${two(m)} min ${two(s)} s` : `${m} min ${two(s)} s`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const direction = (az: number) => `${COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]} (${Math.round(az)}°)`;
const activityOf = (noradId: number): FmActivity | undefined => ACTIVITIES.find((a) => a.noradId === noradId);
const sourceNote = (r: { source: { label: string }; asOf: string }) => `(Source: ${r.source.label}; text as of ${r.asOf}; manual catalog note, not live)`;

const STATE_TEXT: Record<string, string> = {
  'recently-reported-active': 'a recent "Heard" report for its FM repeater (not a live status check)',
};

function passBlock(p: CalendarPass, index: number, total: number, tz: string, thresholdDeg: number, setupDay: string): string[] {
  const act = activityOf(p.noradId);
  const day = (ms: Ms) => (zoned(ms, tz, DAY) === setupDay ? '' : `${zoned(ms, tz, DAY)}, `);
  const at = (ms: Ms) => `${day(ms)}${zoned(ms, tz, CLOCK)} (${utcClock(ms)})`;
  const lines = [`PASS ${index + 1} of ${total}: ${p.name}${act ? ` (${compactBands(act)})` : ''}`];

  if (act?.sunlightRequired) {
    const same = p.eligibleMaxElevationDeg !== null && Math.abs(p.eligibleMaxElevationDeg - p.fullMaxElevationDeg) < 0.5;
    lines.push('  SUNLIGHT-ONLY REPEATER: usable only while the satellite itself is in sunlight (not local daylight).');
    lines.push(
      `  Maximum elevation while sunlit: ${p.eligibleMaxElevationDeg === null ? 'none' : `${Math.round(p.eligibleMaxElevationDeg)}°`}` +
        `${same ? ' (same as the pass peak)' : ` (the full pass peaks at ${Math.round(p.fullMaxElevationDeg)}°)`}. ` +
        `Sunlit operating time: ${exactDuration(p.operatingMs)} of ${exactDuration(p.setMs - p.riseMs)}.` +
        `${p.sunlight === 'partly-eclipsed' ? ' Part of the pass is in Earth’s shadow.' : ''}`,
    );
    for (const r of act.restrictions.filter((x) => x.kind === 'sunlight-only')) lines.push(`  ${r.text} ${sourceNote(r)}`);
  }

  lines.push(`  Start (AOS): ${at(p.riseMs)}`);
  lines.push(`  End (LOS): ${at(p.setMs)}`);
  lines.push(`  Duration: ${exactDuration(p.setMs - p.riseMs)}`);
  lines.push(`  Peak: ${at(p.peakMs)}, maximum elevation ${Math.round(p.fullMaxElevationDeg)}°`);
  if (p.aboveThreshold !== undefined) {
    lines.push(
      p.aboveThreshold === null
        ? `  Time above ${thresholdDeg}°: none`
        : `  Time above ${thresholdDeg}°: ${at(p.aboveThreshold.start)} to ${at(p.aboveThreshold.end)} (${exactDuration(p.aboveThreshold.end - p.aboveThreshold.start)})`,
    );
  }
  if (p.riseAzDeg !== undefined && p.setAzDeg !== undefined) lines.push(`  Rises ${direction(p.riseAzDeg)}, sets ${direction(p.setAzDeg)}`);

  if (act) {
    const tone = act.uplink.ctcssHz ? `${act.uplink.ctcssHz} Hz tone` : 'no tone listed in the catalog';
    lines.push(`  Radio: transmit ${act.uplink.mhz.toFixed(3)} MHz (${tone}), listen ${act.downlink.mhz.toFixed(3)} MHz`);
  } else {
    lines.push('  Radio: no catalog entry for this satellite.');
  }

  const warnings: string[] = [];
  if (act) {
    for (const r of act.restrictions) {
      if (r.kind === 'interruptible') warnings.push(`${r.badge ?? 'Subject to interruptions'}: ${r.text} ${sourceNote(r)}`);
      else if (r.kind === 'note') warnings.push(`${r.text} ${sourceNote(r)}`);
    }
  }
  warnings.push(`Eligibility when saved: ${STATE_TEXT[p.statusState] ?? p.statusState}.`);
  lines.push('  Warnings:', ...warnings.map((w) => `  - ${w}`));
  return lines;
}

/** The plain-text description: setup, snapshot and per-pass details. */
export function calendarDescription(source: CalendarSource, exportedAtMs: Ms): string {
  validateContext(source, exportedAtMs);
  const tz = source.timeZone;
  const passes = inTimeOrder(source.original.counted);
  const t = calendarTimes(passes);
  const setupDay = zoned(t.startMs, tz, DAY);
  const out: string[] = [];

  out.push(
    `STATIC SNAPSHOT: this calendar entry was exported from a plan saved on ${zoned(source.savedAtMs, tz, DAY)}. It does not update automatically, ` +
      'and the planner’s latest re-check may differ (predicted pass times shift as orbital data is refreshed). ' +
      `Re-check in the planner before the event: ${PLANNER_URL}`,
  );
  if (exportedAtMs > t.lastLosMs) out.push(`PAST EVENT: the last pass of this saved plan ended ${full(t.lastLosMs, tz)}, before this file was exported.`);

  out.push('', 'CALENDAR TIMES');
  out.push(`Setup starts (calendar start): ${full(t.startMs, tz)}`);
  out.push(`First pass starts (first AOS): ${full(t.firstAosMs, tz)}`);
  out.push(`Last pass ends (last LOS): ${full(t.lastLosMs, tz)}`);
  out.push(`Calendar entry ends: ${full(t.endMs, tz)}`);
  if (passes.length > 1) out.push(`Span from first AOS to last LOS: ${exactDuration(t.lastLosMs - t.firstAosMs)}`);
  out.push(
    `The first ${Math.round((t.firstAosMs - t.startMs) / MIN)} minutes of this entry are SETUP TIME, not satellite time. ` +
      `The entry runs ${CALENDAR_POST_MIN} minutes past the last pass${t.extendedToMinimum ? `, extended so the entry is at least ${CALENDAR_MIN_EVENT_MIN} minutes long` : ''}.`,
  );

  passes.forEach((p, i) => out.push('', ...passBlock(p, i, passes.length, tz, source.criteria.minElevationDeg, setupDay)));

  const missing = passes.some((p) => p.riseAzDeg === undefined || p.setAzDeg === undefined || p.aboveThreshold === undefined);
  if (missing) out.push('', 'Some details (rise and set directions, time above the elevation threshold) were not stored with this older saved event, so they are not included.');
  out.push('', 'Planning estimate only. Re-check the pass times and repeater status before the event.', `Planner: ${PLANNER_URL}`);
  return out.join('\n');
}

/* ------------------------------------------------------------------ .ics */

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and line breaks. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line to at most 75 octets per physical line (continuations start with one space), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > 75) {
      parts.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(CRLF);
}

const icsTime = (ms: Ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const safe = (s: string) => s.replace(/°/g, 'deg').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export function calendarUid(id: string): string {
  return `${safe(id) || 'event'}@k1kfx.com`;
}

export interface CalendarExport {
  filename: string;
  mimeType: typeof ICS_MIME;
  content: string;
  title: string;
  startMs: Ms;
  endMs: Ms;
}

/**
 * Labels for SAMPLE files only (a test file a person imports into a throwaway calendar). The app never passes these: a real
 * export has neither.
 */
export interface CalendarExportOptions {
  /** Put in front of the title, e.g. "SAMPLE — ". */
  titlePrefix?: string;
  /** Put as the first lines of the description. */
  descriptionPrefix?: string;
}

/** Build the .ics text (CRLF line endings, folded lines) for a saved event, exactly as saved. Throws InvalidCalendarDataError for broken data. */
export function buildCalendarExport(source: CalendarSource, exportedAtMs: Ms, options: CalendarExportOptions = {}): CalendarExport {
  validateContext(source, exportedAtMs);
  const passes = inTimeOrder(source.original.counted);
  const t = calendarTimes(passes);
  const plainTitle = calendarTitle(passes);
  const title = `${options.titlePrefix ?? ''}${plainTitle}`;
  const description = `${options.descriptionPrefix ? `${options.descriptionPrefix}\n\n` : ''}${calendarDescription(source, exportedAtMs)}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//K1KFX//Satellite Pass Planner//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${calendarUid(source.id)}`,
    `DTSTAMP:${icsTime(Math.floor(exportedAtMs / 1000) * 1000)}`,
    'SEQUENCE:0',
    `DTSTART:${icsTime(t.startMs)}`,
    `DTEND:${icsTime(t.endMs)}`,
    `SUMMARY:${escapeText(title)}`,
    `DESCRIPTION:${escapeText(description)}`,
    `URL:${PLANNER_URL}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: source.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(t.firstAosMs)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const filename = `${safe(passes.length === 1 ? plainTitle : `${passes.length}-passes`)}-${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}.ics`;
  return { filename, mimeType: ICS_MIME, content: lines.map(foldLine).join(CRLF) + CRLF, title, startMs: t.startMs, endMs: t.endMs };
}
