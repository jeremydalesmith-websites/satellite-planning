/**
 * Curated, MANUALLY MAINTAINED catalog of FM amateur-radio satellite repeaters.
 *
 * Three layers, deliberately separate:
 *   1. SATELLITES       identity (stable NORAD ID). Orbital elements are NOT here;
 *                        they come from the downloaded data file.
 *   2. FM_REPEATERS     static repeater configuration (frequencies, tones, bands).
 *   3. RESTRICTIONS     operational restrictions / schedule notes. Live activity
 *                        reports are NOT here; they come from the downloaded status file.
 *
 * Nothing here is live verification. `reviewedAt` says when a human last
 * compared these entries to the cited source. Add a row (see README
 * "Catalog maintenance") to add a satellite; the planner picks it up.
 */
import type { ActivityKind, BandConfig } from '../domain/types.ts';

export interface SourceRef {
  label: string;
  url: string;
}

export const SOURCES = {
  amsatFm: {
    label: 'AMSAT: FM Satellites (page dated Oct 31, 2026)',
    url: 'https://www.amsat.org/live-fm-satellites/',
  },
  amsatStatus: {
    label: 'AMSAT Live OSCAR Satellite Status',
    url: 'https://status.amsat.org/',
  },
  amsatTle: {
    label: 'AMSAT orbital elements (nasabare.txt)',
    url: 'https://www.amsat.org/tle/current/nasabare.txt',
  },
  arissStatus: {
    label: 'ARISS: Current Status of ISS Stations (page dated Nov 4, 2026)',
    url: 'https://www.ariss.org/current-status-of-iss-stations.html',
  },
  arrlIssRepeater: {
    label: 'ARRL: Simultaneous APRS and Voice Repeater on the ISS (reporting the ARISS announcement, 2022)',
    url: 'http://www.arrl.org/news/view/simultaneous-aprs-and-voice-repeater-on-the-international-space-station',
  },
} as const satisfies Record<string, SourceRef>;

/** Date a person last compared this file with the sources above (ISO date). */
export const CATALOG_REVIEWED_AT = '2026-11-12';
/** Date of the AMSAT FM page the frequencies/notes were transcribed from. */
export const CATALOG_SOURCE_DATE = '2026-10-31';

/* ------------------------------------------------------------------ 1 */

export interface SatelliteIdentity {
  noradId: number;
  name: string;
  /** Other names people use; matching is for display/search only. */
  aliases: string[];
}

export const SATELLITES: readonly SatelliteIdentity[] = [
  { noradId: 25544, name: 'ISS', aliases: ['ZARYA', 'International Space Station'] },
  { noradId: 27607, name: 'SO-50', aliases: ['SaudiSat-1C', 'SAUDISAT 1C'] },
  { noradId: 40908, name: 'CAS-3H', aliases: ['LilacSat-2', 'LILACSAT-2'] },
  { noradId: 40931, name: 'IO-86', aliases: ['LAPAN-A2', 'LAPAN-ORARI'] },
  { noradId: 43017, name: 'AO-91', aliases: ['RadFxSat', 'Fox-1B'] },
  { noradId: 43678, name: 'PO-101', aliases: ['Diwata-2', 'Diwata-2B'] },
  { noradId: 61781, name: 'AO-123', aliases: ['ASRTU-1'] },
  { noradId: 67291, name: 'RS95S', aliases: ['QMR-KWT-2'] },
  { noradId: 63217, name: 'TEVEL2-1', aliases: ['TEVEL-2 1'] },
  { noradId: 63219, name: 'TEVEL2-2', aliases: ['TEVEL-2 2'] },
  { noradId: 63218, name: 'TEVEL2-3', aliases: ['TEVEL-2 3'] },
  { noradId: 63213, name: 'TEVEL2-4', aliases: ['TEVEL-2 4'] },
  { noradId: 63214, name: 'TEVEL2-5', aliases: ['TEVEL-2 5'] },
  { noradId: 63215, name: 'TEVEL2-6', aliases: ['TEVEL-2 6'] },
  { noradId: 63238, name: 'TEVEL2-7', aliases: ['TEVEL-2 7'] },
  { noradId: 63239, name: 'TEVEL2-8', aliases: ['TEVEL-2 8'] },
  { noradId: 63237, name: 'TEVEL2-9', aliases: ['TEVEL-2 9'] },
];

/* ------------------------------------------------------------------ 2 */

export interface RadioLeg {
  mhz: number;
  /** CTCSS access tone in Hz, if the source lists one. */
  ctcssHz?: number;
}

export interface FmRepeaterConfig {
  /** Stable id of this activity; extensible to other activities later. */
  activityId: string;
  kind: ActivityKind;
  noradId: number;
  /** What you transmit to the satellite. */
  uplink: RadioLeg;
  /** What you listen to. */
  downlink: RadioLeg;
  /** Key used by the AMSAT status API (`name=` parameter). */
  amsatStatusKey: string;
  sources: SourceRef[];
}

