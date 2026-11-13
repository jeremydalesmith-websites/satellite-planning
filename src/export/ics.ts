/**
 * Calendar (.ics) export of a SAVED event: a pure builder with no network access and no storage access.
 *
 * What it exports is the saved plan exactly as saved. It never recomputes a prediction and never "fills in" a missing detail
 * from current data. The calendar entry is a STATIC SNAPSHOT: nothing updates it, and the description's last sentence says it
 * is a static copy to re-check in the planner.
 *
 * Calendar times: start = first saved AOS minus the setup buffer (rounded down to a whole second); end = last saved LOS plus
 * the post-pass buffer (rounded up to a whole second), and never shorter than the minimum length. All DTSTART/DTEND values
 * are written in UTC, so they are unambiguous without a time-zone definition. The description is deliberately COMPACT: the
 * date and the event's saved planning zone are stated once ("All times CST") and times carry no zone or UTC after that; there
 * is one short block per pass, one buffer sentence, brief warnings once, and the static-copy sentence with the planner link.
 * Longer explanations belong in the planner, not in the calendar entry.
 *
 * Deliberately NOT included: observer coordinates, callsigns, alarms, attendees, a location. The VEVENT has a stable UID and
 * SEQUENCE 0. OBSERVED, in one Google Calendar test by the owner: importing the identical file a second time did not create a
 * duplicate. That is ONE observation about identical files in ONE calendar: it is not evidence that Google (or any other
 * calendar) replaces an entry whose content changed, or that other calendars behave the same, and nothing here promises it.
 */
import { ACTIVITIES } from '../catalog/catalog.ts';
import type { FmActivity } from '../catalog/catalog.ts';
import { CALENDAR_MIN_EVENT_MIN, CALENDAR_POST_MIN, CALENDAR_SETUP_MIN, PLANNER_URL } from '../domain/policy.ts';
import type { Criteria, Interval, Ms } from '../domain/types.ts';
import type { SavedOpportunity, SavedPassDetails } from '../saved/saved.ts';

/** The optional details newly saved events carry (see SavedPassDetails). Older events lack them; they are never reconstructed. */
export type StoredPassExtras = SavedPassDetails;
export type CalendarPass = SavedOpportunity & StoredPassExtras;

/** The part of a saved event the export needs (any SavedEvent fits). */
export interface CalendarSource {
  id: string;
  savedAtMs: Ms;
  window: Interval;
  timeZone: string;
  criteria: Pick<Criteria, 'minElevationDeg'>;
  original: { counted: readonly CalendarPass[] };
  /**
   * Short warnings supplied by the caller (for example, from the planner's latest re-check: "ISS no longer has a recent report"). They
   * are printed first, each with a warning sign. The builder never works them out itself: it only exports the saved plan.
   */
  alerts?: readonly string[];
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
  if (source.alerts !== undefined && (!Array.isArray(source.alerts) || source.alerts.some((a) => typeof a !== 'string'))) throw new InvalidCalendarDataError('Cannot export: the alerts must be a list of text.');
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
const plain = (s: string) => s.replace(/[  ]/g, ' ');
const fmtParts = (ms: Ms, tz: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(ms);
const zoned = (ms: Ms, tz: string, opts: Intl.DateTimeFormatOptions) => plain(new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms));
const LONG_DAY: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
const SHORT_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const zoneName = (ms: Ms, tz: string) => fmtParts(ms, tz, { timeZoneName: 'short' }).find((p) => p.type === 'timeZoneName')?.value ?? tz;
const dayPeriod = (ms: Ms, tz: string) => fmtParts(ms, tz, { hour: 'numeric', hour12: true }).find((p) => p.type === 'dayPeriod')?.value ?? '';

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
const compass = (az: number) => COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]!;
const activityOf = (noradId: number): FmActivity | undefined => ACTIVITIES.find((a) => a.noradId === noradId);

/**
 * How times are written. The event's saved zone is stated ONCE ("All times CST") and times carry no zone or UTC after that. If the
 * clocks change during the event (two zone names), every time carries its own zone name instead, so nothing is ambiguous.
 */
function timeStyle(tz: string, instants: readonly Ms[], firstAosMs: Ms) {
  const names = [...new Set(instants.map((ms) => zoneName(ms, tz)))];
  const mixed = names.length > 1;
  const firstDay = zoned(firstAosMs, tz, SHORT_DAY);
  const clock = (ms: Ms) => `${zoned(ms, tz, CLOCK)}${mixed ? ` ${zoneName(ms, tz)}` : ''}`;
  const onDay = (ms: Ms) => (zoned(ms, tz, SHORT_DAY) === firstDay ? '' : `${zoned(ms, tz, SHORT_DAY)}, `);
  /** "6:21:07–6:31:53 PM" (one AM/PM when both ends share it); a date appears only when it differs from the event's first day. */
  const range = (a: Ms, b: Ms) => {
    const collapse = !mixed && dayPeriod(a, tz) === dayPeriod(b, tz);
    const left = collapse ? clock(a).replace(/ [AP]M$/, '') : clock(a);
    const tail = zoned(b, tz, SHORT_DAY) !== zoned(a, tz, SHORT_DAY) ? ` (${zoned(b, tz, SHORT_DAY)})` : '';
    return `${onDay(a)}${left}–${clock(b)}${tail}`;
  };
  return {
    zoneLine: mixed ? `Times are in the ${tz} time zone; the clocks change during this event.` : `All times ${names[0]}`,
    clock,
    range,
    at: (ms: Ms) => `${onDay(ms)}${clock(ms)}`,
  };
}
type TimeStyle = ReturnType<typeof timeStyle>;

