# Satellite Pass Planner

A static web app that answers one question:

> During the next several weeks, when are we available for a cluster of **multiple FM
> amateur-radio satellite passes**, each reaching at least my chosen peak elevation, all within
> a maximum span of two to three hours?

Live at **https://k1kfx.com/satellites/**. It is a **planner, not a tracker**: no live tracking, globe, Doppler,
radio/rotator control, logging, accounts or notifications. Everything runs in the visitor's browser.

Scope: FM voice repeaters, cross-band on 2 m and 70 cm, both V/U and U/V. Not built (by design): SSTV, linear
transponders, packet/APRS/telemetry/beacons, coordination with another station, date-specific availability, recurrence.

## Publishing

The live copy is the `satellites/` folder of the website repository (`k1kfx.com`, GitHub Pages, published from `main`).
There are two independent parts. Neither needs a token.

* **The app** is published by hand, rarely:
  1. Double-click `publish.bat` in this folder. It runs the tests, builds for `/satellites/`, and copies the build into the
     local website folder's `satellites/` (never anything else, and never `satellites/data/`). If anything fails it stops
     and copies nothing.
  2. In GitHub Desktop, open `k1kfx.com`, click "Pull origin", check that every changed file starts with `satellites/`,
     then commit and "Push origin".
  3. Commit and push this repository too, so GitHub has the source that was published.
* **The data** (`satellites/data/elements.json` and `status.json`) refreshes itself. The website repository's workflow
  `.github/workflows/update-satellites.yml` runs four times a day, and from its "Run workflow" button in the Actions tab.
  It checks out this repository's `main`, runs `scripts/refresh-data.ts --strict` and `scripts/validate-data.ts`, and
  commits only those two files. If a download or the check fails, nothing is committed and the data already on the site
  stays. The page reads the data files on every load, so new data needs no rebuild.

A separate fox-hunting app lives at `/hunt` on the same site. Nothing here reads, writes or links to it.

## Running it on your own computer

