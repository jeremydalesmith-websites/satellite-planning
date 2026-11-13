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
 * AOS-to-LOS is the window), ranked by maximum elevation, highest first, with the earlier AOS breaking ties. The maximum
 * span does not apply. All other rules (selection by peak, sunlight, eligibility, availability fit) are unchanged.
 *
 * Ranking of clusters: (1) number of passes, (2) total operating time, (3) sum of maximum elevations,
 * (4) earlier start. Exact duplicates (same counted passes) are removed. A shorter cluster with fewer passes is a
 * distinct set and is kept; the display limit applies.
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
}

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

function compareClusters(a: WindowEvaluation, b: WindowEvaluation): number {
  return (
    b.counted.length - a.counted.length ||
    b.totalOperatingMs - a.totalOperatingMs ||
    b.sumEligibleMaxElevationDeg - a.sumEligibleMaxElevationDeg ||
    a.window.start - b.window.start
  );
}

export interface FindOptions {
  /** Maximum cluster span in minutes (earliest AOS to latest LOS). */
  maxSpanMin: number;
  minOpportunities: number;
  limit?: number;
}

/**
 * Every qualifying pass as its own result (single-pass mode), highest maximum elevation first. The elevation ranked is the
 * highest reached while operation is permitted (equal to the pass maximum except for a sunlight-limited pass), so a pass is
 * never ranked by an elevation the operator cannot use. Ties: earlier AOS, then pass id, for a stable order.
 * A pass counts only if its whole AOS-to-LOS lies inside one availability block, like any other cluster.
 */
export function findSinglePasses(all: readonly PassAssessment[], availability: readonly Interval[]): EventWindow[] {
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
  const elevation = (w: WindowEvaluation) => w.counted[0]!.eligibleMaxElevationDeg ?? w.counted[0]!.fullMaxElevationDeg;
  return out.sort((x, y) => elevation(y) - elevation(x) || x.window.start - y.window.start || x.counted[0]!.passId.localeCompare(y.counted[0]!.passId));
}

/**
 * Find ranked clusters.
 * @param availability normalized absolute intervals (the ONLY availability input). Each cluster's full
 *   AOS-to-LOS envelope must lie inside ONE of them.
 */
export function findEventWindows(
  all: readonly PassAssessment[],
  availability: readonly Interval[],
  opts: FindOptions,
): EventWindow[] {
  if (opts.minOpportunities <= 1) return findSinglePasses(all, availability).slice(0, opts.limit ?? SINGLE_PASS_RESULT_LIMIT);
  const span = opts.maxSpanMin * 60_000;
  const eligible = all.filter((a) => a.verdict === 'eligible' && a.operatingIntervals.length > 0);

  // Distinct counted sets. For every anchor (a pass's AOS) and every possible end (a pass's LOS) within the
  // span, take the best set that fits; this also yields shorter clusters with fewer passes.
  const sets = new Map<string, PassAssessment[]>();
  for (const block of availability) {
    const inBlock = eligible.filter((a) => a.riseMs >= block.start && a.setMs <= block.end).sort((x, y) => x.riseMs - y.riseMs);
    for (const anchor of inBlock) {
      const ends = [...new Set(inBlock.filter((p) => p.riseMs >= anchor.riseMs && p.setMs - anchor.riseMs <= span).map((p) => p.setMs))].sort((x, y) => x - y);
      for (const end of ends) {
        const candidates = inBlock.filter((p) => p.riseMs >= anchor.riseMs && p.setMs <= end);
        const counted = selectNonOverlapping(candidates);
        if (counted.length < opts.minOpportunities) continue;
        const key = counted.map((c) => c.passId).join(',');
        if (!sets.has(key)) sets.set(key, counted);
      }
    }
  }

  const clusters = [...sets.values()].map((counted) => clusterDetail(counted, all));
  clusters.sort(compareClusters);
  return clusters.slice(0, opts.limit ?? RESULT_LIMIT);
}

