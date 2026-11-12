# FM Satellite Event Planner

A static web app that answers one question:

> During the next several weeks, when are we available for a cluster of **multiple FM
> amateur-radio satellite passes**, each reaching at least my chosen peak elevation, all within
> a maximum span of two to three hours?

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
"Tests" names the files under `tests/`; "browser check" means a manual Playwright run (not part of `npm test`; see Testing for the one-time browser install).

| # | Requirement | Status | Evidence | Limitations |
|---|---|---|---|---|
| 1 | Find clusters of qualifying FM passes inside my availability; search up to 42 days, marked provisional | Done | `cluster`, `availability`, `planner` | "Tentative/provisional" are wording tiers (>7 / >28 days past the elements epoch), not accuracy figures |
| 2a | TypeScript, Vite, React, `satellite.js`, phone + desktop | Done | build, typecheck, browser check | Phone layout verified in a 390 px Chromium window only, not on real devices |
| 2b | Static, GitHub Pages-compatible, configurable sub-directory | Done | `scripts/e2e-basepath.mjs`: 18/18 checks under `/satellites/` (relative and absolute base) and `/tools/sat/` | Not published; the mapping of `/satellites/` to this repository is a deployment-phase decision (see below) |
| 2c | Local storage for preferences and saved events | Done | `ui` tests, browser reload check | Per-browser only; cleared if the user clears site data |
| 2d | Scheduled GitHub Actions data refresh | **Not yet** | `scripts/refresh-data.ts` works by hand | No workflow in this phase (Phase 3, needs approval) |
| 2e | No Firebase/DB/auth/paid API/LLM; no secrets in frontend | Done | code review | The refresh script sends a generic User-Agent |
| 3 | FM repeaters only, 2 m/70 cm cross-band, V/U and U/V; extensible internal model | Done | `planner` (catalog) | `ActivityKind` has one value today; SSTV etc. deliberately not built |
| 4 | Inputs: location (manual + optional button), timezone, date range, min peak elevation, maximum cluster span, min opportunities, validation | Done* | `ui` (validation, defaults, geolocation never called unprompted), `availability` | Real browser geolocation not tested; minimum opportunities accepts 2 to 10 (not 1); elevation limited to 5 to 85 degrees |
| 5 | Weekly Sun-Sat x Morning/Midday/Evening grid; editable boundaries; merge adjacent; the whole cluster must fit; explicit selection; accessible | Done* | `availability`, `ui` | Periods cannot cross midnight; touch usability not tested on real phones; a period boundary inside a spring-forward gap snaps to the moment the clocks jump |
| 6 | Local SGP4 predictions with refined rise/peak/set/threshold/eclipse; three timestamps; Worker | Done | `predict` (vs 1 s brute force), `docs/VALIDATION.md` (vs Skyfield) | No confidence intervals (intended); observer height fixed at 0; no terrain mask; eclipse boundaries are sampled every 5 s, so a shadow shorter than 5 s inside one pass could be missed (none found in 5,028 real passes) |
| 7a | Curated catalog in three separate layers with sources | Done* | `planner` (catalog) | Frequencies/restrictions are hand-copied from one AMSAT page dated 2026-10-31. "Status timestamp/explanation" is held per restriction (`asOf`, text) plus a catalog-wide review date, not as per-satellite fields |
| 7b | AMSAT activity ingestion; FM-mode matching; four operating states; strict counting | Done | `ingest`, `eligibility` | Reports are volunteer observations; whether an operator filed under the right mode cannot be verified |
| 8 | Sunlight at the satellite, partial eclipse, eligible-portion elevation, explained exclusions | Done* | `eligibility`, `planner` (ISS real-orbit tests), Skyfield comparison | Only AO-91 is flagged sunlight-dependent (only it has a cited source); any penumbra counts as not sunlit |
| 9 | Cluster finder: full-pass non-overlapping count, maximum span, availability fit, duplicate removal, ranking, honest empty results | Done | `cluster`, `planner` (vs an independent brute-force reference) | Conservative single-station rule; touching passes count as sequential with no setup gap |
| 10 | Event cards and pass cards with all required fields | Done* | browser check, screenshots | `EventCard`, `PassCard` and the timeline have no component tests; the timeline is decorative (`aria-hidden`) with the same information in text |
| 11 | Saved events stay fixed; recomputed; changes and minimum warning | Done* | `saved` | Re-checked when the Saved tab is opened (not on app load); local to one browser. Events saved by an earlier version (fixed-window model) are not re-interpreted: they are left untouched in storage, not shown, and removable on request |
| 12 | Separate testable modules; required test list; independent validation | Done* | the `npm test` suite; `docs/VALIDATION.md` | Skyfield validation needs Python and is not in `npm test`; it checks the implementation, not real-world accuracy |
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

