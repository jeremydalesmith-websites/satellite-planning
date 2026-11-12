/**
 * Data ingestion: pure parsing/validation of the two public sources.
 * No network and no DOM here, so the refresh script and the tests share it.
 *
 *  - AMSAT orbital elements: plain-text 3-line TLE file (name, line 1, line 2).
 *  - AMSAT satellite-status API (status.amsat.org/api/v1): JSON, documented OpenAPI.
 */

export type ReportCode = 'H' | 'T' | 'N' | 'C';

export interface ElementRecord {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  epochMs: number;
}

export interface ElementsFile {
  schema: 1;
  source: { name: string; url: string };
  /** When this app's refresh job downloaded the file (ISO 8601 UTC). */
  downloadedAt: string;
  sets: ElementRecord[];
  /** Catalog satellites absent from the download. */
  missing: number[];
}

/** One report: [observed epoch seconds, code, anonymous callsign index within this file]. */
export type CompactReport = [number, ReportCode, number];

export interface StatusFile {
  schema: 1;
  source: { name: string; url: string; license: string };
  downloadedAt: string;
  /** Keyed by AMSAT status key, e.g. "SO-50_[FM]". */
  satellites: Record<string, { reports: CompactReport[]; error?: string }>;
}

/* ------------------------------------------------------------------ TLE */

/** Standard TLE modulo-10 checksum: digits count, '-' counts 1, others 0. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i] ?? ' ';
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

export function validTleLine(line: string, n: 1 | 2): boolean {
  if (line.length !== 69 || line[0] !== String(n) || line[1] !== ' ') return false;
  const check = line.charCodeAt(68) - 48;
  return check === tleChecksum(line);
}

/** Epoch from TLE line 1 columns 19–32 (YYDDD.DDDDDDDD) to UTC ms. */
export function tleEpochMs(line1: string): number {
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) throw new Error('Bad TLE epoch');
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
}

export interface TleParseResult {
  records: ElementRecord[];
  /** Human-readable problems with entries that were skipped. */
  rejected: string[];
}

/** Parse a 3-line-element file. Malformed entries are rejected, never repaired. */
export function parseTleText(text: string): TleParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const records: ElementRecord[] = [];
  const rejected: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (l1 !== undefined && l2 !== undefined && l1.startsWith('1 ') && l2.startsWith('2 ')) {
      const name = lines[i]!.trim();
      if (!validTleLine(l1, 1) || !validTleLine(l2, 2)) {
        rejected.push(`${name}: failed TLE format/checksum validation`);
      } else if (l1.slice(2, 7) !== l2.slice(2, 7)) {
        rejected.push(`${name}: catalog numbers differ between lines`);
      } else {
        records.push({
          noradId: Number(l1.slice(2, 7)),
          name,
          line1: l1,
          line2: l2,
          epochMs: tleEpochMs(l1),
        });
      }
      i += 3;
    } else {
      rejected.push(`Unrecognised line near "${lines[i]!.slice(0, 30)}"`);
      i += 1;
    }
  }
  return { records, rejected };
}

/** Keep only wanted catalog IDs; if an ID repeats, keep the newest epoch. */
export function selectElements(
  records: readonly ElementRecord[],
  wanted: readonly number[],
): { sets: ElementRecord[]; missing: number[] } {
  const best = new Map<number, ElementRecord>();
  for (const r of records) {
    if (!wanted.includes(r.noradId)) continue;
    const cur = best.get(r.noradId);
    if (!cur || r.epochMs > cur.epochMs) best.set(r.noradId, r);
  }
  return {
    sets: wanted.flatMap((id) => (best.has(id) ? [best.get(id)!] : [])),
    missing: wanted.filter((id) => !best.has(id)),
  };
}

/* ------------------------------------------------------------------ status API */

const CODE_BY_LABEL: Record<string, ReportCode> = {
  Heard: 'H',
  'Telemetry Only': 'T',
  'Not Heard': 'N',
  'Crew Active': 'C',
};

export interface StatusParseResult {
  reports: CompactReport[];
  problems: string[];
}

/**
 * Convert the body of GET /api/v1/reports.php into compact reports.
 * Expected shape (verified against the live API, v1.4):
 *   { data: [ { observation_time: ISO, report: "Heard"|..., callsign: string, ... } ], meta: {...} }
 * Unrecognised report values are rejected (recorded in `problems`), never guessed.
 */
export function parseStatusReports(body: unknown): StatusParseResult {
  const problems: string[] = [];
  const reports: CompactReport[] = [];
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return { reports, problems: ['Response has no "data" array'] };
  }
  const callers = new Map<string, number>();
  for (const row of data) {
    const r = row as { observation_time?: unknown; report?: unknown; callsign?: unknown };
    const code = typeof r.report === 'string' ? CODE_BY_LABEL[r.report] : undefined;
    const t = typeof r.observation_time === 'string' ? Date.parse(r.observation_time) : NaN;
    if (!code || !Number.isFinite(t)) {
      problems.push(`Skipped unreadable report: ${JSON.stringify(row).slice(0, 80)}`);
      continue;
    }
    const call = typeof r.callsign === 'string' ? r.callsign.toUpperCase() : '?';
    if (!callers.has(call)) callers.set(call, callers.size);
    reports.push([Math.floor(t / 1000), code, callers.get(call)!]);
  }
  reports.sort((a, b) => b[0] - a[0]);
  return { reports, problems };
}
