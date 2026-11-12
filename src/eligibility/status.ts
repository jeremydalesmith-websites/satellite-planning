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

/**
 * Finer-grained evidence description, used for the label shown to people. The qualifying
 * POLICY depends only on `state`; `detail` exists so the UI can say clearly which kind of
 * "no" this is.
 *
 *   active                 heard recently, nothing newer says otherwise      -> counts
 *   mixed                  heard AND a newer negative report                 -> not counted
 *   not-heard              negative report(s) only, too few to conclude      -> not counted
 *   confirmed-unavailable  repeated negatives from several operators         -> excluded
 *   no-recent-reports      nothing in the freshness window                   -> not counted
 *   no-data                no status data could be loaded                    -> not counted
 */
export type StatusDetail = 'active' | 'mixed' | 'not-heard' | 'confirmed-unavailable' | 'no-recent-reports' | 'no-data';

export interface OperationalStatus {
  state: StatusState;
  detail: StatusDetail;
  /** Short plain-language label. */
  label: string;
  /** One sentence explaining why, without absolute times (the UI adds those). */
  explanation: string;
  /** From the catalog: operation is only at certain times, even if recently reported. */
  scheduleDependent: boolean;
  lastPositiveMs: Ms | null;
  lastNegativeMs: Ms | null;
  positives: number;
  /** "Not Heard" plus "Telemetry Only" reports in the window. */
  negatives: number;
  /** Of the negatives: "Not Heard" (nothing received). */
  notHeard: number;
  /** Of the negatives: "Telemetry Only" (the beacon was heard, so the repeater is not shown to work). */
  beaconOnly: number;
  windowHours: number;
  /** When the status data was downloaded (ISO), or null if there is no status data. */
  dataDownloadedAt: string | null;
  /** Only recently-reported-active counts toward an event's minimum by default. */
  countsTowardMinimum: boolean;
}

export const STATUS_LABELS: Record<StatusState, string> = {
  'recently-reported-active': 'Recently reported active',
  'known-unavailable': 'Confirmed unavailable',
  'schedule-dependent': 'Schedule-dependent (unconfirmed)',
  'unknown-stale': 'No recent reports',
};

export const DETAIL_LABELS: Record<StatusDetail, string> = {
  active: 'Recently reported active',
  mixed: 'Mixed reports',
  'not-heard': 'Not heard (unconfirmed)',
  'confirmed-unavailable': 'Confirmed unavailable',
  'no-recent-reports': 'No recent reports',
  'no-data': 'Status data unavailable',
};

export function classifyStatus(
  activity: Pick<FmActivity, 'amsatStatusKey' | 'scheduleDependent'>,
  file: StatusFile | null,
  nowMs: Ms,
  windowHours = STATUS_WINDOW_HOURS,
): OperationalStatus {
  const sched = activity.scheduleDependent;
  const schedNote = sched ? ' Operation is only at certain times, so it may not be on at the event.' : '';
  const base = { scheduleDependent: sched, windowHours, dataDownloadedAt: file?.downloadedAt ?? null };
  /** Not counted, and not "confirmed unavailable": the label keeps the schedule caveat when it applies. */
  const unconfirmed = (detail: StatusDetail, explanation: string, c: Partial<OperationalStatus> = {}): OperationalStatus => {
    const state: StatusState = sched ? 'schedule-dependent' : 'unknown-stale';
    return {
      ...base,
      state,
      detail,
      label: detail === 'no-recent-reports' && sched ? STATUS_LABELS['schedule-dependent'] : DETAIL_LABELS[detail],
      explanation,
      lastPositiveMs: null,
      lastNegativeMs: null,
      positives: 0,
      negatives: 0,
      notHeard: 0,
      beaconOnly: 0,
      countsTowardMinimum: false,
      ...c,
    };
  };

  if (!file) return unconfirmed('no-data', 'No operating-status data is available, so this repeater cannot be confirmed.');
  const entry = file.satellites[activity.amsatStatusKey];
  if (!entry || entry.error) return unconfirmed('no-data', 'Status data could not be retrieved for this repeater.');

  const since = nowMs - windowHours * 3_600_000;
  let positives = 0;
  let notHeard = 0;
  let beaconOnly = 0;
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
      if (code === 'N') notHeard++;
      else beaconOnly++;
      negCallers.add(caller);
      lastNeg = lastNeg === null ? t : Math.max(lastNeg, t);
    }
    // 'C' (ISS crew voice active) says nothing about the FM repeater and is ignored.
  }
  const negatives = notHeard + beaconOnly;
  const counts = { lastPositiveMs: lastPos, lastNegativeMs: lastNeg, positives, negatives, notHeard, beaconOnly };
  const negText = `${notHeard} "not heard"${beaconOnly ? ` and ${beaconOnly} "beacon only"` : ''}`;

  if (positives > 0 && (lastNeg === null || (lastPos !== null && lastPos > lastNeg))) {
    return {
      ...base,
      ...counts,
      state: 'recently-reported-active',
      detail: 'active',
      label: DETAIL_LABELS.active,
      explanation: `${positives} "heard" report${positives === 1 ? '' : 's'} in the last ${windowHours} hours and none newer saying otherwise.${schedNote}`,
      countsTowardMinimum: true,
    };
  }
  if (positives > 0) {
    return unconfirmed(
      'mixed',
      `Mixed reports in the last ${windowHours} hours: ${positives} heard, ${negText}, and the newest says it was not working. It may be on only part of the time.`,
      counts,
    );
  }
  if (negatives >= UNAVAILABLE_MIN_REPORTS && negCallers.size >= UNAVAILABLE_MIN_CALLSIGNS) {
    return {
      ...base,
      ...counts,
      state: 'known-unavailable',
      detail: 'confirmed-unavailable',
      label: DETAIL_LABELS['confirmed-unavailable'],
      explanation: `${negText} reports from ${negCallers.size} operators in the last ${windowHours} hours and none saying it worked. A heard beacon alone does not mean the repeater works.`,
      countsTowardMinimum: false,
    };
  }
  if (negatives > 0) {
    return unconfirmed(
      'not-heard',
      `${negText} report${negatives === 1 ? '' : 's'} in the last ${windowHours} hours, too few to conclude it is unavailable, and nothing confirming it works.${schedNote}`,
      counts,
    );
  }
  return unconfirmed('no-recent-reports', `No activity reports in the last ${windowHours} hours.${schedNote}`);
}