The test suite (`npm test`) needs no network. It uses **clearly labelled fixtures**: real AMSAT
elements and status reports frozen on 2026-11-12 in `tests/fixtures/`, plus
synthetic geometry in `tests/factory.ts` where an exact boundary is needed.
They cover elevation-threshold boundaries; partial eclipse and local-night vs
satellite-sunlight; adjacent availability periods; time zones and DST
(spring-forward, fall-back, southern hemisphere); overlapping passes;
cluster bounds, maximum span and availability fit; repeated passes of one satellite; unknown/stale status;
duplicate-cluster removal; saved events staying fixed; empty results and
unavailable data; and form validation / accessibility of the availability grid.

Independent validation against Skyfield is documented in
[`docs/VALIDATION.md`](docs/VALIDATION.md) (112–223 passes per case agree to
≤0.22 s and ≤0.007°; discrepancies explained there).

Two manual browser checks (need Playwright, which is a dev dependency installed by `npm ci`, plus a separate one-time
browser download, `npx playwright install chromium`; not part of `npm test`): `scripts/e2e-smoke.mjs` (form, search, save,
phone layout, with screenshots) and `scripts/e2e-basepath.mjs` (sub-path behaviour; see Deployment).

## Deployment and base path

> **Not published and not enabled.** This repository has **no GitHub Actions workflows**,
> Pages is not enabled, and no domain or DNS is configured. A refresh-and-deploy workflow is a
> later phase that needs your approval.

**Deployment prerequisites (recorded, not implemented):** the data files `public/data/*.json` are git-ignored and
`npm run build` does not fetch them, so a build from a fresh checkout succeeds but deploys a site that shows "Data
unavailable". A hosted beta therefore needs (1) a scheduled job that runs the refresh and then builds, with the
data fetched at build time; (2) a build-time check that fails or warns when the data is missing or old, since nothing
rejects old data today; (3) a rebuild at least daily, because the 72-hour rule means a copy that is not rebuilt shows
no eligible satellites after about three days; and (4) the `/satellites/` mapping decision below. Verification
also needs the one-time Playwright browser install above.

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
node scripts/e2e-basepath.mjs http://localhost:4173 /satellites/    # needs Playwright + `npx playwright install chromium` (once)
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

* **Full pass (AOS to LOS).** A pass runs from rise to set at 0° elevation (flat horizon, observer at
  sea level; terrain and obstructions are not modelled). This whole interval is the pass's **envelope**.
  Cluster bounds, availability fit and the one-station overlap rule all use the full pass.
* **Minimum elevation selects a pass by its MAXIMUM elevation.** "Include passes that reach at least X°."
  It does not mean only the part above X° can be operated; no low-elevation cutoff or terrain mask exists.
  For a sunlight-dependent repeater (AO-91) the elevation must be reached **during a sunlit portion**: a high
  peak while the repeater may not be used does not qualify the pass.
* **Permitted operating time** is separate from the pass. It is the whole pass for an unrestricted repeater and
  only the sunlit portions for a sunlight-dependent one. Eclipsed time is never part of anything labelled
  operating time. "Time above X°" is shown in Details as information only; it selects and schedules nothing.
* **Sunlight** is sunlight *at the satellite* (satellite.js `sunPos` +
  `shadowFraction`), never local daylight. A night-time event can have a lit
  satellite. Any penumbra counts as not lit. Only AO-91 is flagged
  sunlight-dependent, because AMSAT's FM page asks for no use in eclipse.
* **Cluster.** A cluster is a set of counted passes. Its start is the earliest full-pass AOS and its end the
  latest full-pass LOS among them (by timestamp), so its duration is the elapsed time between those endpoints,
  gaps included. Nothing is padded and there are no setup, arrival or departure buffers. The header shows exactly
  these bounds (rounded outward to the second, so it never appears to exclude part of a pass) and the duration.
* **Maximum cluster span.** The selected 2 / 2.5 / 3 hours is a *limit*, not a required or padded event length:
  a 20-minute cluster qualifies for a two-hour maximum. The cluster's span (AOS to LOS) must not exceed it.
* **Availability.** The whole AOS-to-LOS cluster must lie inside one merged availability block (Midday +
  Evening merge into one block). A pass that begins before or ends after the block does not count, even if
  its peak is inside. Period boundaries are local wall-clock times in the selected zone, converted per day with
  Luxon, so DST is handled. A boundary that falls in the repeated hour of a fall-back day takes the earlier instant,
  resolved explicitly so the result never depends on the date the page is opened. Periods cannot cross midnight.
* **Search time.** Every search uses the time it is run (one snapshot), however long ago the form was filled in, and
  the range starts no earlier than that moment: past passes and clusters can never be recommended. A pass that has
  already begun (AOS before the search time) is not recommended, because a cluster must lie wholly in the available
  future; one whose AOS is exactly the search time still can.
