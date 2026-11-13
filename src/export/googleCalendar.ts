/**
 * "Add to Google Calendar": a prefilled event link for a SAVED event. A pure builder with no network or storage access; it opens
 * nothing itself (the page shows the result as an ordinary link).
 *
 * It reuses the approved calendar pieces unchanged, so the title, the 10-minute setup and 5-minute post-pass buffers, the compact
 * plain-text description and all data validation are exactly what the .ics builder uses. The link only carries them to Google's
 * event-template address:
 *
 *   https://calendar.google.com/calendar/render?action=TEMPLATE&text=<title>&dates=<start>/<end>&ctz=<zone>&details=<description>
 *
 *   text    the title (calendarTitle)
 *   dates   start/end in UTC ("Z"), the same instants as the .ics DTSTART/DTEND (setup start to buffered end)
 *   ctz     the event's saved planning zone, so the time shows in the zone the description names
 *   details the compact description as PLAIN TEXT: line breaks are encoded newlines (no HTML)
 *
 * Deliberately not sent: location or coordinates, guests, a target calendar, reminders. The result is a one-time copy in the
 * person's own calendar: Google keeps no link back to the planner, so it never updates when predictions change.
 */
import type { Ms } from '../domain/types.ts';
import { calendarDescription, calendarTimes, calendarTitle } from './ics.ts';
import type { CalendarExportOptions, CalendarSource } from './ics.ts';

export const GOOGLE_CALENDAR_TEMPLATE_URL = 'https://calendar.google.com/calendar/render';

/** Percent-encode everything but unreserved characters, including ! ' ( ) * so the link survives being pasted into Markdown or chat. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const compactUtc = (ms: Ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * The link for a saved event, exactly as saved. Throws InvalidCalendarDataError for broken saved data (see validatePasses), so a
 * broken event never produces a link. `options` carries labels for SAMPLE links only; the app never passes them.
 */
export function buildGoogleCalendarUrl(source: CalendarSource, exportedAtMs: Ms, options: CalendarExportOptions = {}): string {
  // The description validates the context and every pass first, so nothing below runs on broken data.
  const description = `${options.descriptionPrefix ? `${options.descriptionPrefix}\n\n` : ''}${calendarDescription(source, exportedAtMs)}`;
  const passes = source.original.counted;
  const t = calendarTimes(passes);
  const title = `${options.titlePrefix ?? ''}${calendarTitle(passes)}`;
  const query = [
    'action=TEMPLATE',
    `text=${encode(title)}`,
    `dates=${compactUtc(t.startMs)}/${compactUtc(t.endMs)}`,
    `ctz=${source.timeZone}`, // an IANA name (validated by the description step): letters, digits, "/", "_", "-", "+"
    `details=${encode(description)}`,
  ];
  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${query.join('&')}`;
}
