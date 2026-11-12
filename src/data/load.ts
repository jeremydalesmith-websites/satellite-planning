/**
 * Browser-side loading of the normalized data files published alongside the app.
 * Never calls AMSAT directly (no CORS dependence); never substitutes data.
 */
import type { ElementsFile, StatusFile } from './ingest.ts';
import type { LoadedData } from '../planner.ts';

export type LoadResult =
  | { ok: true; data: LoadedData; statusProblem: string | null }
  | { ok: false; message: string };

/**
 * Where the published data files live. With an absolute build base (e.g. /satellites/) the URL
 * is anchored to that base, so it is correct even if the page itself is opened without a
 * trailing slash. With the default relative base ('./') it resolves against the page's own URL,
 * which is what lets one build work from any sub-directory.
 */
export function dataUrl(path: string, base: string = import.meta.env.BASE_URL, origin: string = window.location.origin, baseURI: string = document.baseURI): URL {
  return base.startsWith('/') ? new URL(base + path, origin) : new URL(path, baseURI);
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(dataUrl(path), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: not valid JSON${type.includes('html') ? ' (the server returned a web page)' : ''}`);
  }
}

export function isElementsFile(x: unknown): x is ElementsFile {
  const f = x as Partial<ElementsFile> | null;
  return !!f && f.schema === 1 && typeof f.downloadedAt === 'string' && Array.isArray(f.sets) &&
    f.sets.every((s) => typeof s.noradId === 'number' && typeof s.line1 === 'string' && typeof s.line2 === 'string' && Number.isFinite(s.epochMs));
}

const REPORT_CODES = new Set(['H', 'N', 'T', 'C']);

/** What is wrong with a status file, or null if it is well formed. Every entry must carry a valid reports list. */
export function statusFileProblem(x: unknown): string | null {
  const f = x as Partial<StatusFile> | null;
  if (!f || f.schema !== 1 || typeof f.downloadedAt !== 'string' || !f.satellites || typeof f.satellites !== 'object') return 'unexpected format';
  for (const [key, entry] of Object.entries(f.satellites)) {
    const e = entry as { reports?: unknown } | null;
    if (!e || typeof e !== 'object') return `the entry for ${key} is missing`;
    if (!Array.isArray(e.reports)) return `the entry for ${key} has no valid list of reports`;
    const bad = e.reports.some((r) => !Array.isArray(r) || r.length !== 3 || typeof r[0] !== 'number' || !Number.isFinite(r[0]) || !REPORT_CODES.has(r[1]) || typeof r[2] !== 'number');
    if (bad) return `the entry for ${key} contains a malformed report`;
  }
  return null;
}

export function isStatusFile(x: unknown): x is StatusFile {
  return statusFileProblem(x) === null;
}

export async function loadData(): Promise<LoadResult> {
  let elements: ElementsFile;
  try {
    const raw = await getJson('data/elements.json');
    if (!isElementsFile(raw)) throw new Error('data/elements.json has an unexpected format');
    elements = raw;
  } catch (e) {
    return {
      ok: false,
      message: `Orbital data could not be loaded (${e instanceof Error ? e.message : String(e)}). Without it no predictions can be made.`,
    };
  }
  let status: StatusFile | null = null;
  let statusProblem: string | null = null;
  try {
    const raw = await getJson('data/status.json');
    const problem = statusFileProblem(raw);
    if (problem) throw new Error(`the file is malformed: ${problem}`);
    status = raw as StatusFile; // validated just above
  } catch (e) {
    statusProblem = `Operating-status data is unavailable (${e instanceof Error ? e.message : String(e)}). No satellite can be confirmed eligible without it, so none will be planned.`;
  }
  return { ok: true, data: { elements, status }, statusProblem };
}
