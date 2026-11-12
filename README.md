# FM Satellite Event Planner

A static web app that answers one question:

> During the next several weeks, when are we available for a two-to-three-hour club
> event containing **multiple usable FM amateur-radio satellite passes** above my
> chosen elevation?

It is a **planner, not a tracker**: no live tracking, globe, Doppler, radio/rotator
control, logging, accounts or notifications. Everything runs in your browser;
the site itself needs only static hosting (GitHub Pages).

Scope of this release: FM voice repeaters, cross-band on 2 m and 70 cm, both V/U
and U/V. Deliberately **not** implemented (but the data model has room): SSTV,
linear transponders, packet/APRS/telemetry/beacons, coordination with another
station.

---

## Contents
1. [Local development](#local-development)
2. [Testing](#testing)
3. [GitHub Pages deployment](#github-pages-deployment)
4. [Public data sources and refresh](#public-data-sources-and-refresh)
5. [How passes are counted](#how-passes-are-counted)
6. [Policies (tunable assumptions)](#policies-tunable-assumptions)
7. [Catalog maintenance](#catalog-maintenance)
8. [Long-range prediction limitations](#long-range-prediction-limitations)
9. [Privacy](#privacy)
10. [Deferred features](#deferred-features)
11. [Project layout](#project-layout)

## Local development

Requires Node 22.18 or newer (the refresh script uses Node's built-in TypeScript support).

```bash
npm install
npm start              # downloads fresh AMSAT data, then serves http://localhost:5173/
```

`npm start` = `npm run refresh-data` (download and validate AMSAT elements and
status into `public/data/`) followed by `npm run dev`. If you already have data
and only want the dev server, use `npm run dev`.

**Where the first preview's data comes from.** `public/data/*.json` is
generated and git-ignored, so a fresh checkout contains **no orbital data**.
`npm run refresh-data` (part of `npm start`) downloads it from AMSAT. Without
that step the app shows a clear "Data unavailable" message and **never
substitutes data**. (The frozen files in `tests/fixtures/` are real but old
and are used only by the tests, never by the app.) In the future deployment
the scheduled workflow performs this download before each build.

Behind an HTTP proxy, Node's `fetch` needs `NODE_USE_ENV_PROXY=1 npm run refresh-data`.

Other scripts: `npm run typecheck`, `npm run build`, `npm run preview`,
`node scripts/smoke.ts` (runs the whole pipeline on real data and prints windows).

## Testing

```bash
npm test
```

134 tests, no network needed. They use **clearly labelled fixtures**: real AMSAT
elements and status reports frozen on 2026-11-12 in `tests/fixtures/`, plus
synthetic geometry in `tests/factory.ts` where an exact boundary is needed.
They cover elevation-threshold boundaries; partial eclipse and local-night vs
satellite-sunlight; adjacent availability periods; time zones and DST
(spring-forward, fall-back, southern hemisphere); overlapping passes;
event-edge handling; repeated passes of one satellite; unknown/stale status;
duplicate-window consolidation; saved events staying fixed; empty results and
unavailable data; and form validation / accessibility of the availability grid.

Independent validation against Skyfield is documented in
[`docs/VALIDATION.md`](docs/VALIDATION.md) (112–223 passes per case agree to
≤0.22 s and ≤0.007°; discrepancies explained there).

`scripts/e2e-smoke.mjs` is a manual browser check, not part of `npm test`. It serves the build from a sub-directory and drives it in
Chromium (needs Playwright): `npm run build && node scripts/serve-subdir.mjs /satellites/ 4173 &`
then `node scripts/e2e-smoke.mjs http://localhost:4173/satellites/ ./shots`.

## GitHub Pages deployment

> **Not included yet.** This repository currently has **no GitHub Actions
> workflows**, nothing is published, Pages is not enabled, and no domain or DNS
> is configured. A refresh-and-deploy workflow is planned as a later, separately
> approved phase.

What is already in place for deployment:

* The build is a static folder (`npm run build` → `dist/`).
* The base path is **configurable**. By default the app uses relative URLs
  (`base: './'`), so the same build works from any sub-directory without
  touching other content on a domain. Set `VITE_BASE_PATH=/some/path/` when
  building to use absolute paths instead.
* `node scripts/serve-subdir.mjs /satellites/ 4173` serves `dist/` under a path
  so you can verify sub-directory behaviour locally before publishing anything.
* The data refresh (`npm run refresh-data`) needs no secrets or API keys.

The final URL and sub-path are intentionally undecided.

## Public data sources and refresh

| Data | Source | Format (inspected, not assumed) | Used for |
|---|---|---|---|
| Orbital elements | AMSAT `https://www.amsat.org/tle/current/nasabare.txt` | Plain-text 3-line TLEs, validated by checksum | Pass prediction |
| Repeater activity | AMSAT Satellite Status API `https://status.amsat.org/api/v1/reports.php` (documented, OpenAPI; v1.4) | JSON; values `Heard`, `Telemetry Only`, `Not Heard`, `Crew Active` | Operating status |
| Frequencies, tones, restrictions | AMSAT "FM Satellites" web page | **Human-readable HTML only, no structured data** | Hand-maintained catalog |

**Refresh behavior.** `scripts/refresh-data.ts` downloads and validates the first
two sources and writes normalized `public/data/elements.json` and
`status.json` beside the app. The browser reads only those files (no
cross-origin requests to AMSAT, no CORS dependence). A future workflow is intended to run it on a schedule, so each deployment carries fresh data. Failure policy:

* Orbital elements fail to download or validate → the script exits with an error
  and writes nothing. (In the planned workflow this keeps the previous
  deployment live.)
* Status reports fail → orbital data is still written, and every repeater is
  shown as "unconfirmed"; nothing is guessed.

The status API asks clients to identify themselves and poll at most every 5
minutes; the job sends a descriptive User-Agent and makes one spaced request
per satellite per run. Report data is © AMSAT, **CC BY 4.0**, and is
attributed in the app. Callsigns are not stored in the published file
(reports keep only a time, a value, and an anonymous per-file operator index).

**Limitation, stated plainly:** the frequency/restriction catalog is manual. The
app labels those notes "manual catalog note, not live" with the source page's
date (2026-10-31) and never presents them as verified live status.

CelesTrak was not used (it was not reachable from the development sandbox); AMSAT is the primary source.

## How passes are counted

* A **pass** runs from rise to set at 0° elevation (flat horizon, observer at
  sea level; terrain and obstructions are not modelled).
* **Time above your elevation** = when elevation ≥ your threshold.
* **Operating interval** = the stretch that is above your threshold **and**
  operationally eligible (sunlit, for sunlight-dependent repeaters). If a
  shadow splits it, the longest piece is used. A pass **qualifies** only if
  such an interval exists, i.e. the threshold is reached during an eligible
  portion. The card shows the full-pass maximum and, when different, the
  highest *usable* point.
* **Sunlight** is sunlight *at the satellite* (satellite.js `sunPos` +
  `shadowFraction`), never local daylight. A night-time event can have a lit
  satellite. Any penumbra counts as not lit. Only AO-91 is flagged
  sunlight-dependent, because AMSAT's FM page asks for no use in eclipse.
* **Overlap rule (one operating station, no setup gap).** In a window, the
  planner counts the **largest set of strictly non-overlapping operating
  intervals** (touching end-to-start is allowed). Ties go to more total
  operating time, then higher summed elevations. Fully simultaneous passes are
  never double-counted; overlapping passes are shown as *alternatives*.
* **Fit rule.** A pass counts only if its *whole* operating interval is inside
  the event. A pass cut by the event edge is listed as "runs past event edge",
  not counted.
* **Availability.** The event must lie entirely inside one merged availability
  block (Midday + Evening merge into one block). Period boundaries are local
  wall-clock times in the selected zone, converted per day with Luxon, so DST is
  handled. Periods cannot cross midnight.
* **Ranking:** (1) number of opportunities, (2) total operating time,
  (3) sum of maximum elevations, (4) earlier start. There is no opaque score.
  Windows with the same set of passes are consolidated into one tidy
  (15-minute-aligned) start; windows overlapping a better one by ≥50% are
  folded into it ("N nearly identical windows folded").
* **Status gating.** Only repeaters *recently reported active* count toward
  your minimum. Unknown, stale, mixed-report and unconfirmed schedule-dependent
  repeaters appear separately as **conditional**; repeaters reported not
  working are excluded and listed with the reason. A heard beacon
  ("Telemetry Only") never counts as repeater activity.
* **No results?** The page explains why and suggests what could be relaxed
  (fewer opportunities, lower elevation, longer event, more availability,
  counting conditionals). Nothing is ever relaxed automatically.

## Policies (tunable assumptions)

These are this app's **choices**, not guarantees from AMSAT or satellite
owners. All live in `src/domain/policy.ts`.

| Policy | Value | Effect |
|---|---|---|
| Status freshness window | 72 h | Only reports within it can confirm activity |
| "Reported not working" | ≥2 negative reports from ≥2 operators, no positive | Excluded (one negative = just unconfirmed) |
| Mixed evidence | newest report negative after a positive | Not counted (conditional) |
| Orbital-elements age limit | 30 days | Older sets are skipped and named in the results |
| Prediction labels | >7 d "tentative", >28 d "provisional" (days past elements epoch) | Wording only, not an accuracy figure |
| Shadow rule | shadow fraction ≥ 0.01 = not sunlit | Conservative for eclipse-restricted repeaters |
| Elevation input | 5°–85° | |
| Search span | ≤ 42 days | |

A consequence worth knowing: the status policy is deliberately strict. Few
repeaters are *confirmed active at any moment*, so with ≥3 opportunities
required you may see conditional-only or empty results. Relaxing to 2, or
reading the conditional list, is a decision left to you. Status is also a
snapshot of *now*; for an event weeks away it is the best available evidence,
not a promise.

## Catalog maintenance

`src/catalog/catalog.ts` has three separate layers:
`SATELLITES` (identity by stable NORAD ID), `FM_REPEATERS` (frequencies, CTCSS
tones, AMSAT status key) and `RESTRICTIONS` (sunlight-only / schedule-dependent
/ notes, each with source and date). To add a satellite:

1. Add it to `SATELLITES` (NORAD ID, name, aliases).
2. Add its `fm(...)` row with uplink/downlink MHz (bands are derived and must
   be 2 m/70 cm cross-band; the code throws otherwise).
3. Set `amsatStatusKey` to its name in AMSAT's status catalog
   (`https://status.amsat.org/api/v1/catalog.php`, for example `SO-50_[FM]`).
4. Add any `RESTRICTIONS` rows with the source page and its date. Use
   `sunlight-only` only if a source says so.
5. Update `CATALOG_REVIEWED_AT` / `CATALOG_SOURCE_DATE`, run `npm test`.

The refresh script and the app pick it up automatically. Re-check AMSAT's FM page
periodically; the catalog does not update itself.

## Long-range prediction limitations

Orbits are propagated with SGP4 from a single set of elements. The further a
time is from the elements' epoch, the more the real satellite drifts from the
prediction (atmospheric drag on low satellites and manoeuvres are the main
reasons). This app **does not claim second-level accuracy weeks ahead and
computes no confidence intervals**. Instead it:

* shows three separate timestamps: when data was **downloaded**, the
  **epoch** of the elements, and when predictions were **generated**;
* labels events more than 7 days past the epoch *tentative* and more than 28
  *provisional*;
* recalculates everything when refreshed data loads, and re-checks **saved
  events** when you open them (the saved time never moves; you are told what
  changed and warned if it drops below your minimum).

Treat a date chosen 3–4 weeks ahead as a good *choice of day*, then re-check
in the days before. Skyfield cross-checking verifies the implementation, not
real-world drift (see `docs/VALIDATION.md`).

## Privacy

Your location, availability and saved events live only in this browser's
`localStorage`. The location is **never guessed**: it is empty until you type
it or press "Use my current location". Nothing is sent to any server. There
are no accounts, analytics, or cookies.

## Deferred features

Not implemented (by design for this release): SSTV; linear transponders;
packet, APRS, telemetry-only and beacon-only activities; mutual visibility /
coordination with another station; live tracking, globes, ground tracks;
Doppler tuning; radio or rotator control; QSO logging; setup-gap settings;
notifications, email and accounts; date-specific availability blocks,
recurrence rules, multiple named availability profiles, family calendars and
one-off exceptions. Observer altitude and horizon masks are also not modelled.
Availability is already normalized into absolute intervals, so most of the
availability features can be added without touching the cluster finder.

## Project layout

```
src/
  domain/        types, interval algebra, policy constants
  catalog/       satellite identity · FM repeater config · restrictions
  data/          ingest.ts (pure parsing/validation) · load.ts (browser fetch)
  orbit/         predict.ts (satellite.js) · worker + client · horizon labels
  eligibility/   status.ts (activity reports → state) · assess.ts (pass + sunlight)
  availability/  weekly grid → absolute intervals (Luxon)
  cluster/       non-overlapping selection, window search, consolidation, ranking
  saved/         snapshots, fixed-window re-check, change comparison
  planner.ts     orchestration + "no results" diagnosis
  ui/            React components and styles
scripts/         refresh-data.ts · smoke.ts · serve-subdir.mjs · e2e-smoke.mjs
validation/      independent Skyfield comparison
tests/           134 tests + labelled fixtures
CLAUDE.md          working agreements for contributors
```
