/**
 * Cluster finder: fixed-length event windows inside availability that contain
 * enough qualifying pass opportunities.
 *
 * THE OVERLAP RULE (conservative, one operating station):
 *   Each eligible pass contributes one *operating interval* (see eligibility/assess.ts).
 *   Within a window we count the LARGEST SET OF PAIRWISE NON-OVERLAPPING operating
 *   intervals (touching end-to-start is allowed; there is no setup gap). Among sets
 *   of equal size we prefer more total operating time, then higher summed
 *   maximum elevations. Overlapping passes are NOT dropped from the output: they
 *   are reported as "alternatives" so the user can see them.
 *
 * A pass counts in a window only if its WHOLE operating interval lies inside the
 * window, so a sliver at the edge of the event never inflates the count.
 *
 * Ranking: (1) number of opportunities, (2) total operating time, (3) summed
 * eligible maximum elevations, (4) earlier start. No opaque score.
 */
import { WINDOW_SIMILARITY_OVERLAP, RESULT_LIMIT, START_ALIGNMENT_MIN } from '../domain/policy.ts';
import { contains, overlapMs, overlaps, duration } from '../domain/intervals.ts';
import type { Interval, Ms } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';

interface Opp {
  a: PassAssessment;
  iv: Interval;
}

type Score = [count: number, timeMs: number, sumEl: number];

function better(x: Score, y: Score): boolean {
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  }
  return false;
}

/**
 * Optimal selection of pairwise non-overlapping operating intervals
 * (weighted interval scheduling, lexicographic objective).
 * Returns the chosen assessments in time order.
 */
export function selectNonOverlapping(list: readonly PassAssessment[]): PassAssessment[] {
  const opps: Opp[] = list
    .filter((a): a is PassAssessment & { operating: Interval } => a.operating !== null)
    .map((a) => ({ a, iv: a.operating! }))
    .sort((p, q) => p.iv.end - q.iv.end || p.iv.start - q.iv.start);
  const n = opps.length;
  if (n === 0) return [];
  // pred[i] = last index j < i with end_j <= start_i (or -1)
  const pred: number[] = opps.map((o, i) => {
    let lo = 0;
    let hi = i - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (opps[mid]!.iv.end <= o.iv.start) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  });
  const best: Score[] = [[0, 0, 0]];
  const take: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const o = opps[i]!;
    const prev = best[pred[i]! + 1]!;
    const withIt: Score = [
      prev[0] + 1,
      prev[1] + duration(o.iv),
      prev[2] + (o.a.eligibleMaxElevationDeg ?? 0),
    ];
    const without = best[i]!;
    if (better(withIt, without)) {
      best.push(withIt);
      take.push(true);
    } else {
      best.push(without);
      take.push(false);
    }
  }
  const chosen: PassAssessment[] = [];
  for (let i = n - 1; i >= 0; ) {
    if (take[i]) {
      chosen.push(opps[i]!.a);
      i = pred[i]!;
    } else i--;
  }
  return chosen.reverse();
}

export interface WindowEvaluation {
  window: Interval;
  /** The counted, mutually non-overlapping opportunities, in time order. */
  counted: PassAssessment[];
  /** Eligible passes inside the window that overlap a counted pass (not counted). */
  alternatives: PassAssessment[];
  /** Eligible passes whose operating interval crosses the window edge (not counted). */
  edge: PassAssessment[];
  /**
   * Passes of eligible satellites excluded for eclipse. Passes of satellites lacking a qualifying
   * recent FM report (exclusion 'status') are dropped here and never appear in any list or count.
   */
  excluded: PassAssessment[];
  totalOperatingMs: number;
  distinctSatellites: number;
  sumEligibleMaxElevationDeg: number;
}

/** Evaluate one fixed window. Used both for searching and for re-checking saved events. */
export function evaluateWindow(window: Interval, all: readonly PassAssessment[]): WindowEvaluation {
  const inside: PassAssessment[] = [];
  const edge: PassAssessment[] = [];
  const excluded: PassAssessment[] = [];
  for (const a of all) {
    if (a.riseMs >= window.end || a.setMs <= window.start) continue; // pass does not touch the window
    if (a.verdict === 'excluded') {
      if (a.exclusion === 'eclipse') excluded.push(a); // 'status' and 'below-threshold' are never shown
      continue;
    }
    if (!a.operating) continue;
    if (contains(window, a.operating)) {
      inside.push(a);
    } else if (overlaps(window, a.operating)) {
      edge.push(a);
    }
  }
  const counted = selectNonOverlapping(inside);
  const countedIds = new Set(counted.map((c) => c.passId));
  const alternatives = inside.filter((a) => !countedIds.has(a.passId));
  const byStart = (x: PassAssessment, y: PassAssessment) => x.operating!.start - y.operating!.start;
  return {
    window,
    counted,
    alternatives: alternatives.sort(byStart),
    edge: edge.sort((x, y) => x.riseMs - y.riseMs),
    excluded: excluded.sort((x, y) => x.riseMs - y.riseMs),
    totalOperatingMs: counted.reduce((s, c) => s + duration(c.operating!), 0),
    distinctSatellites: new Set(counted.map((c) => c.noradId)).size,
    sumEligibleMaxElevationDeg: counted.reduce((s, c) => s + (c.eligibleMaxElevationDeg ?? 0), 0),
  };
}