function passLines(p: CalendarPass, style: TimeStyle, thresholdDeg: number): string[] {
  const act = activityOf(p.noradId);
  const lines: string[] = [];
  if (act?.sunlightRequired) {
    const peak = p.eligibleMaxElevationDeg === null ? 'no sunlit peak' : `sunlit peak ${Math.round(p.eligibleMaxElevationDeg)}° (pass peak ${Math.round(p.fullMaxElevationDeg)}°)`;
    lines.push(`Sunlight only: usable while the satellite is in sunlight; ${peak}, ${exactDuration(p.operatingMs)} of ${exactDuration(p.setMs - p.riseMs)} usable.${p.sunlight === 'partly-eclipsed' ? ' Partly in Earth’s shadow.' : ''}`);
  }
  lines.push(`Pass: ${style.range(p.riseMs, p.setMs)}`);
  lines.push(`Peak: ${style.at(p.peakMs)} · ${Math.round(p.fullMaxElevationDeg)}°`);
  lines.push(`Duration: ${exactDuration(p.setMs - p.riseMs)}`);
  if (p.aboveThreshold !== undefined) {
    lines.push(
      p.aboveThreshold === null
        ? `Above ${thresholdDeg}°: none`
        : `Above ${thresholdDeg}°: ${style.range(p.aboveThreshold.start, p.aboveThreshold.end)} · ${exactDuration(p.aboveThreshold.end - p.aboveThreshold.start)}`,
    );
  }
  if (p.riseAzDeg !== undefined && p.setAzDeg !== undefined) lines.push(`Direction: ${compass(p.riseAzDeg)} → ${compass(p.setAzDeg)}`);
  if (act) {
    lines.push('', `Transmit: ${act.uplink.mhz.toFixed(3)} MHz · ${act.uplink.ctcssHz ? `tone ${act.uplink.ctcssHz} Hz` : 'no tone listed'}`, `Receive: ${act.downlink.mhz.toFixed(3)} MHz`);
  } else {
    lines.push('', 'Radio settings: no catalog entry for this satellite.');
  }
  return lines;
}

/** Brief operational warnings, each once per satellite: ISS-style interruptions and the catalog's own one-sentence notes. */
function warningLines(passes: readonly CalendarPass[]): string[] {
  const satellites = new Set(passes.map((p) => p.noradId));
  const out: string[] = [];
  for (const id of satellites) {
    const act = activityOf(id);
    if (!act) continue;
    const label = satellites.size > 1 ? `${act.name}: ` : '';
    if (act.interruptible) out.push(`${act.name} repeater availability depends on station operations.`);
    for (const r of act.restrictions) if (r.kind === 'note') out.push(`${label}${r.text}`);
  }
  return out;
}

/**
 * The compact, plain-text description: date and zone stated once, one short block per pass (exact start and end with seconds,
 * peak, duration, stored threshold interval and directions, radio settings), one buffer sentence, brief warnings once, and one
 * static-copy sentence with the planner link. Supporting explanations belong in the planner, not in the calendar entry.
 */
export function calendarDescription(source: CalendarSource, exportedAtMs: Ms): string {
  validateContext(source, exportedAtMs);
  const tz = source.timeZone;
  const passes = inTimeOrder(source.original.counted);
  const t = calendarTimes(passes);
  const instants = [t.startMs, t.endMs, ...passes.flatMap((p) => [p.riseMs, p.peakMs, p.setMs, ...(p.aboveThreshold ? [p.aboveThreshold.start, p.aboveThreshold.end] : [])])];
  const style = timeStyle(tz, instants, t.firstAosMs);
  const out: string[] = [];

  const alerts = (source.alerts ?? []).filter((a) => a.trim() !== '');
  for (const a of alerts) out.push(`⚠ ${a}`);
  if (exportedAtMs > t.lastLosMs) out.push('Past event: these passes have already happened.');
  if (out.length > 0) out.push('');

  const day = zoned(t.firstAosMs, tz, LONG_DAY);
  out.push(passes.length === 1 ? `${passes[0]!.name} — ${day}` : `${passes.length} passes — ${day}`);
  out.push(style.zoneLine);
  if (passes.length > 1) out.push(`Span: ${exactDuration(t.lastLosMs - t.firstAosMs)} from first pass start to last pass end`);

  passes.forEach((p, i) => {
    out.push('');
    if (passes.length > 1) out.push(`${p.name} · pass ${i + 1} of ${passes.length}`);
    out.push(...passLines(p, style, source.criteria.minElevationDeg));
  });

  out.push('', `Includes ${CALENDAR_SETUP_MIN} min setup before and ${CALENDAR_POST_MIN} min after.${t.extendedToMinimum ? ` Extended to the ${CALENDAR_MIN_EVENT_MIN}-minute minimum.` : ''}`);
  out.push(...warningLines(passes));
  if (passes.some((p) => p.riseAzDeg === undefined || p.setAzDeg === undefined || p.aboveThreshold === undefined)) {
    out.push('Some details were not saved with this older event, so they are left out.');
  }
  out.push('', 'Static calendar copy—recheck times and status:', PLANNER_URL);
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

/**
 * Short alert texts for saved passes whose satellite no longer qualifies at the latest re-check (one per satellite), for the top of
 * the calendar description. The planner's re-check supplies the satellite and the reason; this only words it.
 */
export function lostEligibilityAlerts(lost: ReadonlyArray<{ name: string; reason: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lost) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    out.push(`${l.name} no longer qualifies: ${l.reason.replace(/\.+$/, '')}. Re-check before the event.`);
  }
  return out;
}
