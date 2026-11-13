/**
 * Cluster finder: groups of qualifying FM passes that fit within a maximum span, inside one availability block.
 *
 * MODEL (see README "How passes are counted"):
 *  - A pass is selected by its MAXIMUM elevation (during a sunlit portion for sunlight-dependent repeaters).
 *  - Its envelope is the FULL pass, AOS to LOS above the 0° horizon. The envelope drives everything below.
 *  - A cluster is a set of counted passes. Its bounds are the earliest AOS and the latest LOS among them, so its
 *    duration is the elapsed time between those endpoints, gaps included. Nothing is padded or buffered.
 *  - The cluster must satisfy BOTH: (span <= the user's maximum span) and (the whole envelope inside ONE
 *    availability block). The selected hours are a limit, never a required or padded event duration.
 *
 * ONE-STATION OVERLAP RULE (conservative): two passes conflict if their full AOS-to-LOS envelopes overlap
 * (touching end-to-start is allowed; there is no setup gap). We count the LARGEST SET of pairwise
 * non-overlapping passes. Among equal counts we prefer more total permitted operating time (eclipsed time is
 * never part of it), then a higher sum of maximum elevations. Counted passes never overlap, so no time is
 * double-counted. Overlapping qualifying passes inside the cluster are listed as alternatives, not hidden.
 * This is conservative: two passes that overlap only at low elevation are not counted together.
 *
 * SINGLE-PASS MODE (minimum passes = 1): there is no cluster to build, so every qualifying pass is its own result (its own
 * AOS-to-LOS is the window), ordered by the user-selected sort (Date, soonest first, by default; Elevation, highest first, with
 * the earlier AOS breaking ties; see SORTING). The maximum span does not apply. All other rules (selection by peak, sunlight, eligibility, availability fit) are unchanged.
 *
 * SORTING (user-selected; the default is Date). The sort never changes which results exist, only their order, and it is
 * applied to the COMPLETE candidate list BEFORE the display limit, so the limit always keeps the true first N:
 *   Date:       soonest start first (ties: more passes, then higher lowest-elevation).
 *   Elevation:  highest first. A pass's elevation is the maximum reached while operation is permitted. A cluster is
 *               scored by the LOWEST of those among its counted passes ("consistently high"). Ties: earlier start.
 *   Pass count: most counted passes first (clusters only). Ties: earlier start.
 * Candidate generation: every cluster is built around its EARLIEST pass (the anchor, always counted), for each possible end
 * time, and keeps the frontier over (number of passes, lowest elevation) for that start and end: the biggest set, and each
 * smaller set whose lowest elevation is strictly higher. Start time is never traded away: an earlier cluster is never dropped
 * because a later one has at least as many passes and as high an elevation (that pruning once hid the earliest cluster from
 * Date order), and the best Elevation result is never hidden behind a bigger set (a pair of 80 and 75 degree passes behind a
 * three-pass set containing a 45 degree pass). The cost is anchors x ends x distinct elevations, not every subset of passes;
 * tests/sorting-oracle.test.ts compares the first result of every sort with an exhaustive enumeration. Exact duplicates are
 * removed; distinct counted sets are all kept.
 */
import { RESULT_LIMIT, SAVED_EDGE_TOLERANCE_SEC, SINGLE_PASS_RESULT_LIMIT } from '../domain/policy.ts';
import { contains } from '../domain/intervals.ts';
import type { Interval } from '../domain/types.ts';
import type { PassAssessment } from '../eligibility/assess.ts';

type Score = [count: number, timeMs: number, sumEl: number];

function better(x: Score, y: Score): boolean {
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  }
  return false;
}

/** True when two passes' full AOS-to-LOS envelopes overlap (touching is not an overlap). */
export const envelopesOverlap = (a: Pick<PassAssessment, 'riseMs' | 'setMs'>, b: Pick<PassAssessment, 'riseMs' | 'setMs'>): boolean =>
  a.riseMs < b.setMs && b.riseMs < a.setMs;

