/**
 * Test-only preload (node --import) that replaces fetch for scripts/refresh-data.ts, so its failure paths can be run for
 * real without the network. STUB_MODE chooses the scenario:
 *   ok                 everything succeeds, two recent "Heard" reports per repeater
 *   status-empty       every status answer is a valid {"data": []}
 *   status-one-empty   one repeater answers {"data": []}, the rest succeed
 *   status-503         one repeater's request fails with HTTP 503
 *   status-malformed   one repeater answers with a body that has no "data" array
 *   status-unreadable  one repeater answers rows that cannot be read
 *   status-future      succeeds, but one report is dated in the future (the validator must refuse it)
 *   elements-fail      the orbital download fails
 *   status-hang        status requests never answer (they only end when their abort signal fires)
 *   elements-hang      the orbital request never answers
 */
import { readFileSync } from 'node:fs';
import { tleChecksum } from '../../src/data/ingest.ts';

const mode = process.env.STUB_MODE ?? 'ok';
const elements = JSON.parse(readFileSync(new URL('../fixtures/elements-2026-11-12.json', import.meta.url), 'utf8'));
const BAD = 'ISS_[FM]'; // the repeater that misbehaves in the single-failure scenarios

/** A 3-line-element file: the fixture sets plus a few valid extras (the script refuses a download with under 20 sets). */
function tleText() {
  const out = [];
  const withNumber = (line, n) => {
    const body = line.slice(0, 2) + String(n).padStart(5, '0') + line.slice(7, 68);
    return body + String(tleChecksum(body));
  };
  for (const s of elements.sets) out.push(s.name, s.line1, s.line2);
  for (let k = 0; k < 6; k++) out.push(`EXTRA-${k}`, withNumber(elements.sets[0].line1, 90000 + k), withNumber(elements.sets[0].line2, 90000 + k));
  return out.join('\n') + '\n';
}

const respond = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

/** A request that never answers; it ends only when the caller aborts it, like a stalled connection. */
const hang = (signal) => new Promise((_, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  // A real stalled connection keeps the process alive; AbortSignal timers do not, so hold the event loop open until aborted.
  const keepAlive = setInterval(() => {}, 1000);
  signal?.addEventListener('abort', () => { clearInterval(keepAlive); reject(signal.reason); });
});

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (mode === 'elements-hang' && url.includes('nasabare')) return hang(init?.signal);
  if (mode === 'status-hang' && url.includes('reports.php')) return hang(init?.signal);
  if (url.includes('nasabare')) return mode === 'elements-fail' ? respond('down', 503) : respond(tleText());
  if (url.includes('reports.php')) {
    const key = new URL(url).searchParams.get('name');
    const row = (report, t) => ({ name: key, norad_cat_id: null, report, observation_time: new Date(t).toISOString(), callsign: 'N0CALL' });
    const now = Date.now();
    if (mode === 'status-empty') return respond({ data: [] });
    if (key === BAD) {
      if (mode === 'status-one-empty') return respond({ data: [] });
      if (mode === 'status-503') return respond('unavailable', 503);
      if (mode === 'status-malformed') return respond({ error: 'something else' });
      if (mode === 'status-unreadable') return respond({ data: [{ name: key, report: 'Maybe', observation_time: 'later' }] });
    }
    const rows = [row('Heard', now - 3_600_000), row('Not Heard', now - 7_200_000)];
    if (mode === 'status-future' && key === BAD) rows.push(row('Heard', now + 6 * 3_600_000));
    return respond({ data: rows });
  }
  return respond('unexpected url in test: ' + url, 404);
};