const fm = (
  noradId: number,
  statusKey: string,
  uplink: RadioLeg,
  downlink: RadioLeg,
): FmRepeaterConfig => ({
  activityId: `${noradId}-fm`,
  kind: 'fm-repeater',
  noradId,
  uplink,
  downlink,
  amsatStatusKey: statusKey,
  sources: [SOURCES.amsatFm, SOURCES.amsatStatus],
});

export const FM_REPEATERS: readonly FmRepeaterConfig[] = [
  fm(25544, 'ISS_[FM]', { mhz: 145.99, ctcssHz: 67 }, { mhz: 437.8 }),
  fm(27607, 'SO-50_[FM]', { mhz: 145.85, ctcssHz: 67 }, { mhz: 436.795 }),
  fm(40908, 'CAS-3H_[FM]', { mhz: 144.35 }, { mhz: 437.2 }),
  fm(40931, 'IO-86_[FM]', { mhz: 145.88, ctcssHz: 88.5 }, { mhz: 435.88 }),
  fm(43017, 'AO-91_[FM]', { mhz: 435.25 }, { mhz: 145.96 }),
  fm(43678, 'PO-101_[FM]', { mhz: 437.5, ctcssHz: 141.3 }, { mhz: 145.9 }),
  fm(61781, 'AO-123_[FM]', { mhz: 145.85, ctcssHz: 67 }, { mhz: 435.4 }),
  fm(67291, 'RS95S_[FM]', { mhz: 145.92, ctcssHz: 67 }, { mhz: 436.95 }),
  fm(63217, 'TEVEL2-1_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63219, 'TEVEL2-2_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63218, 'TEVEL2-3_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63213, 'TEVEL2-4_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63214, 'TEVEL2-5_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63215, 'TEVEL2-6_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63238, 'TEVEL2-7_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63239, 'TEVEL2-8_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
  fm(63237, 'TEVEL2-9_[FM]', { mhz: 145.97 }, { mhz: 436.4 }),
];

/* ------------------------------------------------------------------ 3 */

/**
 * Operating-pattern classifications. These are DIFFERENT and are reviewed per satellite from its own
 * cited source text (never inferred from one shared flag):
 *
 *   interruptible        Normally operating (expected on full time), but subject to interruptions by
 *                        operations on its platform. A recent positive FM report is sufficient evidence,
 *                        like any other normally operating repeater. A badge and a note are shown.
 *   activation-required  Operates only when separately activated: on a schedule, during testing, or when
 *                        commanded. A recent report does NOT show it will be on for a predicted pass.
 *                        It qualifies only with confirmation covering that pass. No schedule importer
 *                        exists yet, so such a confirmation is never available and these satellites are
 *                        conservatively excluded from planning (and explained in the diagnostics).
 *   sunlight-only        Must not be used in eclipse. Independent of both of the above and always enforced.
 */
export type RestrictionKind =
  /** Repeater must not be used while the satellite is in Earth's shadow. Affects eligibility. */
  | 'sunlight-only'
  /** Normally operating, but subject to interruptions. Shown as a badge; does not gate eligibility. */
  | 'interruptible'
  /** Needs a scheduled/experimental/commanded activation window. Excluded without confirmation covering the pass. */
  | 'activation-required'
  /** Information only: shown to the user, does not change eligibility. */
  | 'note';

export interface Restriction {
  noradId: number;
  kind: RestrictionKind;
  /** Plain-language text shown in the UI (in Details). */
  text: string;
  source: SourceRef;
  /** Further sources for the same text. */
  moreSources?: SourceRef[];
  /** ISO date of the source text. A manual entry, NOT live verification. */
  asOf: string;
  /** Short badge for 'interruptible' restrictions, shown on pass cards. */
  badge?: string;
}

const A = (noradId: number, kind: RestrictionKind, text: string): Restriction => ({
  noradId,
  kind,
  text,
  source: SOURCES.amsatFm,
  asOf: CATALOG_SOURCE_DATE,
});

export const RESTRICTIONS: readonly Restriction[] = [
  A(43017, 'sunlight-only', 'AMSAT asks that this repeater not be used while the satellite is in eclipse (battery condition).'),
  {
    noradId: 25544,
    kind: 'interruptible',
    badge: 'Subject to ISS operations',
    text:
      'ARISS expects the ISS radios to operate full time, except during educational contacts, spacewalks (EVAs), dockings and undockings. ' +
      'ARISS’s status page adds that the radios are sometimes turned off for vehicle, spacewalk and payload activities, and that times are subject to change. ' +
      'A recent report is the evidence of operation used here; an interruption at the event is still possible.',
    source: SOURCES.arissStatus,
    moreSources: [SOURCES.arrlIssRepeater],
    asOf: '2026-11-04',
  },
  // CAS-3H: AMSAT gives no schedule, and says only a beacon is heard while the repeater is off. No published
  // activation window exists to confirm against, so it is classified conservatively as activation-required.
  A(40908, 'activation-required', 'AMSAT: the FM repeater has no set schedule; when it is off, only a telemetry beacon is heard on the downlink. No activation window is published, so none can be confirmed.'),
  A(40931, 'activation-required', 'AMSAT lists this repeater as operating on a schedule.'),
  A(40931, 'note', 'Low-inclination orbit (about 6° in the downloaded elements): high passes are only possible for observers near the equator.'),
  A(43678, 'activation-required', 'AMSAT: the FM repeater is activated by schedule. AMSAT also notes the satellite may be failing.'),
  A(67291, 'activation-required', 'AMSAT lists the repeater as "on during testing"; watch AMSAT-BB for announcements.'),
  A(27607, 'note', 'The repeater has a 10-minute timer that must be armed before use: send a 2-second carrier with a 74.4 Hz CTCSS tone.'),
  ...[63217, 63219, 63218, 63213, 63214, 63215, 63238, 63239, 63237].map((id) =>
    A(id, 'note', 'The owner reports software issues (random restarts that shut off the repeater, possible audio distortion), so operation is unreliable.'),
  ),
];

/* ------------------------------------------------------------------ joined view */

export interface FmActivity {
  activityId: string;
  kind: ActivityKind;
  noradId: number;
  name: string;
  aliases: string[];
  uplink: RadioLeg;
  downlink: RadioLeg;
  bandConfig: BandConfig;
  amsatStatusKey: string;
  sunlightRequired: boolean;
  /** Normally operating but subject to interruptions (ISS). Does not gate eligibility. */
  interruptible: boolean;
  /** Short badge for the interruptible classification, if any. */
  interruptibleBadge: string | null;
  /** Needs a scheduled/experimental/commanded activation window; excluded without confirmation covering the pass. */
  activationRequired: boolean;
  restrictions: Restriction[];
  sources: SourceRef[];
}

/** 2 m (VHF) is 144–148 MHz; 70 cm (UHF) is 420–450 MHz. */
export function bandOf(mhz: number): 'V' | 'U' {
  if (mhz >= 144 && mhz <= 148) return 'V';
  if (mhz >= 420 && mhz <= 450) return 'U';
  throw new Error(`Frequency ${mhz} MHz is not in the 2 m or 70 cm amateur band`);
}

export function bandConfigOf(uplinkMhz: number, downlinkMhz: number): BandConfig {
  const up = bandOf(uplinkMhz);
  const down = bandOf(downlinkMhz);
  if (up === down) throw new Error('Not a cross-band repeater');
  return `${up}/${down}` as BandConfig;
}

export function joinActivities(
  satellites: readonly SatelliteIdentity[] = SATELLITES,
  repeaters: readonly FmRepeaterConfig[] = FM_REPEATERS,
  restrictions: readonly Restriction[] = RESTRICTIONS,
): FmActivity[] {
  const byId = new Map(satellites.map((s) => [s.noradId, s]));
  const out: FmActivity[] = [];
  for (const r of repeaters) {
    const sat = byId.get(r.noradId);
    if (!sat) throw new Error(`Catalog: repeater ${r.activityId} has no satellite identity`);
    const rs = restrictions.filter((x) => x.noradId === r.noradId);
    out.push({
      activityId: r.activityId,
      kind: r.kind,
      noradId: r.noradId,
      name: sat.name,
      aliases: sat.aliases,
      uplink: r.uplink,
      downlink: r.downlink,
      bandConfig: bandConfigOf(r.uplink.mhz, r.downlink.mhz),
      amsatStatusKey: r.amsatStatusKey,
      sunlightRequired: rs.some((x) => x.kind === 'sunlight-only'),
      interruptible: rs.some((x) => x.kind === 'interruptible'),
      interruptibleBadge: rs.find((x) => x.kind === 'interruptible')?.badge ?? null,
      activationRequired: rs.some((x) => x.kind === 'activation-required'),
      restrictions: rs,
      sources: r.sources,
    });
  }
  return out;
}

export const ACTIVITIES: readonly FmActivity[] = joinActivities();

/** Compact band direction for cards, e.g. "↑ 2 m · ↓ 70 cm" (you transmit up, listen down). */
export function compactBands(a: Pick<FmActivity, 'bandConfig'>): string {
  const label = (b: 'V' | 'U') => (b === 'V' ? '2 m' : '70 cm');
  const [up, down] = a.bandConfig.split('/') as ['V' | 'U', 'V' | 'U'];
  return `↑ ${label(up)} · ↓ ${label(down)}`;
}

/** Plain-language band wording for the UI. */
export function describeBands(a: Pick<FmActivity, 'bandConfig' | 'uplink' | 'downlink'>): string {
  const label = (b: 'V' | 'U') => (b === 'V' ? '2 meters' : '70 centimeters');
  const [up, down] = a.bandConfig.split('/') as ['V' | 'U', 'V' | 'U'];
  return `Transmit on ${label(up)} (${a.uplink.mhz} MHz), listen on ${label(down)} (${a.downlink.mhz} MHz)`;
}
