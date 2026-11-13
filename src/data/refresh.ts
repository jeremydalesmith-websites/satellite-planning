/**
 * The decision logic of the data refresh, kept free of network and file access so it can be tested.
 *
 * ALL-OR-NOTHING: a status file is produced only when EVERY expected repeater entry was downloaded and parsed. If any
 * request failed there is no new file, so the caller keeps the previous file untouched and, in particular, its older
 * `downloadedAt`: a timestamp is never advanced by a download that did not fully succeed. (Writing a file with a fresh
 * time and some satellites silently empty would let stale or missing evidence look current.)
 */
import type { CompactReport, ElementsFile, StatusFile } from './ingest.ts';

export interface StatusAttempt {
  reports?: CompactReport[];
  /** Set when the request or its parsing failed. */
  error?: string;
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
