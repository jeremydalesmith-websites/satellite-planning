/**
 * Validate downloaded data files before they are published.
 *
 *   node scripts/validate-data.ts [directory] [--max-age-hours N]
 *
 * Defaults: directory public/data, 3 hours. Exit 0 = safe to publish, 1 = do not publish (problems are printed).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataFiles } from '../src/data/validate.ts';

const args = process.argv.slice(2);
const ageIdx = args.indexOf('--max-age-hours');
const maxAge = ageIdx >= 0 ? Number(args[ageIdx + 1]) : 3;
const dirArg = args.find((a, i) => !a.startsWith('--') && (ageIdx < 0 || i !== ageIdx + 1));
const dir = dirArg ? resolve(dirArg) : join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
if (!Number.isFinite(maxAge) || maxAge <= 0) { console.error('--max-age-hours must be a positive number'); process.exit(2); }

async function readJson(name: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(dir, name), 'utf8')); } catch (e) { return { unreadable: e instanceof Error ? e.message : String(e) }; }
}

const report = validateDataFiles(await readJson('elements.json'), await readJson('status.json'), { nowMs: Date.now(), maxDownloadAgeHours: maxAge });
for (const w of report.warnings) console.warn(`warning: ${w}`);
for (const p of report.problems) console.error(`PROBLEM: ${p}`);
if (report.problems.length > 0) { console.error(`Validation failed (${report.problems.length} problem(s)); nothing should be published.`); process.exit(1); }
console.log(`Validation passed (${report.warnings.length} warning(s)).`);
