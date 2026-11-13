/**
 * Application POLICY constants.
 *
 * These are choices made by this planner, NOT authoritative guarantees from
 * AMSAT, satellite owners, or the orbital model. They are documented in the
 * README ("Policies") and surfaced in the UI wherever they change a result.
 */

/** Search limits (requirements: default 28 days, at most 42). */
export const DEFAULT_SEARCH_DAYS = 28;
export const MAX_SEARCH_DAYS = 42;

/** Elevation input bounds. Below ~5° a pass is rarely workable in practice. */
export const MIN_ELEVATION_INPUT_DEG = 5;
export const MAX_ELEVATION_INPUT_DEG = 85;
export const DEFAULT_MIN_ELEVATION_DEG = 40;

/** Maximum cluster spans offered (minutes). */
export const EVENT_DURATIONS_MIN = [120, 150, 180] as const;
export const DEFAULT_MIN_OPPORTUNITIES = 3;

/** A pass is defined from geometric rise to set at this elevation above a flat horizon. */
export const PASS_HORIZON_DEG = 0;

/**
 * Operational-status freshness window. Only reports observed within this many
 * hours can establish "recently reported active". Older reports are stale.
 */
export const STATUS_WINDOW_HOURS = 72;

/**
 * Status reports older than this (hours, since they were DOWNLOADED) are called out next to the results: newer reports,
 * for example a "Not Heard" filed after the download, are not included. Beyond STATUS_WINDOW_HOURS nothing can qualify.
 */
export const STATUS_AGE_NOTICE_HOURS = 24;

/**
 * "Known unavailable" requires at least this many negative reports
 * (Not Heard / Telemetry Only) from at least this many distinct callsigns in
 * the window, with no positive report newer than the newest negative.
 * One negative report is only "unconfirmed".
 */
export const UNAVAILABLE_MIN_REPORTS = 2;
export const UNAVAILABLE_MIN_CALLSIGNS = 2;

/** Orbital elements whose epoch is older than this at the time of the SEARCH (not at download time) are not used at all. */
export const MAX_ELEMENT_AGE_DAYS = 30;

/**
 * Prediction-horizon labels, measured from the orbital-elements epoch to the
 * time being predicted. These are wording tiers, NOT accuracy figures.
 */
export const TENTATIVE_AFTER_DAYS = 7;
export const PROVISIONAL_AFTER_DAYS = 28;

/**
 * Sunlight: the satellite counts as sunlit only when none of the Sun's disc is
 * covered by Earth (shadow fraction below this). Penumbra therefore counts as
 * NOT sunlit for sunlight-dependent repeaters (conservative; lasts seconds).
 */
export const SUNLIT_SHADOW_FRACTION_BELOW = 0.01;

/** Maximum number of clusters shown. */
export const RESULT_LIMIT = 25;
/** In single-pass mode (minimum passes = 1) up to this many passes are shown, taken from the list in the chosen sort order; the page says if more exist. */
export const SINGLE_PASS_RESULT_LIMIT = 100;

/**
 * A saved cluster interval is anchored exactly on a pass's AOS and LOS. Recomputing the same pass moves those instants
 * by tens of milliseconds (the predictor refines crossings to a bisection tolerance), so a pass counts as inside the
 * saved interval if it is within this many seconds of it (a shift under this, by itself, neither flags a change nor drops
 * a counted pass). It applies ONLY to saved-event re-checks: new searches use exact comparisons. Far below the 60 s
 * shifts reported as real changes.
 */
export const SAVED_EDGE_TOLERANCE_SEC = 3;

/** Changes smaller than these are not reported as "meaningful" for saved events. */
export const SAVED_SHIFT_REPORT_SEC = 60;
export const SAVED_ELEVATION_REPORT_DEG = 2;
/** Max difference between peak times for an old and new pass to be "the same pass". */
export const SAVED_MATCH_TOLERANCE_MIN = 10;
