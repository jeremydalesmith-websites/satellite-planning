import type { Interval, Ms } from './types.ts';

/** Sort, drop empty, and merge overlapping or touching intervals. */
export function normalizeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push(iv);
  }
  return out;
}

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/** Intersection of two normalized lists. */
export function intersectLists(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const s = intersect(x, y);
    if (s) out.push(s);
    if (x.end < y.end) i++;
    else j++;
  }
  return out;
}

export function clipList(list: readonly Interval[], bounds: Interval): Interval[] {
  return list.map((i) => intersect(i, bounds)).filter((i): i is Interval => i !== null);
}

/** True when `inner` lies entirely inside `outer` (closed comparison on both ends). */
export function contains(outer: Interval, inner: Interval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

export function duration(i: Interval): Ms {
  return i.end - i.start;
}

export function totalDuration(list: readonly Interval[]): Ms {
  return list.reduce((s, i) => s + duration(i), 0);
}

export function overlapMs(a: Interval, b: Interval): Ms {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}
