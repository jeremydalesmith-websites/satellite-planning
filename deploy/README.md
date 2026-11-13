# Automated data update for k1kfx.com/satellites/ (manual run verified; daily schedule proposed)

**Status.** `update-satellites.yml` lives in this folder as the reviewed source. The **manual-only** version was installed in the
website repository's `.github/workflows/` and run once by hand (run #3), and the public site was verified afterwards (see "Rollout").
**This version adds the daily schedule and is a proposal: it is not installed until the owner approves that specific change.**
It sits in `deploy/`, not in `.github/workflows/`, so it cannot run from this repository.

## The arrangement it keeps

The planner is live at `https://k1kfx.com/satellites/` because its built output is copied into the `satellites/` folder
of the website repository (`k1kfx.com`, branch `main`), which GitHub Pages serves ("deploy from a branch"). The workflow
keeps that arrangement: no Cloudflare project, no DNS change, no change of Pages source, no backend, no public "Update
now" button, and no polling in the browser. It automates the copy that is now done by hand with GitHub Desktop.

## Rollout: manual first, then the schedule

1. **Installed, manual only** (done). The workflow file was added to the website repository with `workflow_dispatch` as its only
   trigger. GitHub first rejected that copy for a YAML syntax error (an unquoted colon in a step name); the corrected file was
   installed and accepted.