* **Overlap rule (one operating station, no setup gap; conservative).** Two passes conflict if their **full
  AOS-to-LOS envelopes overlap**, even if they overlap only at low elevation. Touching end-to-start is allowed.
  The planner counts the largest set of pairwise non-overlapping passes in a cluster. Ties go to more total
  permitted operating time (never including eclipsed time, never double-counted, since counted passes do not
  overlap), then higher summed peak elevations. Overlapping qualifying passes inside the cluster are shown as
  *alternatives*, not as independent opportunities. This is deliberately conservative: it can count fewer
  passes than an operator who works two low-elevation tails could manage.
* **Ranking:** (1) number of passes, (2) total permitted operating time, (3) sum of maximum elevations,
  (4) earlier start. There is no opaque score. Clusters with exactly the same counted passes appear once.
  Distinct sets are all kept: a shorter cluster with fewer passes is a separate result next to a longer one.
  At most 25 clusters are shown.
* **Saved events.** A new event stores the actual cluster interval from its header and is re-checked against
  that fixed interval (`schema: 2`). A pass that drifts so its full pass crosses the saved edge is flagged,
  not followed. A new event also stores the satellites that were selected when it was saved, and re-checks consider only
  those, so an unselected satellite can never appear (older records without a stored selection fall back to the
  satellites that were originally counted, the conservative choice). Because the saved edges are exact AOS/LOS instants, a pass within 2 seconds of them still counts as
  inside (recomputing the same pass moves its edges by tens of milliseconds, which is not drift). Events saved by an earlier version (`schema: 1`, the fixed-window model) are never
  re-interpreted: they are left untouched in storage, not shown or re-checked, and the Saved tab offers an explicit
  "Remove" for them.
* **Strict eligibility.** A satellite is considered **only** if its exact FM repeater entry has a
  "Heard" report in the rolling last 72 hours, measured back from the time of the search (or of the
  saved-event re-check), with no newer negative report. A satellite without that evidence is left
  out of planning entirely: never in timelines, pass cards, counts or ranking. It is listed, with
  the reason, in a collapsed "Satellites not considered" area under the results. Being left out means
  *this planner lacks the required evidence*, not that the satellite is inactive. There is no
  "conditional" or "unconfirmed" tier and no option to show unconfirmed passes.
* **Necessary, not sufficient.** A recent report never overrides the catalog's operating-pattern
  classification (reviewed per satellite from its cited source) or sunlight:
  * *Interruptible* (ISS): normally operating, subject to interruptions. ARISS expects the ISS radios to
    run full time except during educational contacts, spacewalks, dockings and undockings. It qualifies on a
    recent positive FM report like any normally operating repeater, with no per-pass activation
    announcement; the pass card shows a "Subject to ISS operations" badge and the explanation and ARISS
    sources are under Details.
  * *Activation required* (CAS-3H, IO-86, PO-101, RS95S): scheduled, experimental ("on during testing") or
    otherwise separately activated, so a recent report does not show it will be on for a predicted pass.
    Such a satellite would qualify only with confirmation covering that pass. No schedule importer exists
    yet, so none can be confirmed and they are excluded, with the reason, in the diagnostic list.
    (CAS-3H is the judgment call: AMSAT gives it "no set schedule" and no published window, so it is
    classified conservatively here.)
  * *Sunlight-only* (AO-91): independent of both; an eclipsed part of a pass is never used.
  The rule shows evidence of operation *now*, not that the repeater will operate at an event weeks ahead.
* **Selection.** You choose which eligible satellites to consider. ISS, SO-50 and AO-91 start
  selected; any other eligible repeater starts unchecked. An unselected satellite never appears in or
  affects results. Your choice is stored exactly as you made it (in this browser): a satellite that is
  temporarily ineligible stays selected and returns by itself when it qualifies again, and one you
  unchecked is never re-selected for you.
