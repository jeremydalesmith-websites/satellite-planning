import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElementsFile, StatusFile } from '../src/data/ingest.ts';
import type { ElementSet, Observer } from '../src/domain/types.ts';

/** Real AMSAT downloads from 2026-11-12, frozen. Clearly fixtures, not production data. */
export const elementsFixture: ElementsFile = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/elements-2026-11-12.json'), 'utf8'),
);
export const statusFixture: StatusFile = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/status-2026-11-12.json'), 'utf8'),
);

export const FIXTURE_DOWNLOAD_MS = Date.parse(elementsFixture.downloadedAt);

export function el(noradId: number): ElementSet {
  const s = elementsFixture.sets.find((x) => x.noradId === noradId);
  if (!s) throw new Error(`fixture lacks ${noradId}`);
  return s;
}

/** Arbitrary mid-latitude test location (not anyone's real location). */
export const TEST_OBSERVER: Observer = { latDeg: 42.0, lonDeg: -71.5, heightKm: 0 };
