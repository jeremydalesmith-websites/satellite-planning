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
1. [Requirement checklist](#requirement-checklist)
2. [Local development](#local-development)
3. [Testing](#testing)
4. [Deployment and base path](#deployment-and-base-path)
5. [Public data sources and refresh](#public-data-sources-and-refresh)
6. [How passes are counted](#how-passes-are-counted)
7. [Policies (tunable assumptions)](#policies-tunable-assumptions)
8. [Catalog maintenance](#catalog-maintenance)
9. [Long-range prediction limitations](#long-range-prediction-limitations)
10. [Privacy](#privacy)
11. [Deferred features](#deferred-features)
12. [Project layout](#project-layout)

## Requirement checklist

Status key: **Done** = implemented and exercised by automated tests; **Done\*** = implemented, with
the stated limitation or only partial automated coverage; **Not yet** = deliberately not in this phase.
"Tests" names the files under `tests/`; "browser check" means a manual Playwright run (not part of `npm test`).

| # | Requirement | Status | Evidence | Limitations |
|---|---|---|---|---|
| 1 | Find clusters of usable FM passes inside my availability; search up to 42 days, marked provisional | Done | `cluster`, `availability`, `planner` | "Tentative/provisional" are wording tiers (>7 / >28 days past the elements epoch), not accuracy figures |
| 2a | TypeScript, Vite, React, `satellite.js`, phone + desktop | Done | build, typecheck, browser check | Phone layout verified in a 390 px Chromium window only, not on real devices |
| 2b | Static, GitHub Pages-compatible, configurable sub-directory | Done | `scripts/e2e-basepath.mjs`: 18/18 checks under `/satellites/` (relative and absolute base) and `/tools/sat/` | Not published; the mapping of `/satellites/` to this repository is a deployment-phase decision (see below) |
| 2c | Local storage for preferences and saved events | Done | `ui` tests, browser reload check | Per-browser only; cleared if the user clears site data |
| 2d | Scheduled GitHub Actions data refresh | **Not yet** | `scripts/refresh-data.ts` works by hand | No workflow in this phase (Phase 3, needs approval) |
| 2e | No Firebase/DB/auth/paid API/LLM; no secrets in frontend | Done | code review | The refresh script sends a generic User-Agent |
| 3 | FM repeaters only, 2 m/70 cm cross-band, V/U and U/V; extensible internal model | Done | `planner` (catalog) | `ActivityKind` has one value today; SSTV etc. deliberately not built |
| 4 | Inputs: location (manual + optional button), timezone, date range, min elevation, duration, min opportunities, validation | Done* | `ui` (validation, defaults, geolocation never called unprompted), `availability` | Real browser geolocation not tested; minimum opportunities accepts 2 to 10 (not 1); elevation limited to 5 to 85 degrees |
| 5 | Weekly Sun-Sat x Morning/Midday/Evening grid; editable boundaries; merge adjacent; whole event must fit; explicit selection; accessible | Done* | `availability`, `ui` | Periods cannot cross midnight; touch usability not tested on real phones; a period boundary inside a spring-forward gap snaps to the moment the clocks jump |
| 6 | Local SGP4 predictions with refined rise/peak/set/threshold/eclipse; three timestamps; Worker | Done | `predict` (vs 1 s brute force), `docs/VALIDATION.md` (vs Skyfield) | No confidence intervals (intended); observer height fixed at 0; no terrain mask; eclipse boundaries are sampled every 5 s, so a shadow shorter than 5 s inside one pass could be missed (none found in 5,028 real passes) |
| 7a | Curated catalog in three separate layers with sources | Done* | `planner` (catalog) | Frequencies/restrictions are hand-copied from one AMSAT page dated 2026-10-31. "Status timestamp/explanation" is held per restriction (`asOf`, text) plus a catalog-wide review date, not as per-satellite fields |
| 7b | AMSAT activity ingestion; FM-mode matching; four operating states; strict counting | Done | `ingest`, `eligibility` | Reports are volunteer observations; whether an operator filed under the right mode cannot be verified |
| 8 | Sunlight at the satellite, partial eclipse, eligible-portion elevation, explained exclusions | Done* | `eligibility`, `planner` (ISS real-orbit tests), Skyfield comparison | Only AO-91 is flagged sunlight-dependent (only it has a cited source); any penumbra counts as not sunlit |
| 9 | Cluster finder: non-overlapping count, fit-inside rule, consolidation, ranking, honest empty results | Done | `cluster`, `planner` (vs minute-by-minute reference) | Conservative single-station rule; touching passes count as sequential with no setup gap |
| 10 | Event cards and pass cards with all required fields | Done* | browser check, screenshots | `EventCard`, `PassCard` and the timeline have no component tests; the timeline is decorative (`aria-hidden`) with the same information in text |
| 11 | Saved events stay fixed; recomputed; changes and minimum warning | Done* | `saved` | Re-checked when the Saved tab is opened (not on app load); local to one browser |
| 12 | Separate testable modules; required test list; independent validation | Done* | 152 tests; `docs/VALIDATION.md` | Skyfield validation needs Python and is not in `npm test`; it checks the implementation, not real-world accuracy |
| 13 | README (dev, test, deploy, data, catalog, limits, deferred) | Done | this file | |

## Local development

Requires Node 22.18 or newer (the refresh script uses Node's built-in TypeScript support).
Use `npm ci` (not `npm install`) so you get exactly the locked dependency versions; use
`npm install` only when you are deliberately changing dependencies.

```bash
npm ci                 # installs exactly the versions in package-lock.json
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

152 tests, no network needed. They use **clearly labelled fixtures**: real AMSAT
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

Two manual browser checks (need Playwright; not part of `npm test`): `scripts/e2e-smoke.mjs` (form, search, save,
phone layout, with screenshots) and `scripts/e2e-basepath.mjs` (sub-path behaviour; see Deployment).

## Deployment and base path

> **Not published and not enabled.** This repository has **no GitHub Actions workflows**,
> Pages is not enabled, and no domain or DNS is configured. A refresh-and-deploy workflow is a
> later phase that needs your approval.

**Intended public address:** `https://k1kfx.com/satellites/`. A separate fox-hunting app is
planned at `/hunt`; nothing in this repository reads, writes or links to it.

**Base path is configurable.** The source stays at the repository root; only the build's URL
prefix changes:

```bash
npm run build:satellites          # absolute base /satellites/  (the intended public build)
VITE_BASE_PATH=/other/ npm run build   # any other absolute base (macOS/Linux; on Windows use: npx vite build --base=/other/)
npm run build                     # default: relative URLs, works from any sub-directory
```

**Verified** (`scripts/e2e-basepath.mjs`, Chromium; 18 checks each, all passing) for the relative
build and the `/satellites/` build served under `/satellites/`, and the relative build under
`/tools/sat/`: the page renders; all assets, the Web Worker and both data files load from under
the prefix; a search runs and shows results; switching tabs works; reloading keeps working
(preferences and saved events persist); `/satellites/index.html` works; `/satellites` without the
slash redirects to `/satellites/` (the test server emulates the redirect GitHub Pages performs);
**no request ever leaves the prefix**, checked two independent ways (a permanent browser-side log of every
request, and the test server's own record of out-of-prefix hits), so nothing is read from `/` or `/hunt`;
and no HTTP, console or page errors. A **negative control** proves the leak detectors can fail (a deliberate
request to `/hunt/` is caught by both), and a build with the wrong root base (`--base=/`) served under
`/satellites/` makes the script fail. Reproduce:

```bash
npm run build:satellites
node scripts/serve-subdir.mjs /satellites/ 4173 &
node scripts/e2e-basepath.mjs http://localhost:4173 /satellites/    # needs Playwright
```

**Not verified (cannot be, until deployment):** how GitHub Pages will actually map
`/satellites/` to this repository. A GitHub *project* Pages site is normally served at
`/<repository-name>/` (here that would be `/satellite-planning/`) under the owner's custom
domain, so reaching exactly `/satellites/` needs a deployment-phase choice, such as renaming the
repository to `satellites` or publishing `dist/` into a `satellites/` folder of whichever
repository serves `k1kfx.com`. That decision, and what it does to your existing site, is yours to
approve in the deployment phase. The build above works for either.

The data refresh (`npm run refresh-data`) needs no secrets or API keys.

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
  your minimum. Everything else is either **conditional** (shown, not counted) or
  **excluded**; see the vocabulary and matching rules below.
* **No results?** The page explains why and suggests what could be relaxed
  (fewer opportunities, lower elevation, longer event, more availability,
  counting conditionals). Nothing is ever relaxed automatically.

### How AMSAT reports are matched to the FM repeater

AMSAT's status service lists every mode of a satellite as its **own entry**: `ISS_[FM]`,
`ISS_[Crew]`, `ISS_[SSTV]`, `ISS_[VHF_Digi]`, `AO-123_[FM]`, `AO-123_[SSDV]`, and so on
(`https://status.amsat.org/api/v1/catalog.php`). The catalog stores, for each repeater, the
exact FM key (for example `SO-50_[FM]`), and:

1. the refresh script requests **only that key** (`reports.php?name=SO-50_[FM]`), one request per
   catalog repeater, so no other mode is ever downloaded;
2. as a second line of defence, ingestion **rejects any returned row whose own `name` is not that
   exact key** (or whose NORAD ID contradicts the catalog; AMSAT has no ID for CAS-3H, so a
   missing ID is accepted) and records the rejection;
3. the classifier reads only that key's reports, so reports filed under another mode of the same
   satellite cannot influence it.

Checked against the live API on 2026-11-12: all 13 FM entries that had reports returned rows named
exactly their own key and matching NORAD IDs; `tests/ingest.test.ts` and `tests/eligibility.test.ts`
prove that rows or whole responses from other modes (SSTV, digipeater, crew) are rejected or ignored.

Within the FM entry, report values are interpreted like this:

| AMSAT value | Meaning here | Can it make the repeater count? |
|---|---|---|
| Heard | Someone worked/heard the **FM repeater** | Yes, if recent and not contradicted by a newer negative |
| Telemetry Only | Only the **beacon/telemetry** was heard, so the repeater is not shown to work | No (counted as a negative) |
| Not Heard | Nothing received | No (counted as a negative) |
| Crew Active | ISS crew voice (belongs to the `ISS_[Crew]` entry) | No: ignored |

So a heard beacon, or activity in any other mode, **cannot** establish FM repeater availability.
Limitation: these are volunteer reports, and the software cannot tell whether an operator filed a
report under the correct mode.

### What each result label means (status vocabulary)

| Label shown | When | Counts toward your minimum? | Shown as |
|---|---|---|---|
| **Recently reported active** | at least one "Heard" in the last 72 h and no newer negative | **Yes** | counted pass |
| **Mixed reports** | "Heard" reports **and** a newer negative (not heard / beacon only) | No | conditional |
| **Not heard (unconfirmed)** | negative report(s) only, but fewer than 2 reports or fewer than 2 operators | No | conditional |
| **Confirmed unavailable** | at least 2 negative reports from at least 2 operators, no "Heard", all in the last 72 h | No | excluded, with the reason |
| **No recent reports** / **Schedule-dependent (unconfirmed)** | no reports in 72 h (the latter if AMSAT says the repeater runs on a schedule, crew or test basis) | No | conditional |
| **Status data unavailable** | the status file could not be loaded | No | conditional |

"Confirmed" here means *repeatedly reported by several operators*, not verified by AMSAT.

## Policies (tunable assumptions)

These are this app's **choices**, not guarantees from AMSAT or satellite
owners. All live in `src/domain/policy.ts`.

| Policy | Value | Effect |
|---|---|---|
| Status freshness window | 72 h | Only reports within it can confirm activity |
| "Confirmed unavailable" | ≥2 negative reports from ≥2 operators, no positive | Excluded (one negative = just "not heard (unconfirmed)") |
| "Mixed reports" | newest report negative after a positive | Not counted (conditional) |
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

## Independent review (what it found and what was done)

A separate reviewer agent, given only the requirements and the code, read the cluster finder,
sunlight eligibility, time-zone handling and base-path code and probed them with randomized
checks. **A review by an AI, even a clean one, is not proof of correctness**; it found real defects
the original tests had missed, which is the point of asking.

Fixed (each first reproduced by a failing test):
* **Window could start up to a second before its availability block** (a rounding fallback in
  `tidyStart` could leave `[lo, hi]`; the tidy window was never re-checked against the block).
  Clamped, and a tidy window is now accepted only if it stays inside the block.
* **False one-hour gap in zones whose clocks change at midnight** (e.g. America/Havana): the end of
  one day and the start of the next were resolved differently. Both now use the same conversion.
* **A period inside a spring-forward gap lost real time** (02:30-03:30 became empty). Nonexistent
  times now snap to the instant the clocks jump (03:00-03:30). The code comment had also claimed this.
* **Base-path check was weaker than it read** (it discarded requests, used "some" for assets, and its
  `/hunt` check could not fail). Rewritten: permanent request log, every asset checked, server-side
  out-of-prefix log, and a negative control (see Deployment).
* **FM-entry guard was optional** in `parseStatusReports`; it is now a required argument. The test
  server no longer crashes on a malformed URL escape.

Reviewed and found consistent (by the reviewer's own probes, not independently re-run by me except
where noted): the non-overlapping selection against a subset brute force on 3,000 random cases; the
window search against an exhaustive grid on 400 random cases; sunlight segments against a 0.5 s brute
force on 5,028 real passes (worst boundary error 12 ms); availability expansion against Luxon in 18 zones.
Not verifiable by the reviewer, and so checked by me: the Playwright base-path run and the rendering of
the status labels in a browser.

Accepted, not changed: eclipse boundaries are sampled every 5 s (documented above); a stale
`public/data/status.json` written by an older version is trusted as written (regenerate it with
`npm start`); with the default relative base, opening the app as `/satellites` *without* the slash
depends on the host's redirect (GitHub Pages does it), whereas `npm run build:satellites` does not.

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
tests/           152 tests + labelled fixtures
CLAUDE.md          working agreements for contributors
```
