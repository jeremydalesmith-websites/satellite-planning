/**
 * Browser-side loading of the normalized data files published alongside the app.
 * Never calls AMSAT directly (no CORS dependence); never substitutes data.
 */
import type { ElementsFile, StatusFile } from './ingest.ts';
import type { LoadedData } from '../planner.ts';

export type LoadResult =
  | { ok: true; data: LoadedData; statusProblem: string | null }
  | { ok: false; message: string };

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(new URL(path, document.baseURI), { cache: 'no-cache' });
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

export function isStatusFile(x: unknown): x is StatusFile {
  const f = x as Partial<StatusFile> | null;
  return !!f && f.schema === 1 && typeof f.downloadedAt === 'string' && !!f.satellites && typeof f.satellites === 'object';
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
    if (!isStatusFile(raw)) throw new Error('unexpected format');
    status = raw;
  } catch (e) {
    statusProblem = `Operating-status data is unavailable (${e instanceof Error ? e.message : String(e)}). Every repeater will be treated as unconfirmed.`;
  }
  return { ok: true, data: { elements, status }, statusProblem };
}