Needs [Node.js](https://nodejs.org/) 22.18 or newer. No account or key is involved.

```bash
npm ci          # installs exactly the locked dependency versions
npm start       # downloads current AMSAT data once, then serves http://localhost:5173/
npm test        # the automated tests (no network needed)
```

`npm start` downloads data once, at startup; leaving it running does not refresh it. Without data the app shows "Data
unavailable" and never substitutes anything. In Windows PowerShell, if `npm` is blocked, use `npm.cmd` or Command Prompt.

The tests use clearly labelled fixtures: real AMSAT data frozen on 2026-11-12 in `tests/fixtures/` (never used by the app)
and synthetic geometry in `tests/factory.ts`.

## Data sources

| Data | Source | Used for |
|---|---|---|
| Orbital elements (Keplers) | AMSAT `https://www.amsat.org/tle/current/nasabare.txt` (3-line TLEs, checksum-validated) | Pass prediction |
| Repeater activity reports | AMSAT Satellite Status API `https://status.amsat.org/api/v1/reports.php` | Eligibility |
| Frequencies, tones, restrictions | AMSAT "FM Satellites" web page (HTML only) | Hand-maintained catalog |

* Only `scripts/refresh-data.ts` talks to AMSAT. The browser cannot (AMSAT sends no cross-site permission headers) and
  never tries: it loads the two JSON files from the site's own address. Pressing Search never downloads anything.
* One run makes one request for the elements and one status request per catalog repeater (17 today), spaced a second
  apart. The status API asks clients to identify themselves and poll at most every 5 minutes.
* Failure policy: never fabricate data, and never advance a timestamp on a failed download. With `--strict`, any failure
  writes nothing at all. A well-formed answer with no reports is a success (that repeater simply stays ineligible).
* Report data is © AMSAT, **CC BY 4.0**, attributed in the app. Callsigns are not stored in the published file.
* The frequency/restriction catalog is manual. The app labels those notes "manual catalog note, not live".
* Each build also writes `version.json`. When a search starts, an open page checks it and asks for a reload if the
  planner was updated.

## How passes are counted

* **Full pass (AOS to LOS).** A pass runs from rise to set at 0° elevation (flat horizon, sea level, no terrain).
  Cluster bounds, availability fit and the overlap rule all use the full pass.
* **Minimum elevation selects a pass by its maximum elevation** ("passes that reach at least X°"). It does not mean only
  the part above X° is operable. "Time above X°" is information only.
* **Sunlight** means sunlight *at the satellite*, never local daylight; any penumbra counts as not lit. Only AO-91 is
  sunlight-dependent (AMSAT asks for no use in eclipse): it must reach the minimum elevation during a sunlit portion,
  and eclipsed time is never operating time.
* **Cluster.** Starts at the earliest counted AOS and ends at the latest counted LOS. Nothing is padded; no setup or
  arrival buffers. The selected 2 / 2.5 / 3 hours is a *maximum* span, so a 20-minute cluster qualifies.
* **Single-pass mode (Minimum passes = 1).** Every qualifying pass is its own result and the maximum span is hidden.
* **Availability.** The whole cluster must lie inside one merged availability block (adjacent periods merge). Boundaries
  are local wall-clock times in the selected zone, so DST is handled. Periods cannot cross midnight.
* **Search time.** A search uses the moment it runs and never recommends the past or a pass that has already begun.
* **One operating station (conservative).** Passes whose full AOS-to-LOS envelopes overlap conflict; touching is allowed.
  The planner counts the largest non-overlapping set. Overlapping passes are shown as alternatives.
* **Sorting** only orders results; it never changes which exist. Date (default): soonest first. Elevation: highest
  first, a cluster scored by the *lowest* peak among its counted passes. Pass count (clusters only): most first. The sort
  is applied to the complete list before the display limit (25 clusters, 100 single passes).
* **Saved events never move.** An event stores its actual interval and the satellites selected when it was saved;
  opening the Saved tab re-checks the evidence against that fixed interval and reports what changed. Events saved by a
  much older version (`schema: 1`) are left untouched in storage and can only be removed by the user.
* **Add to Google Calendar** (on saved-event cards) makes a prefilled entry: 10 minutes of setup before the first pass,
  5 minutes after the last, a compact description, no location. It is a static copy and says so.
* **No results?** The page explains why and suggests what could be relaxed. Nothing is ever relaxed automatically.

### Eligibility (deliberate; do not loosen further without the owner's say-so)

A satellite is considered **only** if its exact FM repeater entry has at least one "Heard" report in the rolling last 72
hours, measured back from the moment of the search or re-check. A satellite without one is left out of planning entirely
(never in timelines, pass cards, counts or ranking) and is listed, with the reason, in a collapsed "Satellites not
considered" area. Being left out means *this planner lacks the evidence*, not that the satellite is inactive.

**Newer misses do not remove a satellite; the operator decides.** Every satellite heard in the window gets a checkbox
under "Satellites to consider", with its report tally beside it ("47 heard · 1 not heard"). When the misses are
corroborated (at least 2 negative reports from at least 2 different stations since the last "Heard") the row carries a
⚠ warning. A warned satellite is planned only if its box is ticked, it starts unticked for someone who has never chosen,
and the warning follows it onto its pass cards, any event that contains it, and the calendar entry. One station's miss
never raises the warning. (Until November 2026 any newer negative removed the satellite outright; one "Not Heard" from
one station was then hiding SO-50 despite 47 "Heard" reports.)

A recent report is necessary, not sufficient. The catalog classifies each repeater from its own cited source:

* *Interruptible* (ISS): normally on, sometimes switched off. Qualifies on a recent report; badge "Subject to ISS operations".
* *Activation required* (CAS-3H, IO-86, PO-101, RS95S): scheduled, experimental or commanded. Excluded until an
  activation-confirmation source exists.
* *Sunlight-only* (AO-91): independent of both.

AMSAT lists each mode of a satellite as its own entry (`ISS_[FM]`, `ISS_[SSTV]`, ...). The refresh requests only the exact
FM key, ingestion rejects any row with a different name, and the classifier reads only that key. Report values:

| AMSAT value | Meaning here | Can make the repeater count? |
|---|---|---|
| Heard | Someone worked or heard the FM repeater | Yes, if within 72 hours |
| Telemetry Only | Only the beacon was heard | No (a miss; counts toward the warning) |
| Not Heard | Nothing received | No (a miss; counts toward the warning) |
| Crew Active | ISS crew voice | No (ignored) |

Resulting labels: **Recently reported active** (eligible); **Mixed reports** (eligible, with the ⚠ warning); **Not heard
(unconfirmed)**, **Confirmed unavailable** (2+ negatives from 2+ operators and no "Heard"), **No recent reports**,
**Activation window required**, **Status data unavailable** (all left out). These are volunteer reports; "confirmed"
means repeatedly reported, not verified by AMSAT.

Selection: ISS, SO-50 and AO-91 start selected when eligible and not carrying the warning. The choice is stored exactly as made: a temporarily
ineligible satellite stays selected, and an unchecked one is never re-selected.

Freshness line: "Keplers updated ... · Activity reports updated ..." is when each file was last successfully
*downloaded*, not an element epoch or a report time. The page warns when the activity reports are over 24 hours old, and
after 72 hours no satellite can qualify.

## Policies (in `src/domain/policy.ts`)

| Policy | Value |
|---|---|
| Status freshness window | 72 h back from the search |
| "Confirmed unavailable", and the ⚠ warning | at least 2 negative reports from at least 2 stations (with no "Heard" at all; or since the last "Heard") |
| Orbital-elements age limit | 30 days (older sets are skipped and named in the results) |
| Shadow rule | shadow fraction ≥ 0.01 = not sunlit |
| Elevation input | 5° to 85° (default 40°) |
| Search span | default 28 days, at most 42 |
| Calendar entry buffers | 10 min before, 5 min after, 15 min minimum |

These are this app's choices, not guarantees from AMSAT or satellite owners. A "Heard" report in the last 72 hours is always required, so
with three passes required you may see empty results.

## Catalog maintenance

`src/catalog/catalog.ts` has three layers: `SATELLITES` (identity by NORAD ID), `FM_REPEATERS` (frequencies, CTCSS tones,
AMSAT status key) and `RESTRICTIONS` (each with source and date). To add a satellite:

1. Add it to `SATELLITES`.
2. Add its `fm(...)` row with uplink/downlink MHz (must be 2 m/70 cm cross-band; the code throws otherwise).
3. Set `amsatStatusKey` to its exact name in `https://status.amsat.org/api/v1/catalog.php` (for example `SO-50_[FM]`).
4. Add any `RESTRICTIONS` rows with the source and its date. Use `sunlight-only` only if a source says so. When unsure of
   the operating pattern, use `activation-required`, the conservative choice.
5. Update `CATALOG_SOURCE_DATE` and run `npm test`.

Re-check AMSAT's FM page now and then; the catalog does not update itself.

## Limits worth knowing

* Predictions use SGP4 from one set of elements. The further ahead, the more a real satellite drifts. The app claims no
  second-level accuracy weeks ahead and computes no confidence intervals. Treat a date three or four weeks out as a good
  *choice of day*, then re-check in the days before.
* Activity reports show evidence of operation *now*, not a promise for an event weeks away.
* Observer height is 0 and there is no terrain mask. Eclipse boundaries are sampled every 5 seconds.

## Privacy

Location, availability and saved events live only in the visitor's own browser (`localStorage`). The location is never
guessed: it is empty until typed or "Use my current location" is pressed. Nothing is sent to any server. No accounts,
analytics or cookies.

## Project layout

```
publish.bat      test, build and copy the app into the local website folder
src/
  domain/        types, interval helpers, policy constants
  catalog/       satellite identity · FM repeater config · restrictions
  data/          parsing and validation · browser loading · update check
  orbit/         pass prediction (satellite.js) in a Web Worker
  eligibility/   activity reports → status · pass + sunlight assessment
  availability/  weekly grid → absolute intervals (Luxon)
  cluster/       non-overlap selection, cluster search, sorting
  saved/         saved events and their re-check
  export/        calendar entry text and the Google Calendar link
  planner.ts     orchestration and "no results" diagnosis
  ui/            React components and styles
scripts/         refresh-data.ts · validate-data.ts
tests/           test suite and labelled fixtures
CLAUDE.md        working agreements for AI assistants
```
