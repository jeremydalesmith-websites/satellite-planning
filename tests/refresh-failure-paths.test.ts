import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { StatusFile } from '../src/data/ingest.ts';
import { evaluateEligibility } from '../src/eligibility/eligibility.ts';

/**
 * The REAL scripts (refresh-data.ts, validate-data.ts) run as child processes with a stubbed fetch (tests/helpers/fetch-stub.mjs).
 * Scenario: "published" files sit in a site folder; the update workflow is  refresh --strict  ->  validate  ->  publish (copy).
 * Each step runs only if the previous one exited 0, exactly as GitHub Actions stops a job at its first failed step. These tests
 * show that when ANY step fails, both published data files are byte-for-byte unchanged, and the scratch files are not touched.
 */
const root = process.cwd();
const stub = pathToFileURL(join(root, 'tests/helpers/fetch-stub.mjs')).href;
const work = mkdtempSync(join(tmpdir(), 'refresh-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const FILES = ['elements.json', 'status.json'] as const;
const OLD_ELEMENTS = JSON.stringify({ schema: 1, source: { name: 'old', url: 'u' }, downloadedAt: '2026-01-01T00:00:00.000Z', sets: [], missing: [] });
const OLD_STATUS = JSON.stringify({ schema: 1, source: { name: 'old', url: 'u', license: 'x' }, downloadedAt: '2026-01-01T00:00:00.000Z', satellites: {} });
let n = 0;
function folders() {
  const scratch = join(work, `scratch${n}`);
  const site = join(work, `site${n++}`);
  for (const d of [scratch, site]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'elements.json'), OLD_ELEMENTS);
    writeFileSync(join(d, 'status.json'), OLD_STATUS);
  }
  return { scratch, site };
}
const read = (d: string) => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(d, f), 'utf8')]));

function run(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--import', stub, join(root, 'scripts', script), ...args], {
    env: { ...process.env, SAT_PLANNER_RETRY_MS: '0', SAT_PLANNER_SPACING_MS: '0', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** refresh --strict, then validate, then publish; stops at the first failure. Returns where it stopped. */
function workflow(mode: string) {
  const { scratch, site } = folders();
  const before = { scratch: read(scratch), site: read(site) };
  const env = { STUB_MODE: mode, SAT_PLANNER_DATA_DIR: scratch };
  const startedAt = Date.now();
  let stoppedAt: string | null = null;
  const refresh = run('refresh-data.ts', ['--strict'], env);
  if (refresh.code !== 0) stoppedAt = 'refresh';
  const validate = stoppedAt ? null : run('validate-data.ts', [scratch], env);
  if (!stoppedAt && validate!.code !== 0) stoppedAt = 'validate';
  if (!stoppedAt) for (const f of FILES) copyFileSync(join(scratch, f), join(site, f)); // the publication step
  return { scratch, site, before, after: { scratch: read(scratch), site: read(site) }, stoppedAt, refresh, validate, startedAt };
}

describe('strict refresh + validation: a failure leaves both published data files unchanged', () => {
  for (const [mode, stop, why] of [
    ['status-503', 'refresh', 'a status request fails (HTTP 503)'],
    ['status-malformed', 'refresh', 'a status response is malformed (no data array)'],
    ['status-unreadable', 'refresh', 'a status response has rows that cannot be read'],
    ['elements-fail', 'refresh', 'the orbital download fails'],
    ['status-future', 'validate', 'validation fails (a report dated in the future)'],
  ] as const) {
    it(`${why}: the run stops at ${stop}; published and scratch files are byte-identical to before`, () => {
      const r = workflow(mode);
      expect(r.stoppedAt).toBe(stop);
      expect(r.after.site).toEqual(r.before.site); // the published pair is untouched
      if (stop === 'refresh') expect(r.after.scratch).toEqual(r.before.scratch); // strict: nothing written at all, not even fresh elements
      expect(readdirSync(r.scratch).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no half-written temporary files left
    }, 90_000);
  }

  it('everything succeeds: both files are replaced, with timestamps from this run', () => {
    const r = workflow('ok');
    expect(r.stoppedAt).toBeNull();
    expect(r.refresh.code).toBe(0);
    for (const f of FILES) {
      const d = Date.parse((JSON.parse(r.after.site[f]!) as { downloadedAt: string }).downloadedAt);
      expect(d).toBeGreaterThanOrEqual(r.startedAt - 1000);
      expect(d).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(r.after.site).toEqual(r.after.scratch);
  }, 90_000);

  it('the timestamp is never advanced by a failed status download, even in the non-strict local run', () => {
    const { scratch } = folders();
    const r = run('refresh-data.ts', [], { STUB_MODE: 'status-503', SAT_PLANNER_DATA_DIR: scratch });
    expect(r.code).toBe(0); // local `npm start` still works with fresh orbital data
    expect(readFileSync(join(scratch, 'status.json'), 'utf8')).toBe(OLD_STATUS); // old file, old time
    expect((JSON.parse(readFileSync(join(scratch, 'elements.json'), 'utf8')) as { downloadedAt: string }).downloadedAt).not.toBe('2026-01-01T00:00:00.000Z');
  }, 90_000);
});

describe('"no reports" is a valid answer, not a failure', () => {
  it('one repeater with no reports does not block the update; it stays ineligible and the others keep their data', () => {
    const r = workflow('status-one-empty');
    expect(r.stoppedAt).toBeNull();
    const status = JSON.parse(r.after.site['status.json']!) as StatusFile;
    expect(status.satellites['ISS_[FM]']).toEqual({ reports: [] });
    expect(status.satellites['SO-50_[FM]']!.reports.length).toBeGreaterThan(0);
    const e = Object.fromEntries(evaluateEligibility(status, Date.now()).map((x) => [x.name, x]));
    expect(e['ISS']!.eligible).toBe(false); // no "Heard" report: not considered
    expect(e['SO-50']!.eligible).toBe(true);
    expect(Date.parse(status.downloadedAt)).toBeGreaterThanOrEqual(r.startedAt - 1000); // an accurate, current download time
  }, 90_000);
  it('even when EVERY repeater has no reports the update succeeds (validation only warns); nothing is eligible', () => {
    const r = workflow('status-empty');
    expect(r.stoppedAt).toBeNull();
    expect(r.validate!.out).toMatch(/no reports at all/);
    const status = JSON.parse(r.after.site['status.json']!) as StatusFile;
    expect(evaluateEligibility(status, Date.now()).every((x) => !x.eligible)).toBe(true);
  }, 90_000);
});
