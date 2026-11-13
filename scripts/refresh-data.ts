/**
 * Refresh public data into public/data/ so the static app never needs
 * cross-origin access to AMSAT at runtime.
 *
 *   node scripts/refresh-data.ts [--strict] [--deadline-min N]
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
 *   - --deadline-min N bounds the WHOLE download phase: once N minutes have passed every request that is running is aborted and
 *     no new one is tried, so the run ends as an ordinary failure (exit 1, nothing written in strict mode) instead of being
 *     killed by a surrounding time limit. (Worst case without it: 18 requests x 3 tries x 30 s, far longer than any job limit.)
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
import { assembleStatusFile, planWrites, statusAttemptFromBody } from '../src/data/refresh.ts';
import type { StatusAssembly, StatusAttempt } from '../src/data/refresh.ts';
import { parseTleText, selectElements } from '../src/data/ingest.ts';
import type { ElementsFile, StatusFile } from '../src/data/ingest.ts';

// SAT_PLANNER_* variables exist for the automated tests of the failure paths (a scratch directory and no waiting);
// leave them unset in normal use.
const outDir = process.env.SAT_PLANNER_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const RETRY_MS = Number(process.env.SAT_PLANNER_RETRY_MS ?? 1500);
const SPACING_MS = Number(process.env.SAT_PLANNER_SPACING_MS ?? 1000);
// Overall deadline for all downloads (--deadline-min N, or SAT_PLANNER_DEADLINE_MS for tests). None by default.
const deadlineArg = process.argv.indexOf('--deadline-min');
const DEADLINE_MS = process.env.SAT_PLANNER_DEADLINE_MS
  ? Number(process.env.SAT_PLANNER_DEADLINE_MS)
  : deadlineArg >= 0 ? Number(process.argv[deadlineArg + 1]) * 60_000 : 0;
if (deadlineArg >= 0 && !(DEADLINE_MS > 0)) { console.error('--deadline-min needs a positive number of minutes'); process.exit(2); }
const deadline = DEADLINE_MS > 0 ? AbortSignal.timeout(DEADLINE_MS) : undefined;
const pause = (ms: number) => (deadline?.aborted ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms)));
// Generic client name by design. Optionally append a contact, e.g. SAT_PLANNER_CONTACT="+https://example.org".
const UA = `sat-event-planner/0.1 (static-site data refresh${process.env.SAT_PLANNER_CONTACT ? '; ' + process.env.SAT_PLANNER_CONTACT : ''})`;
const STATUS_BASE = 'https://status.amsat.org/api/v1';
const STATUS_HOURS = 720; // API maximum
const STATUS_LIMIT = 500; // API maximum; newest first

async function fetchText(url: string, tries = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      if (deadline?.aborted) throw new Error('refresh deadline exceeded');
      const signal = deadline ? AbortSignal.any([AbortSignal.timeout(30_000), deadline]) : AbortSignal.timeout(30_000);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (deadline?.aborted) throw new Error('refresh deadline exceeded');
      await pause(RETRY_MS * (i + 1));
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
      const { notes, ...attempt } = statusAttemptFromBody(body, { name: a.amsatStatusKey, noradId: a.noradId });
      if (notes.length) console.warn(`status ${a.amsatStatusKey}: ${notes.length} note(s), e.g. ${notes[0]}`);
      if (attempt.reports?.length === 0) console.log(`status ${a.amsatStatusKey}: no reports (valid response; stays ineligible)`);
      attempts[a.amsatStatusKey] = attempt;
      if (attempt.error) console.warn(`status ${a.amsatStatusKey}: FAILED (${attempt.error})`);
    } catch (e) {
      // An unknown name returns 404 satellite_not_found; record it rather than guessing.
      attempts[a.amsatStatusKey] = { error: e instanceof Error ? e.message : String(e) };
      console.warn(`status ${a.amsatStatusKey}: FAILED (${attempts[a.amsatStatusKey]!.error})`);
    }
    await pause(SPACING_MS); // be polite to a volunteer-run API
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
