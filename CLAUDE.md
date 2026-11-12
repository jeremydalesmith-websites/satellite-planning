# CLAUDE.md: working agreements for this repository

## What this is
A static web app (TypeScript, Vite, React, `satellite.js`) that plans **family
radio-club events** around **clusters of FM amateur-radio satellite passes**.
It is a **planner, not a tracker**. Read `README.md` first; it documents how
passes are counted, the policy constants, the data sources and the limits.

## Agreed scope (do not expand without explicit approval)
In scope: FM repeaters only, cross-band 2 m / 70 cm, both V/U and U/V; location,
timezone, date range (default 28 days, max 42), minimum peak elevation
(default 40°), maximum cluster span (2 / 2.5 / 3 h), minimum opportunities (default 3,
2 allowed), weekly Sun–Sat × Morning/Midday/Evening availability; cluster
finder and ranking; saved events re-checked against fresh data.

Out of scope (deferred): SSTV, linear transponders, packet/APRS/telemetry/beacon
activities, mutual visibility, live tracking/globes/ground tracks, Doppler,
radio or rotator control, QSO logging, setup-gap settings, notifications,
email, accounts, date-specific availability, recurrence rules, multiple
availability profiles. Keep internal types extensible, but do not build these.

No Firebase, database, authentication, paid prediction API, LLM API, or secrets
in frontend code. Use `satellite.js` for orbital mechanics; do not hand-roll it.

## Rules that must not be weakened silently
* **Never fabricate or substitute data.** Missing orbital data = a visible
  "Data unavailable" state. Test fixtures (`tests/fixtures/`) are real but
  frozen and must stay clearly labelled; they are never used by the app.
* **Operational eligibility is deliberately strict** (`src/domain/policy.ts`,
  `src/eligibility/status.ts`, `src/eligibility/eligibility.ts`). A satellite is considered
  only with a "Heard" report for its exact `_[FM]` entry in the rolling last 72 hours
  (measured from the time of the search or saved-event re-check, one time snapshot each),
  with no newer negative. Unknown, stale, mixed-report, unconfirmed and
  status-data-unavailable repeaters are **excluded entirely**: never in timelines, pass
  cards, counts or ranking; only listed with a reason in the collapsed diagnostic area,
  worded as missing evidence (never "inactive"). There is no conditional tier and no
  "show unconfirmed" option. A heard beacon never establishes repeater use. A recent
  report is necessary, not sufficient: sunlight still applies, and the catalog classifies each repeater's
  operating pattern from its own cited source. `interruptible` (ISS, per ARISS: normally full-time, sometimes
  switched off) qualifies on recent evidence. `activation-required` (scheduled, experimental or commanded
  activation: CAS-3H, IO-86, PO-101, RS95S) never qualifies from reports alone and is excluded until an
  activation-confirmation source exists. Do not describe the ISS repeater as available only when astronauts
  operate it. Classify any new satellite individually; when unsure, use `activation-required`.
  **Do not loosen this to produce more windows.** If a change is proposed, first explain
  the rules and which satellites/opportunities they exclude, then wait for approval.
* The user's satellite selection is stored exactly as chosen and is never edited by
  eligibility (a temporarily ineligible satellite stays selected; unchecked ones are
  never re-selected). Defaults: ISS, SO-50, AO-91 when eligible.
* Searching and re-checking saved events re-evaluate eligibility against existing
  reports; they never download new ones. Do not word the UI as if a refresh happened.
* Never silently lower the elevation threshold, add availability hours, or count
  unconfirmed satellites. Empty results explain themselves and only *suggest*.
* Sunlight means sunlight **at the satellite**, never local daylight.
* Minimum elevation **selects a pass by its maximum elevation**; it does not mean only the part above X° is
  operable. A sunlight-dependent repeater must reach it during a sunlit portion. No terrain mask or adjustable
  low-elevation cutoff exists. Do not reintroduce "usable time" wording: use "Full pass", "Sunlit operating
  interval" and "Time above X°" (information only).
* A cluster's bounds are the earliest full-pass AOS to the latest full-pass LOS of the counted passes (by timestamp),
  duration = elapsed time between them. The selected hours are a MAXIMUM span, never padded; no setup/arrival
  buffers. The whole cluster must fit inside one availability block.
* One operating station, conservative: passes whose FULL AOS-to-LOS envelopes overlap conflict; overlapping passes
  are shown as alternatives, never as independent opportunities. Operating time never includes eclipsed time.
* Displayed bounds round outward to the second so a header never appears to exclude part of a counted pass.
* Saved events never move; only their evidence is recomputed. New events (`schema: 2`) store the actual cluster
  interval. Older `schema: 1` events are never re-interpreted: leave them untouched in storage; only the user may
  remove them.
* Do not claim second-level accuracy weeks ahead or invent confidence intervals.
* Catalog entries (`src/catalog/catalog.ts`) are manual and sourced; label them
  as such. Only mark a repeater sunlight-dependent if a cited source says so.

## Verification commands (run before every push)
```bash
npm ci               # install exactly from package-lock.json (Node >= 22.18)
npm run typecheck    # tsc --noEmit
npm test             # vitest; needs no network (uses frozen fixtures)
npm run build        # typecheck + production build into dist/ (relative base)
npm run build:satellites   # same, with the intended public base /satellites/
```
Base-path check (needs Playwright): build, `node scripts/serve-subdir.mjs /satellites/ 4173 &`, then
`node scripts/e2e-basepath.mjs http://localhost:4173 /satellites/` (all 18 checks must pass).
For a working preview with real data: `npm start` (downloads AMSAT data, then
serves http://localhost:5173/). Behind a proxy prefix with `NODE_USE_ENV_PROXY=1`.
Independent prediction validation: see `docs/VALIDATION.md` (needs Python).

## Git and review workflow
* **Never push directly to `main`.** Work on a `feature/<name>` branch, commit
  in logical steps, push the branch, and open a pull request.
* **Do not merge a pull request, enable GitHub Pages, deploy, add or run
  deployment/scheduled workflows, or change DNS/domain settings without the
  owner's explicit approval** for that specific action. Approval for one phase
  does not carry over to the next.
* Work in the agreed phases; when a phase is ready, summarise and stop for review.
* Do not add GitHub Actions workflows unless the current phase's approval says so.
* The owner's existing website and domain (`k1kfx.com`) are not part of this
  repository: do not modify them or assume the domain is dedicated to this app.
  Intended public URL: `https://k1kfx.com/satellites/`; a separate fox-hunting app
  lives at `/hunt` and must never be read, linked, or overwritten. Keep the base path
  configurable (`VITE_BASE_PATH` / `--base`, default relative). How `/satellites/` maps
  to this repository is undecided and needs the owner's approval in the deployment phase.
* Install with `npm ci` (locked versions), not `npm install`, unless changing dependencies.
* AMSAT status reports are matched to the exact `_[FM]` entry; other modes and beacon-only
  reports must never establish repeater availability (see README).

## Privacy
Treat the owner's identity and location as private. Do not put personal details
in requests to external services; the refresh script uses a generic User-Agent
(`SAT_PLANNER_CONTACT` is an optional, owner-supplied suffix). Test fixtures and
examples use an arbitrary location, never the owner's real one.

## Data sources (see README for details)
AMSAT `nasabare.txt` (TLEs) and the AMSAT status API
`https://status.amsat.org/api/v1/` (poll no more than every 5 minutes; descriptive
User-Agent; reports are CC BY 4.0, attribution shown in the app). CelesTrak was
not used. Frequencies/restrictions come from AMSAT's human-readable FM page and
are hand-maintained.