2. **One manual run, verified** (done: run #3 succeeded). The public `data/status.json` and `data/elements.json` showed new
   download times; `version.json` named the pinned build; the single bot commit changed only files under `satellites/`;
   `hunt/`, `CNAME` and the root page were untouched; the live planner loaded and searched normally, with the new
   "Keplers updated … · Activity reports updated …" line; and the Pages build for the bot commit succeeded.
3. **Schedule** (this proposal). One daily trigger is added, as a separate reviewed change to the workflow file:
   ```yaml
   on:
     schedule:
       - cron: '17 9 * * *'
     workflow_dispatch: {}
   ```
   * **When:** every day at **09:17 UTC**. In US Central time that is **3:17 AM** while standard time applies (about early
     November to mid-March, UTC−6) and **4:17 AM** during daylight time (UTC−5). GitHub schedules use UTC and do not follow
     daylight saving, so the local time shifts by an hour twice a year. The minute is deliberately off the hour, because GitHub
     delays runs that start at the top of the hour when load is high.
   * **Why then:** the activity reports are volunteer-submitted during the day; a morning run (US time) collects the previous
     day's reports, and a fresh copy is waiting before anyone plans the day.
   * **Same safeguards:** the same pinned planner commit, strict all-or-nothing refresh, validation, a guard that only
     `satellites/` may change, one run at a time, and the failure issue on error.
   * **Checks after the first scheduled run** (the first one starts at the next 09:17 UTC after installation): it appears in the
     Actions tab as triggered by "schedule", it succeeds, the public data timestamps advance, and only `satellites/` changed.
   * **To stop it:** remove the `schedule:` lines (or disable the workflow in the Actions tab); the manual button keeps
     working.

## What one run does

Daily at 09:17 UTC once the schedule is installed, and whenever the owner presses **Run workflow** in the website repo's Actions tab:

1. Stops at once, with a clear message, if the push token secret is missing or if GitHub Pages is no longer published from
   the `main` branch (checked through the Pages settings API), before anything is changed.
2. Checks out the **approved planner version** (see below), without leaving any credential in its Git configuration.
3. `npm ci`, then `npm run refresh-data:strict`: downloads fresh Keplers (AMSAT `nasabare.txt`, one request) and
   activity reports (17 spaced requests) with the planner's existing refresh code. Strict means **all or nothing**: if
   any request fails or returns a malformed response, nothing is written and the run stops. The whole download phase is
   limited to 6 minutes (see "Time limits").
4. `npm run validate-data`: both files well formed; downloaded within the last 3 hours; every catalog satellite has
   orbital data; every repeater has a status entry with no recorded failure; no report dated in the future.
5. `npm test` (no network), then `npm run build:satellites` (type-check, then a build with base `/satellites/`), then
   checks of the built output, including a second validation of the exact files that will be published.
6. **Only now** checks out the website (`main`), again without persisting credentials, and replaces **only**
   `satellites/` (`rsync --delete` from `dist/`). It refuses to continue if Git sees any changed path outside
   `satellites/` (so `hunt/`, `CNAME`, `index.html` and every other page are safe).
7. Commits as `github-actions[bot]` and pushes to `main` using the push token, never forced: it rebases over any
   newer website commit made meanwhile, so newer work is never overwritten.
8. **Asks GitHub Pages to build** (explicit API request, see below), then polls (up to 15 minutes) until the **public**
   site serves the new data download time, stopping early if the build of that commit reports an error.
9. On failure, opens (or comments on) one issue titled "Satellite data update failed" with a link to the run (best
   effort; see "Time limits").

Because the push is the **last** step before the live check and every earlier step must succeed, a failed download,
validation, test or build leaves the current publication exactly as it was. This is tested with the real scripts (see
"Failure behaviour, tested" below). A run does not start itself again: there is no `push` trigger.

### Activity reports: "no reports" is not a failure

A repeater whose status response is well formed but contains no reports is a **successful** answer. Its entry is stored
with an empty list, it has no "Heard" report, so it stays **ineligible**, and it does not stop the other repeaters' data
from being published. Even if every repeater answered "no reports", the update still publishes (validation prints a
warning) and nothing becomes eligible. What does stop the run is a **failed or malformed** response: an HTTP error or
timeout (after three tries), invalid JSON, a body without the expected `data` list, or rows for the repeater that cannot
be read at all. A permanent failure for one repeater (for example AMSAT renaming a status key, which answers
"satellite not found") therefore blocks publication and raises the issue until the catalog is corrected; that was chosen
deliberately because a missing answer cannot be told apart from a wrong key. Download times are the true time of the
successful download and are never advanced by a failed one.

## How the site is published (explicit, checked against GitHub's documentation)

* **Documented by GitHub:** "Commits pushed by a GitHub Actions workflow that uses the `GITHUB_TOKEN` do not trigger a
  GitHub Pages build" (docs.github.com, *Configuring a publishing source for your GitHub Pages site*). The site is published
  from the `main` branch, so a bot push alone would update the files **without publishing**. The workflow therefore does not
  depend on the push to publish, and "push, wait and see" is not the mechanism.
* **The mechanism:** after the push the workflow calls GitHub's **Request a GitHub Pages build** API,
  `POST /repos/{owner}/{repo}/pages/builds`, and then reads `GET /repos/{owner}/{repo}/pages/builds/latest` to follow it.
  That keeps the existing branch-based setup; nothing about the Pages source changes.
* **Verified from GitHub's documentation** (the REST pages API and the permissions tables):
  * It builds **the latest revision of the default branch** ("the same effect as pushing a commit"), which is `main`.
  * Limit: **one concurrent build per repository and one per requester**; a request made while one runs is queued, so a
    second request (the push may also have started a build) is harmless. Success is `201 Created`.
  * Permission: the repository permission **Pages** at **write** (requesting) and **read** (the build-status reads). The
    permissions table lists these endpoints for user access tokens and installation tokens, and the page says classic
    tokens and OAuth tokens need the `repo` scope.
  * **Not documented:** whether the built-in `GITHUB_TOKEN` (`pages: write`) may call it. It is therefore **not used** for it.
* **Authentication:** one **fine-grained personal access token** stored as the secret `SITE_PUSH_TOKEN` and used for the
  push and for these API calls:
  * Created by the owner (never shown to anyone else): GitHub → Settings → Developer settings → Fine-grained tokens;
    resource owner = the account that owns the `k1kfx.com` repository; **only that repository**; permissions
    **Contents: Read and write** and **Pages: Read and write** (Metadata read is added automatically); nothing else.
  * It has an expiry (choose up to one year and set a reminder). When it expires, the run fails at its first step or at the
    push, visibly, and the issue is opened; creating a new token and updating the secret fixes it.
  * The built-in `GITHUB_TOKEN` is reduced to `contents: read` and `issues: write`.
* **Proof of publication:** the workflow only succeeds when the **public** site (`https://k1kfx.com/satellites/data/status.json`)
  shows the expected new download time. The check adds a cache-busting query so a cached copy cannot fool it (Pages serves
  `max-age=600`), and allows 15 minutes for the build and deployment.
* **Not proposed:** switching the site to publish from a GitHub Actions workflow, which would change the existing hosting
  setup; a separate Cloudflare project; any DNS change.
* **Still requires one approved end-to-end test:** no run of the real workflow has happened. The request/poll steps, the
  token's permissions on the real repository, and the behavior of a Pages build requested this way can only be confirmed by
  one manual "Run workflow" after approval. The exact commands are reviewed but could not be executed here.

## Which planner version is published (important)

Scheduled workflows always run from the **default branch of the repository that holds them**. They cannot follow a
feature branch, and they must not silently build a stale or unapproved branch. So:

* The workflow lives in the **website** repo's `main`, the branch GitHub uses for any schedule added later (a schedule always
  runs the default branch's copy of the file).
* It does **not** build "whatever the planner's default branch is". The planner's `main` still holds only the initial
  commit, and the approved code is on `feature/calendar-export-ui`, unmerged. The workflow instead checks out **one
  pinned commit**, `PLANNER_SHA` at the top of the file, currently `de3911e978c142624d154b52b60af4cce5c862c1`, the commit
  containing everything described here (it must be pushed to the planner repository first so the pin exists remotely).
* Nothing is merged for this. To publish a newer planner version later, change `PLANNER_SHA` in a reviewed one-line commit
  to the website repo. A planner change is always a deliberate act, never a side effect of a run, manual or scheduled. (Merging
  the planner pull requests is a separate decision; after it, the pin could instead track `main`.)

## Required settings, secrets and cost

* **Secret: `SITE_PUSH_TOKEN`** (website repo → Settings → Secrets and variables → Actions), a fine-grained token with
  Contents and Pages read/write on that one repository (above). Nothing else. No credentials appear in browser code.
* **Where the token goes.** It can publish to the website, so it is kept away from everything that runs project or
  third-party code. It is **not** given to either checkout (both use `persist-credentials: false`, so nothing is written to
  a Git configuration), and it is **not** in the environment while dependencies are installed or tests and builds run: the
  website is not even checked out until after the build. It is supplied, as that step's own environment variable, to three
  steps only: the 2-minute preflight (`gh api` reads the Pages settings), the push, and the Pages build request. The push
  hands it to Git for each command with `git -c http.https://github.com/.extraheader=...`, which is not stored in
  `.git/config`, and the encoded form is registered as a masked value; no step echoes it or turns on command tracing. A
  secret is also masked by GitHub in logs, but masking is a backstop, not the protection. (The token's arguments are visible
  to other processes on the single-use runner while Git runs; nothing else runs then.) Tests check each of these properties
  in the workflow file.
* **Issues must be enabled** on the website repository for the failure issue to open. They are: a public check of
  `jeremydalesmith-websites/k1kfx.com` reports `has_issues: true`. If Issues were ever turned off (Settings → General →
  Features → Issues), the report step would fail and the run's failed status would be the only signal.
* **No overlapping runs:** a `concurrency` group queues a second run instead of racing the first (never cancelling one in
  progress). **No loops:** the workflow has no `push` trigger; do not add a workflow to the website repo that triggers on
  pushes to `satellites/` without excluding this one. **No overwrite:** pushes are never forced.
* **Workflow permissions** (job level; the default is none): `contents: read`, `issues: write`. If the repository or its
  owner sets default workflow permissions to read-only, that is fine; the job asks for what it needs explicitly.
* **Branch protection:** `main` is unprotected today. If rules are added later that require pull requests, the push will
  fail visibly and need an exception.
* **Cost:** free for a public repository (standard runners); a run takes about 2 to 4 minutes (the 17 status requests are
  spaced one second apart, on purpose). AMSAT is asked for 18 requests a day, far below its polling guidance.
* **Third-party actions:** `actions/checkout@v4` and `actions/setup-node@v4` (GitHub's own), by version tag. Pinning them
  to commit SHAs is a possible hardening.

## Time limits and failure reporting

* The refresh command stops itself after **6 minutes** (`--deadline-min 6`): running requests are aborted, no new one is
  started, and it exits with an ordinary failure, writing nothing. Without it the worst case would be 18 requests x 3 tries x
  30 seconds, longer than any job limit. A test runs the real script against requests that never answer.
* Its step has a hard limit of **8 minutes**; every other step has its own limit as well, and the **job limit (75 minutes)
  is above their sum (69)**. So a stalled step fails as a step, and the later "report failure" step (`if: failure()`) still
  gets to run.
* **That is best effort, not a guarantee.** If GitHub cancels the run, the runner is lost, or the job itself reaches its
  limit, no later step can run: no issue is opened. The failed run in the Actions tab and GitHub's own failure e-mail to the
  account that last edited the workflow are then the only signals. The workflow file says so.

## Failure behaviour, tested

`tests/refresh-failure-paths.test.ts` runs the **real** `refresh-data.ts` and `validate-data.ts` as child processes against
a stubbed network, in the workflow's order (refresh strict, validate, publish), each step running only if the previous one
exited 0, as GitHub Actions stops a job at its first failed step. A folder stands in for the published
`satellites/data/` files. For each of these failures the published `elements.json` and `status.json` are **byte-for-byte
unchanged**, and the scratch copies too when the refresh itself fails: a status request failing with HTTP 503, a status
response with no `data` list, a status response whose rows cannot be read, the orbital download failing, a stalled
download (hitting the deadline), and validation refusing the data (a report dated in the future). Further tests show a
successful run replaces both files with times from that run, that the non-strict local run never advances the status time
after a failed status download, and that "no reports" (one repeater, or all) is published and leaves those repeaters
ineligible.

`tests/deploy-workflow.test.ts` checks the workflow file's triggers, concurrency, permissions, token placement, time limits,
publication order and pin, and **executes the build guard** (the step that refuses to publish a build that mentions the
fox-hunting app, has the wrong base path, or lacks a file) in bash against scratch builds, including a case showing that the
earlier negated `! grep` form let a mention through. The whole file was also parsed with a real YAML parser before installation (GitHub rejected the first installed copy for an
unquoted step name containing `: `, which the earlier text-only tests could not see); a test now checks for that mistake. The rest of the workflow cannot be run locally (it needs GitHub's
runners and the real repositories), so its other YAML and shell steps are reviewed and structurally tested, not executed.

## Limitations (stated plainly)

* **Without the schedule the data does not refresh by itself.** The planner shows the data's real age ("Keplers updated N
  hours ago · Activity reports updated N hours ago"), and the activity-report notices appear once it is over 24 hours old; the
  72-hour rule means nothing stays eligible without fresh reports.
* **With the schedule:** GitHub may start a scheduled run several minutes late, or occasionally skip one under load. A late run can make the
  activity reports show their "over 24 hours old" notice for a short time before the next update lands. The cadence
  asked for is 24 hours; every 12 hours would remove that edge case at the cost of 18 more AMSAT requests a day.
* GitHub disables scheduled workflows after 60 days without repository activity. The daily commit is itself activity, so
  it should keep itself alive, but this has not been observed; no issue appears if GitHub simply stops scheduling. Run
  workflow re-enables it.
* A run only proves the data is fresh and valid. It cannot tell whether an amateur-radio repeater is actually working;
  that still comes only from volunteer reports (the 72-hour rule is unchanged).
* Each run (and, later, each daily run) adds about 25 KB of data to the website repo's history; a code change adds a new build.

## Caching, and what an open tab does

* Pages serves files with `Cache-Control: max-age=600`: a browser or CDN may reuse a copy for up to 10 minutes.
* The planner fetches `data/elements.json` and `data/status.json` with `cache: 'no-cache'`, which forces the browser to
  revalidate them on every page load, so a **new or reloaded page** gets the current data as soon as Pages has published
  it. The page itself (`index.html`) may be up to 10 minutes old from a cache.
* **A tab left open across an update does not refresh itself.** The data is read once, when the page loads. There is no
  polling, timer or service worker. The freshness line is computed from the loaded data's own download times each time a
  search runs, so a search in an old tab honestly reports older data instead of pretending to be newer.
* **Data-only updates are harmless to an open tab:** script file names are content-hashed and the code is the same, so the
  tab keeps working with the data it already has.

### The open-tab failure, explained, and how it is now handled

The calculation runs in a separate script (`assets/predict.worker-<hash>.js`) that the page requests **when you press
Search**, not when it opens. When the planner **code** is bumped (`PLANNER_SHA` changes), the update replaces
`satellites/` and removes the old hashed files. A tab that was opened before that update still holds the old page, so
its next search asked for a script file that no longer exists. Before, that ended in a generic "The calculation
failed" message. A cached copy of the page (up to 10 minutes old) opened just after an update could even point at a
removed app script and show a blank page. Now:

1. Every build writes `version.json` (`{"build": "<code commit>"}`) beside the app and compiles the same id into the
   page. When a search starts, the page makes **one** small, uncached request for `version.json`; if the published build
   differs it stops and says: *"A newer version of the planner has been published since this page was opened. Reload the
   page to use it. Nothing was calculated."* This is a single request on a user action, not polling. If the file is
   missing, the network is down, or the page is a development build, the check says nothing and the search proceeds.
2. If the calculation script still cannot be loaded, the error reads: *"The calculation script could not be loaded. The
   planner was probably updated after this page was opened. Reload the page and try again."*
3. If the app script itself is missing (a stale cached page), a small built-in fallback replaces the blank page with
   *"The planner could not be loaded. It was probably just updated: reload the page (Ctrl+F5 if it still fails)."*
4. If newly published data has a format an old page does not understand, the data-problem message adds "if the planner
   was just updated, reload the page".

All four were exercised in a real browser (a doctored `version.json`, a blocked worker script, a blocked app script) and by
automated tests. Data-only updates keep the same build id, so they do not trigger the "newer version" message.

## Rollback

Revert the bot commit in the website repo (GitHub Desktop or the web UI) and Pages republishes the previous folder. To
stop the automation, disable the workflow in the Actions tab or delete the file, and delete the token; nothing else
depends on it.
