/** All instants are absolute UTC epoch milliseconds. Display zone is a view concern only. */
export type Ms = number;

/** Half-open interval [start, end). */
export interface Interval {
  start: Ms;
  end: Ms;
}

export interface Observer {
  latDeg: number;
  lonDeg: number;
  /** Height above the ellipsoid, km. The UI assumes 0. */
  heightKm: number;
}

export interface ElementSet {
  noradId: number;
  name: string;
  line1: string;
  line2: string;
  /** Epoch of the elements, UTC ms. */
  epochMs: Ms;
}

/** One contiguous stretch of a pass with constant sunlight state. */
export interface SunSegment extends Interval {
  lit: boolean;
  /** Highest elevation reached inside this segment, degrees. */
  maxElevationDeg: number;
}

/** Pure geometry of one satellite pass over the observer. No operational judgement. */
export interface PassGeometry {
  id: string;
  noradId: number;
  riseMs: Ms;
  peakMs: Ms;
  setMs: Ms;
  maxElevationDeg: number;
  riseAzDeg: number;
  peakAzDeg: number;
  setAzDeg: number;
  /**
   * Interval during which elevation >= threshold, keyed by threshold (degrees,
   * as a string). null when the pass never reaches that threshold.
   */
  aboveThreshold: Record<string, Interval | null>;
  /** Sunlight state across [rise, set), in order, covering the whole pass. */
  sunSegments: SunSegment[];
}

export type ActivityKind = 'fm-repeater';

export type BandLetter = 'V' | 'U';
export type BandConfig = 'V/U' | 'U/V';

export interface Criteria {
  /** A pass is selected when its MAXIMUM elevation reaches this (during a sunlit portion, for sunlight-dependent repeaters). */
  minElevationDeg: number;
  /**
   * Maximum permitted span of a cluster, minutes: from the earliest full-pass AOS to the latest full-pass LOS
   * among the counted passes, gaps included. It is a limit, not a required or padded event duration.
   */
  maxSpanMin: number;
  /** Minimum passes. 1 = single-pass mode (each qualifying pass is its own result; the maximum span is ignored). */
  minOpportunities: number;
}
