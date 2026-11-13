/**
 * Pre-publication validation of the two data files. The scheduled update runs this BEFORE anything is copied into the
 * website, so a bad download can never replace a good publication.
 *
 * Problems are failures (block publication). Warnings are reported but do not block.
 * Nothing here relaxes the planner's own rules: it only refuses to publish data the planner could not use well.
 */
import { ACTIVITIES, SATELLITES } from '../catalog/catalog.ts';
import { MAX_ELEMENT_AGE_DAYS, STATUS_WINDOW_HOURS } from '../domain/policy.ts';
import type { ElementsFile, StatusFile } from './ingest.ts';
import { isElementsFile, statusFileProblem } from './load.ts';

export interface ValidationReport {
  problems: string[];
  warnings: string[];
}

export interface ValidationOptions {
  nowMs: number;
  /** Both downloads must have happened within this many hours of now (a stale file means the refresh did not run). */
  maxDownloadAgeHours: number;
}

const FUTURE_TOLERANCE_MS = 10 * 60_000;

function checkDownloadTime(label: string, iso: unknown, o: ValidationOptions, problems: string[]): void {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) { problems.push(`${label}: downloadedAt is not a valid time`); return; }
  if (t > o.nowMs + FUTURE_TOLERANCE_MS) problems.push(`${label}: downloadedAt is in the future`);
  else if (o.nowMs - t > o.maxDownloadAgeHours * 3_600_000) problems.push(`${label}: downloaded more than ${o.maxDownloadAgeHours} hours ago, so this is not a fresh download`);
}

export function validateDataFiles(elementsRaw: unknown, statusRaw: unknown, o: ValidationOptions): ValidationReport {
  const problems: string[] = [];
  const warnings: string[] = [];

  // ---- orbital elements (Keplers)
  if (!isElementsFile(elementsRaw)) {
    problems.push('elements.json: missing or an unexpected format');
  } else {
    const el: ElementsFile = elementsRaw;
    checkDownloadTime('elements.json', el.downloadedAt, o, problems);
    const have = new Map(el.sets.map((s) => [s.noradId, s]));
    for (const sat of SATELLITES) {
      const set = have.get(sat.noradId);
      if (!set) { problems.push(`elements.json: no orbital data for ${sat.name} (${sat.noradId})`); continue; }
      const ageDays = (o.nowMs - set.epochMs) / 86_400_000;
      if (ageDays < -1) problems.push(`elements.json: the ${sat.name} element epoch is in the future`);
      else if (ageDays > MAX_ELEMENT_AGE_DAYS) warnings.push(`elements.json: the ${sat.name} element set is ${Math.round(ageDays)} days old (the planner skips it beyond ${MAX_ELEMENT_AGE_DAYS})`);
    }
    if (el.missing.length > 0) warnings.push(`elements.json: the download lacked catalog IDs ${el.missing.join(', ')}`);
  }

  // ---- activity reports
  const sp = statusFileProblem(statusRaw);
  if (sp) {
    problems.push(`status.json: ${sp}`);
  } else {
    const st = statusRaw as StatusFile;
    checkDownloadTime('status.json', st.downloadedAt, o, problems);
    let reportCount = 0;
    let recent = 0;
    for (const a of ACTIVITIES) {
      const entry = st.satellites[a.amsatStatusKey];
      if (!entry) { problems.push(`status.json: no entry for ${a.amsatStatusKey}`); continue; }
      if (entry.error) problems.push(`status.json: ${a.amsatStatusKey} records a failed download (${entry.error})`);
      for (const [sec] of entry.reports) {
        reportCount++;
        const ms = sec * 1000;
        if (ms > o.nowMs + FUTURE_TOLERANCE_MS) problems.push(`status.json: ${a.amsatStatusKey} has a report dated in the future`);
        if (o.nowMs - ms <= STATUS_WINDOW_HOURS * 3_600_000) recent++;
      }
    }
    // A well-formed answer of "no reports" is valid data: those satellites stay ineligible. It is worth a warning, not a block.
    if (reportCount === 0) warnings.push('status.json: contains no reports at all, so no satellite can qualify');
    else if (recent === 0) warnings.push(`status.json: no report in the last ${STATUS_WINDOW_HOURS} hours, so no satellite can currently qualify`);
  }
  return { problems, warnings };
}
