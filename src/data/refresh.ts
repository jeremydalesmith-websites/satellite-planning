/**
 * The decision logic of the data refresh, kept free of network and file access so it can be tested.
 *
 * ALL-OR-NOTHING: a status file is produced only when EVERY expected repeater entry was downloaded and parsed. If any
 * request failed there is no new file, so the caller keeps the previous file untouched and, in particular, its older
 * `downloadedAt`: a timestamp is never advanced by a download that did not fully succeed. (Writing a file with a fresh
 * time and some satellites silently empty would let stale or missing evidence look current.)
 */
import { parseStatusReports } from './ingest.ts';
import type { CompactReport, ElementsFile, ExpectedStatusEntry, StatusFile } from './ingest.ts';

export interface StatusAttempt {
  reports?: CompactReport[];
  /** Set when the request or its parsing failed. */
  error?: string;
}

/**
 * Turn the body of ONE status response into an attempt. The three outcomes are deliberately different:
 *   - a well-formed response with NO reports ({"data": []}) is a SUCCESS: that repeater simply has no recent reports, so it
 *     stays ineligible (no "Heard" report), and it does not by itself stop the other repeaters' data from being updated;
 *   - a response that is not the expected shape, or whose rows for this entry are all unreadable, is MALFORMED = a failure;
 *   - (a transport failure, HTTP error or invalid JSON never reaches here: the caller records it as a failure.)
 * Rows that belong to a different mode or satellite are rejected on purpose (see parseStatusReports) and do not count as
 * unreadable.
 */
export function statusAttemptFromBody(body: unknown, expected: ExpectedStatusEntry): StatusAttempt & { notes: string[] } {
  const parsed = parseStatusReports(body, expected);
  if (!parsed.hasDataArray) return { error: 'malformed response: no "data" array', notes: parsed.problems };
  if (parsed.unreadableRows > 0 && parsed.reports.length === 0) {
    return { error: `malformed response: ${parsed.unreadableRows} report row(s) could not be read and none could`, notes: parsed.problems };
  }
  return { reports: parsed.reports, notes: parsed.problems };
}

export type StatusAssembly =
  | { ok: true; file: StatusFile }
  | { ok: false; failed: Array<{ key: string; error: string }> };

export function assembleStatusFile(attempts: Readonly<Record<string, StatusAttempt>>, expectedKeys: readonly string[], now: Date): StatusAssembly {
  const failed: Array<{ key: string; error: string }> = [];
  const satellites: StatusFile['satellites'] = {};
  for (const key of expectedKeys) {
    const a = attempts[key];
    if (!a) failed.push({ key, error: 'no request was made' });
    else if (a.error !== undefined) failed.push({ key, error: a.error });
    else if (!a.reports) failed.push({ key, error: 'no reports list' });
    else satellites[key] = { reports: a.reports };
  }
  if (failed.length > 0) return { ok: false, failed };
  return {
    ok: true,
    file: {
      schema: 1,
      source: { name: 'AMSAT Satellite Status API v1 (reports.php)', url: 'https://status.amsat.org/', license: 'CC BY 4.0 (AMSAT)' },
      downloadedAt: now.toISOString(),
      satellites,
    },
  };
}

/** What the refresh will write, given what succeeded. `strict` (automation) fails unless BOTH files are complete. */
export interface RefreshPlan {
  writeElements: boolean;
  writeStatus: boolean;
  /** Process exit code: 0 or 1. */
  exitCode: 0 | 1;
  messages: string[];
}

export function planWrites(elements: ElementsFile | null, status: StatusAssembly | null, strict: boolean): RefreshPlan {
  const messages: string[] = [];
  if (!elements) {
    return { writeElements: false, writeStatus: false, exitCode: 1, messages: ['Orbital data was not downloaded: nothing was written.'] };
  }
  const statusOk = status?.ok === true;
  if (!statusOk) {
    const detail = status && !status.ok ? status.failed.map((f) => `${f.key}: ${f.error}`).join('; ') : 'no status download';
    messages.push(`Status data was not fully downloaded (${detail}). The previous status file, if any, is kept with its own download time.`);
  }
  if (strict && !statusOk) {
    // Automation: never publish half an update. Nothing is written at all.
    return { writeElements: false, writeStatus: false, exitCode: 1, messages: [...messages, 'Strict mode: nothing was written.'] };
  }
  return { writeElements: true, writeStatus: statusOk, exitCode: 0, messages };
}
