import { describe, expect, it } from 'vitest';
import { ACTIVITIES } from '../src/catalog/catalog.ts';
import { assembleStatusFile, planWrites } from '../src/data/refresh.ts';
import type { StatusAttempt } from '../src/data/refresh.ts';
import { validateDataFiles } from '../src/data/validate.ts';
import { FIXTURE_DOWNLOAD_MS, elementsFixture, statusFixture } from './helpers.ts';

const keys = ACTIVITIES.map((a) => a.amsatStatusKey);
const allOk = (): Record<string, StatusAttempt> => Object.fromEntries(keys.map((k) => [k, { reports: [] }]));
const NOW = new Date('2026-11-13T12:00:00Z');

describe('status refresh is all-or-nothing', () => {
  it('builds a file, stamped with the time of the successful download, when every entry succeeded', () => {
    const r = assembleStatusFile(allOk(), keys, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.downloadedAt).toBe(NOW.toISOString());
      expect(Object.keys(r.file.satellites).sort()).toEqual([...keys].sort());
    }
  });
  it('produces NO file if a single request failed (so the previous file and its older time stay in place)', () => {
    const attempts = allOk();
    attempts[keys[3]!] = { error: 'HTTP 503' };
    const r = assembleStatusFile(attempts, keys, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed).toEqual([{ key: keys[3]!, error: 'HTTP 503' }]);
  });
  it('a missing entry also fails', () => {
    const attempts = allOk();
    delete attempts[keys[0]!];
    expect(assembleStatusFile(attempts, keys, NOW).ok).toBe(false);
  });
});

describe('what a refresh run writes', () => {
  const good = assembleStatusFile(allOk(), keys, NOW);
  const bad = assembleStatusFile({ ...allOk(), [keys[0]!]: { error: 'timeout' } }, keys, NOW);
  it('everything succeeded: both files, exit 0', () => {
    expect(planWrites(elementsFixture, good, true)).toMatchObject({ writeElements: true, writeStatus: true, exitCode: 0 });
  });
  it('elements failed: nothing written, exit 1', () => {
    expect(planWrites(null, null, false)).toMatchObject({ writeElements: false, writeStatus: false, exitCode: 1 });
  });
  it('local run, status failed: fresh elements are written, status is left alone, exit 0 with a warning', () => {
    const p = planWrites(elementsFixture, bad, false);
    expect(p).toMatchObject({ writeElements: true, writeStatus: false, exitCode: 0 });
    expect(p.messages.join(' ')).toMatch(/previous status file/);
  });
  it('strict (automation), status failed: NOTHING is written and the run fails, so no half-update can be published', () => {
    expect(planWrites(elementsFixture, bad, true)).toMatchObject({ writeElements: false, writeStatus: false, exitCode: 1 });
  });
});

describe('pre-publication validation', () => {
  const now = FIXTURE_DOWNLOAD_MS + 30 * 60_000; // 30 minutes after the (frozen, real) download
  const o = { nowMs: now, maxDownloadAgeHours: 3 };
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it('accepts a good pair of files', () => {
    expect(validateDataFiles(elementsFixture, statusFixture, o).problems).toEqual([]);
  });
  it('rejects a missing or malformed file', () => {
    expect(validateDataFiles(undefined, statusFixture, o).problems.join()).toMatch(/elements\.json/);
    expect(validateDataFiles(elementsFixture, { schema: 1 }, o).problems.join()).toMatch(/status\.json/);
    const bad = clone(statusFixture);
    (bad.satellites[keys[0]!] as { reports: unknown }).reports = 'oops';
    expect(validateDataFiles(elementsFixture, bad, o).problems.join()).toMatch(/malformed|no valid list/);
  });
  it('rejects data that is not fresh (the refresh did not actually run)', () => {
    const late = { nowMs: FIXTURE_DOWNLOAD_MS + 5 * 3_600_000, maxDownloadAgeHours: 3 };
    const r = validateDataFiles(elementsFixture, statusFixture, late);
    expect(r.problems.some((p) => /elements\.json: downloaded more than 3 hours ago/.test(p))).toBe(true);
    expect(r.problems.some((p) => /status\.json: downloaded more than 3 hours ago/.test(p))).toBe(true);
  });
  it('rejects a download time in the future or not a time', () => {
    const future = { ...clone(elementsFixture), downloadedAt: new Date(now + 3 * 3_600_000).toISOString() };
    expect(validateDataFiles(future, statusFixture, o).problems.join()).toMatch(/in the future/);
    expect(validateDataFiles({ ...clone(elementsFixture), downloadedAt: 'yesterday' }, statusFixture, o).problems.join()).toMatch(/not a valid time/);
  });
  it('rejects elements that lack a catalog satellite', () => {
    const e = clone(elementsFixture);
    e.sets = e.sets.slice(1);
    expect(validateDataFiles(e, statusFixture, o).problems.join()).toMatch(/no orbital data for/);
  });
  it('rejects a status file with a missing entry, a recorded error, or no reports at all', () => {
    const missing = clone(statusFixture);
    delete missing.satellites[keys[0]!];
    expect(validateDataFiles(elementsFixture, missing, o).problems.join()).toMatch(/no entry for/);
    const errored = clone(statusFixture);
    errored.satellites[keys[1]!]!.error = 'HTTP 500';
    expect(validateDataFiles(elementsFixture, errored, o).problems.join()).toMatch(/records a failed download/);
    const empty = clone(statusFixture);
    for (const k of Object.keys(empty.satellites)) empty.satellites[k]!.reports = [];
    expect(validateDataFiles(elementsFixture, empty, o).problems.join()).toMatch(/no reports at all/);
  });
  it('rejects a report dated in the future', () => {
    const f = clone(statusFixture);
    f.satellites[keys[0]!]!.reports.push([Math.floor(now / 1000) + 3600, 'H', 0]);
    expect(validateDataFiles(elementsFixture, f, o).problems.join()).toMatch(/dated in the future/);
  });
  it('an old element set is only a warning (the planner already skips it), not a reason to stop publishing', () => {
    const e = clone(elementsFixture);
    e.sets[0]!.epochMs = now - 90 * 86_400_000;
    const r = validateDataFiles(e, statusFixture, o);
    expect(r.problems).toEqual([]);
    expect(r.warnings.join()).toMatch(/days old/);
  });
});
