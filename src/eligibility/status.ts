/**
 * Operational status classification (a POLICY applied to public activity reports).
 *
 * AMSAT status reports are volunteer observations ("Heard", "Telemetry Only",
 * "Not Heard"). They are evidence, not guarantees. In particular a satellite's
 * beacon being heard ("Telemetry Only") does NOT show its FM repeater works.
 *
 * States (what the user asked to distinguish):
 *   recently-reported-active  FM activity reported within the freshness window, with
 *                             no newer negative report. The only state that counts.
 *   known-unavailable         Repeated negative reports, no positive ones, in the window.
 *   schedule-dependent        Catalog says operation is scheduled / crew- / test-dependent
 *                             and there is no recent confirmation.
 *   unknown-stale             No usable recent reports (or they conflict).
 *
 * Thresholds live in domain/policy.ts.
 */
import type { FmActivity } from '../catalog/catalog.ts';
import {
  STATUS_WINDOW_HOURS,
  UNAVAILABLE_MIN_CALLSIGNS,
  UNAVAILABLE_MIN_REPORTS,
} from '../domain/policy.ts';
import type { Ms } from '../domain/types.ts';
import type { StatusFile } from '../data/ingest.ts';

export type StatusState =
  | 'recently-reported-active'
  | 'known-unavailable'
  | 'schedule-dependent'
  | 'unknown-stale';

export interface OperationalStatus {
  state: StatusState;
  /** Short plain-language label. */
  label: string;
  /** One sentence explaining why, without absolute times (the UI adds those). */
  explanation: string;
  /** From the catalog: operation is only at certain times, even if recently reported. */
  scheduleDependent: boolean;
  lastPositiveMs: Ms | null;
  lastNegativeMs: Ms | null;
  positives: number;
  negatives: number;
  windowHours: number;
  /** When the status data was downloaded (ISO), or null if there is no status data. */
  dataDownloadedAt: string | null;
  /** Only recently-reported-active counts toward an event's minimum by default. */
  countsTowardMinimum: boolean;
}

export const STATUS_LABELS: Record<StatusState, string> = {
  'recently-reported-active': 'Recently reported active',
  'known-unavailable': 'Reported not working',
  'schedule-dependent': 'Depends on schedule (unconfirmed)',
  'unknown-stale': 'Status unknown or out of date',
};

export function classifyStatus(
  activity: Pick<FmActivity, 'amsatStatusKey' | 'scheduleDependent'>,
  file: StatusFile | null,
  nowMs: Ms,
  windowHours = STATUS_WINDOW_HOURS,
): OperationalStatus {
  const base = {
    scheduleDependent: activity.scheduleDependent,
    windowHours,
    dataDownloadedAt: file?.downloadedAt ?? null,
  };
  const entry = file?.satellites[activity.amsatStatusKey];
  const unknown = (why: string): OperationalStatus => {
    const state: StatusState = activity.scheduleDependent ? 'schedule-dependent' : 'unknown-stale';
    return {
      ...base,
      state,
      label: STATUS_LABELS[state],
      explanation: why,
      lastPositiveMs: null,
      lastNegativeMs: null,
      positives: 0,
      negatives: 0,
      countsTowardMinimum: false,
    };
  };
  if (!file) return unknown('No operating-status data is available, so this repeater cannot be confirmed.');
  if (!entry || entry.error) {
    return unknown('Status data could not be retrieved for this repeater.');
  }

  const since = nowMs - windowHours * 3_600_000;
  let positives = 0;
  let negatives = 0;
  let lastPos: Ms | null = null;
  let lastNeg: Ms | null = null;
  const negCallers = new Set<number>();
  for (const [sec, code, caller] of entry.reports) {
    const t = sec * 1000;
    if (t < since || t > nowMs + 3_600_000) continue; // outside window (allow clock skew of an hour)
    if (code === 'H') {
      positives++;
      lastPos = lastPos === null ? t : Math.max(lastPos, t);
    } else if (code === 'N' || code === 'T') {
      negatives++;
      negCallers.add(caller);
      lastNeg = lastNeg === null ? t : Math.max(lastNeg, t);
    }
    // 'C' (ISS crew voice active) says nothing about the FM repeater and is ignored.
  }
  const counts = { lastPositiveMs: lastPos, lastNegativeMs: lastNeg, positives, negatives };
  const sched = activity.scheduleDependent
    ? ' Operation is only at certain times, so it may not be on at the event.'
    : '';

  if (positives > 0 && (lastNeg === null || (lastPos !== null && lastPos > lastNeg))) {
    return {
      ...base,
      ...counts,
      state: 'recently-reported-active',
      label: STATUS_LABELS['recently-reported-active'],
      explanation: `${positives} "heard" report${positives === 1 ? '' : 's'} in the last ${windowHours} hours and none newer saying otherwise.${sched}`,
      countsTowardMinimum: true,
    };
  }
  if (positives > 0) {
    return {
      ...base,
      ...counts,
      state: activity.scheduleDependent ? 'schedule-dependent' : 'unknown-stale',
      label: activity.scheduleDependent ? STATUS_LABELS['schedule-dependent'] : STATUS_LABELS['unknown-stale'],
      explanation: `Mixed reports in the last ${windowHours} hours: ${positives} heard, ${negatives} not heard or beacon only, and the newest says it was not working. It may be on only part of the time.`,
      countsTowardMinimum: false,
    };
  }
  if (negatives >= UNAVAILABLE_MIN_REPORTS && negCallers.size >= UNAVAILABLE_MIN_CALLSIGNS) {
    return {
      ...base,
      ...counts,
      state: 'known-unavailable',
      label: STATUS_LABELS['known-unavailable'],
      explanation: `${negatives} reports from ${negCallers.size} operators in the last ${windowHours} hours say the repeater was not heard (a heard beacon alone does not mean the repeater works).`,
      countsTowardMinimum: false,
    };
  }
  const why =
    negatives > 0
      ? `Only ${negatives} negative report in the last ${windowHours} hours and no confirmation either way.`
      : `No activity reports in the last ${windowHours} hours.`;
  const state: StatusState = activity.scheduleDependent ? 'schedule-dependent' : 'unknown-stale';
  return {
    ...base,
    ...counts,
    state,
    label: STATUS_LABELS[state],
    explanation: why + sched,
    countsTowardMinimum: false,
  };
}