* **Status age.** A compact line beside the results says how old the status reports are ("Status updated 2 hours
  ago."), judged from when the *status* was downloaded (not the orbital data). It becomes a warning after 24 hours
  (reports filed since the download are not included) and states plainly after 72 hours that nothing can qualify.
  Missing status data is called out; the full timestamps stay in the collapsed footer.
* **Checking vs downloading.** Searching or opening saved events *re-checks the existing reports
  against the current time* (one time snapshot per search or re-check). It does **not** download new
  reports; the page shows when the reports were downloaded (by `npm run refresh-data` / `npm start`) and
  when eligibility was checked.
* **No results?** The page explains why and suggests what could be relaxed
  (fewer opportunities, lower elevation, longer event, more availability). Nothing is ever relaxed
  automatically, and unconfirmed satellites are never suggested as a way to get more windows.

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

| Label (diagnostic detail) | When | Eligible for planning? |
|---|---|---|
| **Recently reported active** | at least one "Heard" in the last 72 h and no newer negative | **Yes** (if selected) |
| **Mixed reports** | "Heard" reports **and** a newer negative (not heard / beacon only) | No: left out |
| **Not heard (unconfirmed)** | negative report(s) only, but fewer than 2 reports or fewer than 2 operators | No: left out |
| **Confirmed unavailable** | at least 2 negative reports from at least 2 operators, no "Heard", all in the last 72 h | No: left out |
| **No recent reports** | no reports in 72 h | No: left out |
| **Activation window required (not confirmed)** | catalog classification `activation-required`, whatever the reports say | No: left out (until a confirmation source exists) |
| **Status data unavailable** | the status file could not be loaded | No: left out ("eligibility cannot be established") |

The classification is unchanged; only its consequence is. Every row except the first is left out
of planning and shown only in the collapsed diagnostic list, worded as missing evidence, for example
"TEVEL2-1: no qualifying FM report in the last 72 hours." "Confirmed" here means *repeatedly reported by
several operators*, not verified by AMSAT.

## Policies (tunable assumptions)

These are this app's **choices**, not guarantees from AMSAT or satellite
owners. All live in `src/domain/policy.ts`.

| Policy | Value | Effect |
|---|---|---|
| Status freshness window | 72 h, back from the time of the search | Only reports within it can make a satellite eligible |
| "Confirmed unavailable" | ≥2 negative reports from ≥2 operators, no positive | Left out (one negative = just "not heard (unconfirmed)", also left out) |
| "Mixed reports" | newest report negative after a positive | Left out |
| Default selection | ISS, SO-50, AO-91 (when eligible) | Other eligible satellites start unchecked |
| Orbital-elements age limit | 30 days | Older sets are skipped and named in the results |
| Prediction labels | >7 d "tentative", >28 d "provisional" (days past elements epoch) | Wording only, not an accuracy figure |
| Shadow rule | shadow fraction ≥ 0.01 = not sunlit | Conservative for eclipse-restricted repeaters |
| Elevation input | 5°–85° | |
| Search span | ≤ 42 days | |

A consequence worth knowing: the status policy is deliberately strict. Few
repeaters have a recent "Heard" report at any moment, so with ≥3 opportunities
required you may see empty results. Relaxing to 2 is a decision left to you; the
planner never counts unconfirmed satellites. Status is also a snapshot of *now*; for an
event weeks away it is the best available evidence, not a promise.

## Catalog maintenance

`src/catalog/catalog.ts` has three separate layers:
`SATELLITES` (identity by stable NORAD ID), `FM_REPEATERS` (frequencies, CTCSS
tones, AMSAT status key) and `RESTRICTIONS` (`sunlight-only` / `interruptible` /
`activation-required` / notes, each with source and date). To add a satellite:

1. Add it to `SATELLITES` (NORAD ID, name, aliases).
2. Add its `fm(...)` row with uplink/downlink MHz (bands are derived and must
   be 2 m/70 cm cross-band; the code throws otherwise).
3. Set `amsatStatusKey` to its name in AMSAT's status catalog
   (`https://status.amsat.org/api/v1/catalog.php`, for example `SO-50_[FM]`).
4. Add any `RESTRICTIONS` rows with the source page and its date. Use
   `sunlight-only` only if a source says so. Classify the operating pattern from that satellite's own
   source text: `interruptible` only for a normally operating repeater that is sometimes switched off;
   `activation-required` for scheduled, experimental or commanded activation (it will be excluded
   until a confirmation source exists). When unsure, use `activation-required`, the conservative choice.
5. Update `CATALOG_REVIEWED_AT` / `CATALOG_SOURCE_DATE`, run `npm test`.

The refresh script and the app pick it up automatically. Re-check AMSAT's FM page
periodically; the catalog does not update itself.

## Independent review (what it found and what was done)

A separate reviewer agent, given only the requirements and the code, read the cluster finder,
sunlight eligibility, time-zone handling and base-path code and probed them with randomized
checks. **A review by an AI, even a clean one, is not proof of correctness**; it found real defects
the original tests had missed, which is the point of asking.

Fixed (each first reproduced by a failing test):
* (Historical: padded windows were later removed in favour of exact full-pass clusters.)
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
  cluster/       full-pass non-overlap selection, cluster search, duplicate removal, ranking
  saved/         snapshots (schema 2), fixed-interval re-check, change comparison
  planner.ts     orchestration + "no results" diagnosis
  ui/            React components and styles
scripts/         refresh-data.ts · smoke.ts · serve-subdir.mjs · e2e-smoke.mjs
validation/      independent Skyfield comparison
tests/           test suite + labelled fixtures
CLAUDE.md          working agreements for contributors
```