export interface EventWindow extends WindowEvaluation {
  /** How many other, substantially overlapping windows were folded into this one. */
  similarWindows: number;
}

function compareWindows(a: WindowEvaluation, b: WindowEvaluation): number {
  return (
    b.counted.length - a.counted.length ||
    b.totalOperatingMs - a.totalOperatingMs ||
    b.sumEligibleMaxElevationDeg - a.sumEligibleMaxElevationDeg ||
    a.window.start - b.window.start
  );
}

/** Pick a tidy start time within [lo, hi]: nearest alignment boundary to the centre, else the centre. */
export function tidyStart(lo: Ms, hi: Ms, alignMin = START_ALIGNMENT_MIN): Ms {
  const step = alignMin * 60_000;
  const centre = (lo + hi) / 2;
  const g = Math.round(centre / step) * step;
  const candidates = [g, g - step, g + step].filter((c) => c >= lo && c <= hi);
  if (candidates.length) return candidates.reduce((x, y) => (Math.abs(x - centre) <= Math.abs(y - centre) ? x : y));
  // No aligned time fits: use the centre, rounded to a second but never outside [lo, hi].
  return Math.min(hi, Math.max(lo, Math.round(centre / 1000) * 1000));
}

export interface FindOptions {
  durationMin: number;
  minOpportunities: number;
  limit?: number;
}

/**
 * Find ranked, consolidated event windows.
 * @param availability normalized absolute intervals (the ONLY availability input)
 */
export function findEventWindows(
  all: readonly PassAssessment[],
  availability: readonly Interval[],
  opts: FindOptions,
): EventWindow[] {
  const D = opts.durationMin * 60_000;
  const eligible = all.filter((a) => a.verdict === 'eligible' && a.operating);

  // Group candidate windows by (availability block, set of counted passes).
  const groups = new Map<string, { block: Interval; ev: WindowEvaluation }>();
  availability.forEach((block, bi) => {
    if (block.end - block.start < D) return;
    const lo = block.start;
    const hi = block.end - D;
    const starts = new Set<Ms>([lo, hi]);
    for (const a of eligible) {
      const o = a.operating!;
      if (o.end <= block.start || o.start >= block.end) continue;
      starts.add(Math.min(hi, Math.max(lo, o.start)));
      starts.add(Math.min(hi, Math.max(lo, o.end - D)));
    }
    for (const s of starts) {
      const ev = evaluateWindow({ start: s, end: s + D }, all);
      if (ev.counted.length < opts.minOpportunities) continue;
      const key = bi + '|' + ev.counted.map((c) => c.passId).join(',');
      if (!groups.has(key)) groups.set(key, { block, ev });
    }
  });

  // Canonicalise each group: one tidy window that still contains the whole set.
  const canon: WindowEvaluation[] = [];
  for (const { block, ev } of groups.values()) {
    const minStart = Math.min(...ev.counted.map((c) => c.operating!.start));
    const maxEnd = Math.max(...ev.counted.map((c) => c.operating!.end));
    const lo = Math.max(block.start, maxEnd - D);
    const hi = Math.min(block.end - D, minStart);
    const s = lo <= hi ? tidyStart(lo, hi) : ev.window.start;
    const re = evaluateWindow({ start: s, end: s + D }, all);
    // Keep the tidy window only if it is still entirely inside the availability block and
    // still counts at least as many passes; otherwise keep the (valid) searched window.
    const inBlock = re.window.start >= block.start && re.window.end <= block.end;
    canon.push(inBlock && re.counted.length >= ev.counted.length ? re : ev);
  }

  // Rank, then fold windows that substantially overlap a better one into it.
  canon.sort(compareWindows);
  const kept: EventWindow[] = [];
  for (const w of canon) {
    const host = kept.find((k) => overlapMs(k.window, w.window) >= WINDOW_SIMILARITY_OVERLAP * D);
    if (host) host.similarWindows++;
    else kept.push({ ...w, similarWindows: 0 });
  }
  return kept.slice(0, opts.limit ?? RESULT_LIMIT);
}
