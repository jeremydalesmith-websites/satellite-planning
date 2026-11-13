/**
 * Refresh public data into public/data/ so the static app never needs
 * cross-origin access to AMSAT at runtime.
 *
 *   node scripts/refresh-data.ts [--strict]
 *
 * Writes:
 *   public/data/elements.json  AMSAT TLEs, filtered to the catalog
 *   public/data/status.json    recent AMSAT status reports for each catalog FM repeater
 *
 * Failure policy (never fabricate data, never advance a timestamp on a failed download):
 *   - elements download/validation fails  -> exit 1, nothing written.
 *   - status is ALL-OR-NOTHING: it is written only if every repeater entry downloaded and parsed. If any request fails,
 *     status.json is NOT written: a file already on disk stays in place with its older download time, and with none the
 *     app treats every repeater as "status unknown".
 *   - --strict (used by the scheduled update): any status failure -> exit 1 and NOTHING is written at all.
 *     Without it (npm start) a status failure only warns, and fresh elements are still written.
 *
 * AMSAT status API terms (status.amsat.org/api/v1/overview.php#usage): identify the
 * client with a descriptive User-Agent, poll no more than every 5 minutes. This job
 * makes one request per catalog satellite, spaced out, once per run. Report data is
 * CC BY 4.0; attribution is shown in the app.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SATELLITES, SOURCES } from '../src/catalog/catalog.ts';
import { assembleStatusFile, planWrites } from '../src/data/refresh.ts';
import type { StatusAssembly, StatusAttempt } from '../src/data/refresh.ts';
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

/** Write via a temporary file and a rename, so a reader never sees a half-written data file. */
async function writeAtomic(name: string, text: string): Promise<void> {
  const tmp = join(outDir, name + '.tmp');
  await writeFile(tmp, text);
  await rename(tmp, join(outDir, name));
}

async function downloadElements(): Promise<ElementsFile> {
  const text = await fetchText(SOURCES.amsatTle.url);
  const { records, rejected } = parseTleText(text);
  if (records.length < 20) throw new Error(`Only ${records.length} valid element sets parsed; refusing to publish`);
  const { sets, missing } = selectElements(records, SATELLITES.map((s) => s.noradId));
  if (sets.length === 0) throw new Error('No catalog satellites found in the download');
  console.log(`elements: ${sets.length} catalog sets (${records.length} parsed, ${rejected.length} rejected)`);
  if (missing.length) console.warn(`elements: MISSING catalog IDs: ${missing.join(', ')}`);
  return { schema: 1, source: { name: SOURCES.amsatTle.label, url: SOURCES.amsatTle.url }, downloadedAt: new Date().toISOString(), sets, missing };
}

async function downloadStatus(): Promise<StatusAssembly> {
  const attempts: Record<string, StatusAttempt> = {};
  for (const a of ACTIVITIES) {
    const url = `${STATUS_BASE}/reports.php?name=${encodeURIComponent(a.amsatStatusKey)}&hours=${STATUS_HOURS}&limit=${STATUS_LIMIT}`;
    try {
      const body = JSON.parse(await fetchText(url));
      const { reports, problems } = parseStatusReports(body, { name: a.amsatStatusKey, noradId: a.noradId });
      if (problems.length) console.warn(`status ${a.amsatStatusKey}: ${problems.length} problem(s), e.g. ${problems[0]}`);
      attempts[a.amsatStatusKey] = { reports };
    } catch (e) {
      // An unknown name returns 404 satellite_not_found; record it rather than guessing.
      attempts[a.amsatStatusKey] = { error: e instanceof Error ? e.message : String(e) };
      console.warn(`status ${a.amsatStatusKey}: FAILED (${attempts[a.amsatStatusKey]!.error})`);
    }
    await new Promise((r) => setTimeout(r, 1000)); // be polite to a volunteer-run API
  }
  return assembleStatusFile(attempts, ACTIVITIES.map((a) => a.amsatStatusKey), new Date());
}

const strict = process.argv.includes('--strict');
await mkdir(outDir, { recursive: true });
let elements: ElementsFile | null = null;
try {
  elements = await downloadElements();
} catch (e) {
  console.error(`ERROR: ${e instanceof Error ? e.message : e}`);
}
// Status is only requested when the elements succeeded (a failed run should not cost 17 more requests).
const status = elements ? await downloadStatus() : null;
const plan = planWrites(elements, status, strict);
for (const m of plan.messages) console.warn(m);
if (plan.writeElements && elements) await writeAtomic('elements.json', JSON.stringify(elements));
if (plan.writeStatus && status?.ok) {
  await writeAtomic('status.json', JSON.stringify(status.file satisfies StatusFile));
  console.log(`status: all ${ACTIVITIES.length} repeater entries fetched`);
}
if (!plan.writeStatus && plan.exitCode === 0) console.warn('The app will show operational status as unknown (or as old as the existing file).');
process.exit(plan.exitCode);
