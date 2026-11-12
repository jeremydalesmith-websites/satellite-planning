/**
 * Refresh public data into public/data/ so the static app never needs
 * cross-origin access to AMSAT at runtime.
 *
 *   node scripts/refresh-data.ts
 *
 * Writes:
 *   public/data/elements.json  AMSAT TLEs, filtered to the catalog
 *   public/data/status.json    recent AMSAT status reports for each catalog FM repeater
 *
 * Failure policy (never fabricate data):
 *   - elements download/validation fails  -> exit 1, nothing written.
 *   - status download fails               -> warn, status.json NOT written. Any status.json already on disk
 *                                            stays in place (and keeps its older download time); with none,
 *                                            the app treats every repeater as "status unknown".
 *
 * AMSAT status API terms (status.amsat.org/api/v1/overview.php#usage): identify the
 * client with a descriptive User-Agent, poll no more than every 5 minutes. This job
 * makes one request per catalog satellite, spaced out, once per run. Report data is
 * CC BY 4.0; attribution is shown in the app.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SATELLITES, SOURCES } from '../src/catalog/catalog.ts';
import { parseStatusReports, parseTleText, selectElements } from '../src/data/ingest.ts';
import type { ElementsFile, StatusFile } from '../src/data/ingest.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
// Generic client name by design. Optionally append a contact, e.g. SAT_PLANNER_CONTACT="+https://example.org".
const UA = `sat-event-planner/0.1 (static-site data refresh${process.env.SAT_PLANNER_CONTACT ? '; ' + process.env.SAT_PLANNER_CONTACT : ''})`;
const STATUS_BASE = 'https://status.amsat.org/api/v1';
const STATUS_HOURS = 720; // API maximum
const STATUS_LIMIT = 500; // API maximum; newest first

async function fetchText(url: string, tries = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function refreshElements(): Promise<void> {
  const text = await fetchText(SOURCES.amsatTle.url);
  const { records, rejected } = parseTleText(text);
  if (records.length < 20) throw new Error(`Only ${records.length} valid element sets parsed; refusing to publish`);
  const { sets, missing } = selectElements(records, SATELLITES.map((s) => s.noradId));
  if (sets.length === 0) throw new Error('No catalog satellites found in the download');
  const file: ElementsFile = {
    schema: 1,
    source: { name: SOURCES.amsatTle.label, url: SOURCES.amsatTle.url },
    downloadedAt: new Date().toISOString(),
    sets,
    missing,
  };
  await writeFile(join(outDir, 'elements.json'), JSON.stringify(file));
  console.log(`elements: ${sets.length} catalog sets (${records.length} parsed, ${rejected.length} rejected)`);
  if (missing.length) console.warn(`elements: MISSING catalog IDs: ${missing.join(', ')}`);
}

async function refreshStatus(): Promise<void> {
  const satellites: StatusFile['satellites'] = {};
  let ok = 0;
  for (const a of ACTIVITIES) {
    const url = `${STATUS_BASE}/reports.php?name=${encodeURIComponent(a.amsatStatusKey)}&hours=${STATUS_HOURS}&limit=${STATUS_LIMIT}`;
    try {
      const body = JSON.parse(await fetchText(url));
      const { reports, problems } = parseStatusReports(body, { name: a.amsatStatusKey, noradId: a.noradId });
      if (problems.length) console.warn(`status ${a.amsatStatusKey}: ${problems.length} problem(s), e.g. ${problems[0]}`);
      satellites[a.amsatStatusKey] = { reports };
      ok++;
    } catch (e) {
      // An unknown name returns 404 satellite_not_found; record it rather than guessing.
      satellites[a.amsatStatusKey] = { reports: [], error: e instanceof Error ? e.message : String(e) };
      console.warn(`status ${a.amsatStatusKey}: FAILED (${satellites[a.amsatStatusKey]!.error})`);
    }
    await new Promise((r) => setTimeout(r, 1000)); // be polite to a volunteer-run API
  }
  if (ok === 0) throw new Error('Every status request failed');
  const file: StatusFile = {
    schema: 1,
    source: {
      name: 'AMSAT Satellite Status API v1 (reports.php)',
      url: 'https://status.amsat.org/',
      license: 'CC BY 4.0 (AMSAT)',
    },
    downloadedAt: new Date().toISOString(),
    satellites,
  };
  await writeFile(join(outDir, 'status.json'), JSON.stringify(file));
  console.log(`status: ${ok}/${ACTIVITIES.length} satellites fetched`);
}

await mkdir(outDir, { recursive: true });
await refreshElements(); // throws -> non-zero exit
try {
  await refreshStatus();
} catch (e) {
  console.warn(`WARNING: status data not refreshed: ${e instanceof Error ? e.message : e}`);
  console.warn('The app will show operational status as unknown for every repeater.');
}
