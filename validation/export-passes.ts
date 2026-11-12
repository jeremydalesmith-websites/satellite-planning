// Export this app's predictions (JSON) for comparison with an independent predictor.
//   node validation/export-passes.ts <elements.json> <lat> <lon> <startISO> <days> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { findPasses } from '../src/orbit/predict.ts';

const [file, lat, lon, startIso, days, out] = process.argv.slice(2) as [string, string, string, string, string, string];
const elements = JSON.parse(readFileSync(file, 'utf8'));
const start = Date.parse(startIso);
const end = start + Number(days) * 86_400_000;
const result: Record<string, unknown[]> = {};
for (const s of elements.sets) {
  if (![25544, 27607, 43017, 61781, 40908, 63217].includes(s.noradId)) continue;
  result[s.noradId] = findPasses(s, { latDeg: Number(lat), lonDeg: Number(lon), heightKm: 0 }, start, end, { thresholdsDeg: [10] }).map((p) => ({
    rise: p.riseMs, peak: p.peakMs, set: p.setMs, maxEl: p.maxElevationDeg, sun: p.sunSegments.map((x) => [x.start, x.end, x.lit]),
  }));
}
writeFileSync(out, JSON.stringify({ lat: Number(lat), lon: Number(lon), start, end, passes: result }));
