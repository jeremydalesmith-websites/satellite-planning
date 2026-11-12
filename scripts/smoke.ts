// Dev smoke test: runs the whole planning pipeline on the downloaded data and PRINTS every input and rule used.
//   node scripts/smoke.ts            (needs `npm run refresh-data` first)
// The location below is an arbitrary mid-latitude TEST location, not anyone's real location.
import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { ACTIVITIES } from '../src/catalog/catalog.ts';
import { addDays, emptyAvailability, formatMinutes, localDate, mergedDayRanges, rangeFromDates, WEEKDAY_LABELS } from '../src/availability/availability.ts';
import * as P from '../src/domain/policy.ts';
import { predictAll } from '../src/orbit/predict.ts';
import { computePlan, predictionThresholds, usableElements } from '../src/planner.ts';

const elements = JSON.parse(readFileSync(new URL('../public/data/elements.json', import.meta.url), 'utf8'));
const status = JSON.parse(readFileSync(new URL('../public/data/status.json', import.meta.url), 'utf8'));

// ---- inputs ----
const observer = { latDeg: 42.0, lonDeg: -71.5, heightKm: 0 };
const tz = 'America/New_York';
const now = Date.now();
const av = emptyAvailability();
for (const p of ['midday', 'evening'] as const) { av.selected[p][0] = true; av.selected[p][6] = true; } // Sun, Sat
av.selected.evening[2] = true; av.selected.evening[4] = true;                                          // Tue, Thu
const s = localDate(now, tz);
const { range } = rangeFromDates(s, addDays(s, 27, tz), tz, now);
const base = { minElevationDeg: 40, maxSpanMin: 150 };
const f = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc LLL d HH:mm');
const f2 = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc LLL d HH:mm:ss');

console.log('=== INPUTS ===');
console.log(`run at (UTC)        : ${new Date(now).toISOString()}`);
console.log(`location            : ${observer.latDeg}, ${observer.lonDeg} (height 0 m)`);
console.log(`timezone            : ${tz}`);
console.log(`date range (local)  : ${f(range!.start)} -> ${f(range!.end)}  (28 days)`);
console.log(`min peak elevation  : ${base.minElevationDeg} deg   event duration: ${base.maxSpanMin / 60} h`);
console.log('availability (merged local ranges):');
WEEKDAY_LABELS.forEach((d, i) => { const r = mergedDayRanges(av, i); if (r.length) console.log(`   ${d.padEnd(9)} ${r.map(([a, b]) => `${formatMinutes(a)}-${formatMinutes(b)}`).join(', ')}`); });
const { usable, skipped } = usableElements(elements, now);
console.log(`satellites          : ${usable.length} of ${ACTIVITIES.length} catalog FM repeaters used`);
skipped.forEach((k) => console.log(`   skipped ${k.name}: ${k.reason}`));
console.log(`orbital data downloaded: ${elements.downloadedAt}`);
console.log(`status data downloaded : ${status.downloadedAt}`);
const ep = usable.map((u: { epochMs: number }) => u.epochMs);
console.log(`element epochs         : ${new Date(Math.min(...ep)).toISOString()} .. ${new Date(Math.max(...ep)).toISOString()}`);
console.log('status rules: window', P.STATUS_WINDOW_HOURS, 'h; "not working" needs >=', P.UNAVAILABLE_MIN_REPORTS, 'negatives from >=', P.UNAVAILABLE_MIN_CALLSIGNS, 'operators and no positive;',
  'a newer negative after a positive = mixed (not counted); only "recently reported active" counts; element age limit', P.MAX_ELEMENT_AGE_DAYS, 'd');

const run = predictAll(usable, observer, range!.start, range!.end, { thresholdsDeg: predictionThresholds(base.minElevationDeg) });
const mk = (minOpportunities: number) =>
  computePlan({ observer, timeZone: tz, criteria: { ...base, minOpportunities }, availability: av, range: range! }, { elements, status }, run.passes, run.errors, skipped, now);

const plan3 = mk(3);
console.log('\n=== PER-SATELLITE STATUS (the strict rules applied to today\'s reports) ===');
const seen = new Set<number>();
for (const a of plan3.assessments) {
  if (seen.has(a.noradId)) continue; seen.add(a.noradId);
  const st = a.status;
  console.log(`${a.name.padEnd(9)} ${st.state.padEnd(25)} +${String(st.positives).padStart(2)} -${String(st.negatives).padStart(2)}  ${st.explanation}`);
}
console.log('\n=== OPPORTUNITIES BY SATELLITE (passes reaching the threshold in the 28 days) ===');
const by: Record<string, Record<string, number>> = {};
for (const a of plan3.assessments) {
  if (a.exclusion === 'below-threshold') continue;
  const r = a.verdict === 'excluded' ? `excluded:${a.exclusion}` : a.verdict;
  (by[a.name] ??= {})[r] = (by[a.name]![r] ?? 0) + 1;
}
console.table(by);

for (const n of [3, 2]) {
  const plan = n === 3 ? plan3 : mk(2);
  console.log(`\n=== RESULT with ${n} opportunities required: ${plan.windows.length} clusters ===`);
  for (const w of plan.windows) {
    console.log(`${f(w.window.start)} -> ${DateTime.fromMillis(w.window.end, { zone: tz }).toFormat('HH:mm')}  count=${w.counted.length} satellites=${w.distinctSatellites} cluster ${((w.window.end - w.window.start) / 60000).toFixed(1)} min`);
    for (const c of w.counted) console.log(`     counted  ${c.name.padEnd(8)} ${f2(c.riseMs)}-${f2(c.setMs)}  peak ${c.fullMaxElevationDeg.toFixed(0)} deg`);
  }
}