/**
 * Optimal selection of pairwise non-overlapping FULL passes (weighted interval scheduling, lexicographic
 * objective: count, then permitted operating time, then summed eligible maximum elevations).
 * Returns the chosen assessments in time order.
 */
export function selectNonOverlapping(list: readonly PassAssessment[]): PassAssessment[] {
  const opps = list
    .filter((a) => a.operatingIntervals.length > 0)
    .sort((p, q) => p.setMs - q.setMs || p.riseMs - q.riseMs);
  const n = opps.length;
  if (n === 0) return [];
  // pred[i] = last index j < i with LOS_j <= AOS_i (or -1)
  const pred: number[] = opps.map((o, i) => {
    let lo = 0;
    let hi = i - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (opps[mid]!.setMs <= o.riseMs) {
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
    const withIt: Score = [prev[0] + 1, prev[1] + o.operatingMs, prev[2] + (o.eligibleMaxElevationDeg ?? 0)];
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
      chosen.push(opps[i]!);
      i = pred[i]!;
    } else i--;
  }
  return chosen.reverse();
}

export interface WindowEvaluation {
  /**
   * The cluster interval: earliest full-pass AOS to latest full-pass LOS among the counted passes. For a fixed
   * saved event it is the saved interval instead.
   */
  window: Interval;
  /** The counted, mutually non-overlapping passes, in time order. */
  counted: PassAssessment[];
  /** Qualifying passes fully inside the window that overlap a counted pass (one station: not counted). */
  alternatives: PassAssessment[];
  /**
   * Qualifying passes that overlap the window without lying fully inside it. Only meaningful for a FIXED saved
   * interval (drift / out-of-window warnings); always empty for search results, which have no fixed window.
   */
  edge: PassAssessment[];
  /** Passes of eligible satellites excluded because the elevation is reached only in Earth's shadow. */
  excluded: PassAssessment[];
  /** Sum of permitted operating time of the counted passes (never includes eclipsed time, never double-counted). */
  totalOperatingMs: number;
  distinctSatellites: number;
  sumEligibleMaxElevationDeg: number;
  /** The LOWEST usable maximum elevation among the counted passes (the Elevation sort key for clusters). */
  minUsableElevationDeg: number;
}

/** The maximum elevation reached while operation is permitted (the pass maximum, except for a sunlight-limited pass). */
export const usableElevation = (a: Pick<PassAssessment, 'eligibleMaxElevationDeg' | 'fullMaxElevationDeg'>): number => a.eligibleMaxElevationDeg ?? a.fullMaxElevationDeg;

function summarize(
  window: Interval,
  counted: PassAssessment[],
  alternatives: PassAssessment[],
  edge: PassAssessment[],
  excluded: PassAssessment[],
): WindowEvaluation {
  const byRise = (x: PassAssessment, y: PassAssessment) => x.riseMs - y.riseMs;
  return {
    window,
    counted,
    alternatives: alternatives.sort(byRise),
    edge: edge.sort(byRise),
    excluded: excluded.sort(byRise),
    totalOperatingMs: counted.reduce((s, c) => s + c.operatingMs, 0),
    distinctSatellites: new Set(counted.map((c) => c.noradId)).size,
    sumEligibleMaxElevationDeg: counted.reduce((s, c) => s + (c.eligibleMaxElevationDeg ?? 0), 0),
    minUsableElevationDeg: counted.length ? Math.min(...counted.map(usableElevation)) : 0,
  };
}

/**
 * Evaluate a FIXED interval (a saved event). A pass counts only if its whole AOS-to-LOS envelope lies inside it.
 * Qualifying passes that merely overlap it are reported as `edge` so drift can be warned about.
 */
export function evaluateFixedInterval(window: Interval, all: readonly PassAssessment[]): WindowEvaluation {
  const slack = SAVED_EDGE_TOLERANCE_SEC * 1000;
  const inside: PassAssessment[] = [];
  const edge: PassAssessment[] = [];
  const excluded: PassAssessment[] = [];
  for (const a of all) {
    if (a.riseMs >= window.end || a.setMs <= window.start) continue; // pass does not touch the window
    if (a.verdict === 'excluded') {
      if (a.exclusion === 'eclipse') excluded.push(a); // 'status' and 'below-threshold' are never shown
      continue;
    }
    if (a.operatingIntervals.length === 0) continue;
    // Whole pass inside the saved interval, allowing for sub-second recomputation jitter at its edges.
    if (a.riseMs >= window.start - slack && a.setMs <= window.end + slack) inside.push(a);
    else edge.push(a);
  }
  const counted = selectNonOverlapping(inside);
  const countedIds = new Set(counted.map((c) => c.passId));
  return summarize(window, counted, inside.filter((a) => !countedIds.has(a.passId)), edge, excluded);
}

/** Build the display detail of a search cluster from its counted set. The window is the actual cluster. */
function clusterDetail(counted: PassAssessment[], all: readonly PassAssessment[]): WindowEvaluation {
  const window: Interval = { start: Math.min(...counted.map((c) => c.riseMs)), end: Math.max(...counted.map((c) => c.setMs)) };
  const countedIds = new Set(counted.map((c) => c.passId));
  const alternatives: PassAssessment[] = [];
  const excluded: PassAssessment[] = [];
  for (const a of all) {
    if (countedIds.has(a.passId) || !contains(window, a.envelope)) continue;
    if (a.verdict === 'excluded') {
      if (a.exclusion === 'eclipse') excluded.push(a);
    } else if (a.operatingIntervals.length > 0) alternatives.push(a);
  }
  return summarize(window, counted, alternatives, [], excluded);
}

/** A search result: one cluster (or, in single-pass mode, one pass). */
export type EventWindow = WindowEvaluation;

export type SortBy = 'date' | 'elevation' | 'count';
export const SORT_LABELS: Record<SortBy, string> = { date: 'Date', elevation: 'Elevation', count: 'Pass count' };

const passKey = (w: WindowEvaluation) => w.counted.map((c) => c.passId).join('|');

/** Sort comparators. Every one ends in the pass ids, so the order is total and stable. */
function comparator(sort: SortBy, single: boolean): (a: WindowEvaluation, b: WindowEvaluation) => number {
  const byDate = (a: WindowEvaluation, b: WindowEvaluation) => a.window.start - b.window.start;
  const byElevation = (a: WindowEvaluation, b: WindowEvaluation) => b.minUsableElevationDeg - a.minUsableElevationDeg;
  const byCount = (a: WindowEvaluation, b: WindowEvaluation) => b.counted.length - a.counted.length;
  const byOpTime = (a: WindowEvaluation, b: WindowEvaluation) => b.totalOperatingMs - a.totalOperatingMs;
  const byKey = (a: WindowEvaluation, b: WindowEvaluation) => passKey(a).localeCompare(passKey(b));
  if (sort === 'elevation') return (a, b) => byElevation(a, b) || byDate(a, b) || byCount(a, b) || byOpTime(a, b) || byKey(a, b);
  if (sort === 'count' && !single) return (a, b) => byCount(a, b) || byDate(a, b) || byElevation(a, b) || byOpTime(a, b) || byKey(a, b);
  return (a, b) => byDate(a, b) || byCount(a, b) || byElevation(a, b) || byOpTime(a, b) || byKey(a, b); // Date (and the fallback)
}

export interface FindOptions {
  /** Maximum cluster span in minutes (earliest AOS to latest LOS). Ignored in single-pass mode. */
  maxSpanMin: number;
  minOpportunities: number;
  /** Order of the results; default Date (soonest first). */
  sort?: SortBy;
  /** Display limit applied AFTER sorting (default: the mode's own limit). */
  limit?: number;
}

/**
 * Every qualifying pass as its own result (single-pass mode). Each pass is a result of its own, sorted as requested.
 * A pass counts only if its whole AOS-to-LOS lies inside one availability block, like any other cluster.
 */
export function findSinglePasses(all: readonly PassAssessment[], availability: readonly Interval[], sort: SortBy = 'date'): EventWindow[] {
  const seen = new Set<string>();
  const out: EventWindow[] = [];
  for (const block of availability) {
    for (const a of all) {
      if (a.verdict !== 'eligible' || a.operatingIntervals.length === 0 || seen.has(a.passId)) continue;
      if (a.riseMs < block.start || a.setMs > block.end) continue;
      seen.add(a.passId);
      out.push(summarize({ start: a.riseMs, end: a.setMs }, [a], [], [], []));
    }
  }
  return out.sort(comparator(sort, true));
}

/**
 * ALL clusters (no display limit), sorted. Candidates are generated once, independently of the sort.
 * @param availability normalized absolute intervals (the ONLY availability input). Each cluster's full
 *   AOS-to-LOS envelope must lie inside ONE of them.
 */
export function findAllWindows(all: readonly PassAssessment[], availability: readonly Interval[], opts: FindOptions): EventWindow[] {
  if (opts.minOpportunities <= 1) return findSinglePasses(all, availability, opts.sort);
  const span = opts.maxSpanMin * 60_000;
  const eligible = all.filter((a) => a.verdict === 'eligible' && a.operatingIntervals.length > 0);

  const sets = new Map<string, PassAssessment[]>();
  for (const block of availability) {
    const inBlock = eligible.filter((a) => a.riseMs >= block.start && a.setMs <= block.end).sort((x, y) => x.riseMs - y.riseMs);
    for (const anchor of inBlock) {
      const ends = [...new Set(inBlock.filter((p) => p.riseMs >= anchor.riseMs && p.setMs - anchor.riseMs <= span).map((p) => p.setMs))].sort((x, y) => x - y);
      for (const end of ends) {
        // Every cluster built here STARTS WITH the anchor pass, so an earlier start is never lost to a later set. The rest are
        // passes that begin after the anchor ends (the one-station rule) and finish by \`end\`.
        const rest = inBlock.filter((p) => p !== anchor && p.riseMs >= anchor.setMs && p.setMs <= end);
        // Frontier over (passes, lowest elevation) for this start and end: walk an elevation threshold downwards over the
        // other passes and keep a set unless an already kept one has at least as many passes AND at least as high a lowest
        // elevation. (Start and end are the same for all of them, so those never need comparing.)
        const kept: Array<{ count: number; minEl: number }> = [];
        const thresholds = [...new Set(rest.map(usableElevation))].sort((x, y) => y - x);
        const candidates = [rest, ...thresholds.map((t) => rest.filter((p) => usableElevation(p) >= t))];
        for (const pool of candidates) {
          const counted = [anchor, ...selectNonOverlapping(pool)];
          if (counted.length < opts.minOpportunities) continue;
          const minEl = Math.min(...counted.map(usableElevation));
          if (kept.some((k) => k.count >= counted.length && k.minEl >= minEl)) continue;
          kept.push({ count: counted.length, minEl });
          const key = counted.map((c) => c.passId).join(',');
          if (!sets.has(key)) sets.set(key, counted);
        }
      }
    }
  }
  return [...sets.values()].map((counted) => clusterDetail(counted, all)).sort(comparator(opts.sort ?? 'date', false));
}

/** Sorted results, then the display limit: the limit always keeps the true first N of the chosen order. */
export function rankResults(all: readonly PassAssessment[], availability: readonly Interval[], opts: FindOptions): { windows: EventWindow[]; windowsTotal: number } {
  const every = findAllWindows(all, availability, opts);
  const limit = opts.limit ?? (opts.minOpportunities <= 1 ? SINGLE_PASS_RESULT_LIMIT : RESULT_LIMIT);
  return { windows: every.slice(0, limit), windowsTotal: every.length };
}

/** The first results of the chosen order (see rankResults for the total). */
export function findEventWindows(all: readonly PassAssessment[], availability: readonly Interval[], opts: FindOptions): EventWindow[] {
  return rankResults(all, availability, opts).windows;
}
