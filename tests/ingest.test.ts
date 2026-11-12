import { describe, expect, it } from 'vitest';
import { parseStatusReports, parseTleText, selectElements, tleChecksum, tleEpochMs, validTleLine } from '../src/data/ingest.ts';
import { elementsFixture, statusFixture } from './helpers.ts';

const ISS1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const ISS2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';

describe('TLE ingestion', () => {
  it('validates the classic published ISS example (checksums)', () => {
    expect(tleChecksum(ISS1)).toBe(2);
    expect(validTleLine(ISS1, 1)).toBe(true);
    expect(validTleLine(ISS2, 2)).toBe(true);
  });
  it('parses epoch to UTC ms (day-of-year 156.509 of 2019)', () => {
    expect(new Date(tleEpochMs(ISS1)).toISOString()).toBe('2019-06-05T12:12:58.000Z');
  });
  it('parses 3-line files and rejects corrupted entries instead of repairing them', () => {
    const bad = ISS1.slice(0, 68) + '3';
    const { records, rejected } = parseTleText(`ISS\n${ISS1}\n${ISS2}\nBROKEN\n${bad}\n${ISS2}\n`);
    expect(records).toHaveLength(1);
    expect(rejected.join(' ')).toMatch(/checksum/);
  });
  it('rejects entries whose two lines name different satellites', () => {
    const other = '2 25545' + ISS2.slice(7, 68);
    const line2 = other + String(tleChecksum(other + '0'));
    const { records, rejected } = parseTleText(`X\n${ISS1}\n${line2}\n`);
    expect(records).toHaveLength(0);
    expect(rejected.length).toBe(1);
  });
  it('keeps the newest epoch for a repeated ID and reports missing ones', () => {
    const { records } = parseTleText(`ISS\n${ISS1}\n${ISS2}\n`);
    const { sets, missing } = selectElements(records, [25544, 99999]);
    expect(sets).toHaveLength(1);
    expect(missing).toEqual([99999]);
  });
  it('the frozen real AMSAT fixture parses with valid checksums', () => {
    for (const s of elementsFixture.sets) {
      expect(validTleLine(s.line1, 1) && validTleLine(s.line2, 2), s.name).toBe(true);
    }
    expect(elementsFixture.missing).toEqual([]);
  });
});

describe('status API ingestion', () => {
  it('compacts reports, anonymises callsigns and sorts newest first', () => {
    const { reports, problems } = parseStatusReports({
      data: [
        { observation_time: '2026-11-12T10:00:00Z', report: 'Heard', callsign: 'aa1aa' },
        { observation_time: '2026-11-12T12:00:00Z', report: 'Not Heard', callsign: 'AA1AA' },
        { observation_time: '2026-11-12T11:00:00Z', report: 'Telemetry Only', callsign: 'BB2BB' },
      ],
    });
    expect(problems).toEqual([]);
    expect(reports.map((r) => r[1])).toEqual(['N', 'T', 'H']);
    expect(reports[0]![2]).toBe(reports[2]![2]); // same operator, case-insensitive
    expect(reports[1]![2]).not.toBe(reports[0]![2]);
    expect(JSON.stringify(reports)).not.toMatch(/AA1AA/i); // no callsigns stored
  });
  it('rejects unknown report values and malformed bodies rather than guessing', () => {
    const r = parseStatusReports({ data: [{ observation_time: '2026-11-12T10:00:00Z', report: 'Maybe', callsign: 'X' }, { report: 'Heard' }] });
    expect(r.reports).toEqual([]);
    expect(r.problems).toHaveLength(2);
    expect(parseStatusReports({ error: 'x' }).problems[0]).toMatch(/no "data"/);
    expect(parseStatusReports(null).reports).toEqual([]);
  });
  it('the frozen real status fixture has the expected shape', () => {
    expect(statusFixture.schema).toBe(1);
    expect(Object.keys(statusFixture.satellites)).toContain('SO-50_[FM]');
  });
});
