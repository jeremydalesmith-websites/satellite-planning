# Proposed: automatic daily data update for k1kfx.com/satellites/

**Status: a draft for the owner's review. Nothing here is enabled.** `update-satellites.yml` sits in `deploy/`, not in
`.github/workflows/`, so it cannot run from this repository. It would be copied to the website repository only after the
owner approves that specific change.

## The arrangement it keeps

The planner is live at `https://k1kfx.com/satellites/` because its built output is copied into the `satellites/` folder
of the website repository (`k1kfx.com`, branch `main`), which GitHub Pages serves ("deploy from a branch"). The workflow
keeps that arrangement: no Cloudflare project, no DNS change, no new hosting, no backend, no public "Update now" button,
and no polling in the browser. It automates the copy that is now done by hand with GitHub Desktop.

## What one run does

Every 24 hours (09:17 UTC) and whenever the owner presses **Run workflow** in the website repo's Actions tab:

1. Checks out the website (`main`) and the **approved planner version** (see below).
2. `npm ci`, then `npm run refresh-data:strict`: downloads fresh Keplers (AMSAT `nasabare.txt`, one request) and
   activity reports (17 spaced requests) with the planner's existing refresh code. Strict means **all or nothing**: if
   anything fails, nothing is written and the run stops.
3. `npm run validate-data`: both files well formed; downloaded within the last 3 hours; every catalog satellite has
   orbital data; every repeater has a status entry with no recorded failure; the reports are not empty or future-dated.
4. `npm test` (no network), then `npm run build:satellites` (type-check, then a build with base `/satellites/`), then
   checks of the built output, including a second validation of the exact files that will be published.
5. Replaces **only** `satellites/` in the website checkout (`rsync --delete` from `dist/`), then refuses to continue if
   Git sees any changed path outside `satellites/` (so `hunt/`, `CNAME`, `index.html` and every other page are safe).
6. Commits as `github-actions[bot]` and pushes to `main` (rebasing over any unrelated website commit made meanwhile).
7. Polls the live site until `…/satellites/data/status.json` shows the new download time (up to 12 minutes; after 3
   minutes it asks GitHub Pages to build, if it has not started by itself).
8. On any failure, opens (or comments on) one issue titled "Satellite data update failed" with a link to the run.

Because the push is the **last** step and every check precedes it, a failed download, validation, test or build leaves
the current publication exactly as it was. (If only step 7 fails, the new data was pushed but not seen live; the issue
says so.) A run does not start itself again: there is no `push` trigger, and pushes made with the built-in token never
start workflow runs.

## Which planner version is published (important)

Scheduled workflows always run from the **default branch of the repository that holds them**. They cannot follow a
feature branch, and they must not silently build a stale or unapproved branch. So:

* The workflow lives in the **website** repo's `main`, which is what a schedule runs.
* It does **not** build "whatever the planner's default branch is". The planner's `main` still holds only the initial
  commit, and the approved code (Sort by, single passes, strict eligibility) is on `feature/strict-eligibility`,
  unmerged. The workflow instead checks out **one pinned commit**, `PLANNER_SHA` at the top of the file. Today that is
  `ea102b8c73c49f4c66e6226e49bab182c2b6b661`, the commit containing the Sort by work and the refresh/validation tooling.
* Nothing is merged for this. The pinned commit only has to exist in the (public) planner repository, which it will
  once the branch is pushed.
* To publish a newer planner version later, change `PLANNER_SHA` in a reviewed one-line commit to the website repo, or
  press Run workflow after doing so. A planner change is therefore always a deliberate act, never a side effect of the
  daily schedule. (Merging PR #1 and PR #2 is a separate decision; after it, the pin could instead track `main`.)

## How a bot push reaches the live site (checked, not assumed)

GitHub Pages is built-in "pages build and deployment" (event `dynamic`), run by GitHub when `main` changes. GitHub's
documentation says events created with `GITHUB_TOKEN` do not start new workflow runs; it is not documented whether that
covers the Pages build, so this must not be assumed. The workflow therefore **verifies** (step 7) that the site serves
the new download time, requests a Pages build through the API if needed (`pages: write`), and fails visibly otherwise.
If that proves unreliable in practice, the alternative is a fine-grained personal access token limited to the website
repo (`Contents: read and write`) stored as a secret and used by the checkout; that is **not** proposed unless needed,
because it adds a credential to manage.

## Required settings, secrets and cost

* **Secrets: none.** The built-in `GITHUB_TOKEN` is used. No credentials appear anywhere in browser code.
* **Permissions** (job level; the default is none): `contents: write` (push to `main`), `issues: write` (failure issue),
  `pages: write` (only to request a Pages build). Check in the website repo: *Settings → Actions → General →
  Workflow permissions* must allow workflows to be granted write access (the job requests it explicitly, but an
  organisation or repo policy of "read-only" would block it).
* **Branch protection:** `main` is unprotected today. If rules are added later that require pull requests, the push in
  step 6 will fail (visibly) and would need an exception or the token alternative above.
* **Cost:** free for a public repository (standard runners); a run takes about 2 to 4 minutes (the 17 status requests are
  spaced by one second each, on purpose). AMSAT is asked for 18 requests a day, far below its polling guidance.
* **Third-party actions:** `actions/checkout@v4` and `actions/setup-node@v4` (GitHub's own), referenced by version tag.
  Pinning them to commit SHAs is a possible hardening.

## Limitations (stated plainly)

* GitHub may start a scheduled run several minutes late, or occasionally skip one under load. A late run can make the
  activity reports show their "over 24 hours old" notice for a short time before the next update lands. The cadence
  asked for is 24 hours; every 12 hours would remove that edge case at the cost of 18 more AMSAT requests a day.
* GitHub disables scheduled workflows after 60 days without repository activity. The daily commit is itself activity, so
  it should keep itself alive, but this has not been observed; a failure issue will not appear if GitHub simply stops
  scheduling. Run workflow re-enables it.
* A run only proves the data is fresh and valid. It cannot tell whether an amateur-radio repeater is actually working;
  that still comes only from volunteer reports (the 72-hour rule is unchanged).
* The daily commits add about 25 KB (data) to the website repo's history each day; code changes add a new build.

## Caching and what visitors see

* Pages serves files with `Cache-Control: max-age=600`: a browser or CDN may reuse a copy for up to 10 minutes.
* The planner fetches `data/elements.json` and `data/status.json` with `cache: 'no-cache'`, which forces the browser to
  revalidate them against the server on every page load, so a **new or refreshed page** gets the current data as soon as
  Pages has published it. The page itself (`index.html`) may be up to 10 minutes old from a cache, but it only names the
  scripts; the data is fetched fresh.
* **A tab left open across an update does not refresh itself.** The data is read once, when the page loads. There is no
  polling, timer or service worker. The freshness line ("Keplers updated … · Activity reports updated …") is computed from the loaded
  data's own download times each time a search runs, so a search in an old tab honestly reports older data (and the
  "over 24 hours old" notice) instead of pretending to be newer. Reloading the page loads the new data.
* Data-only updates keep the same script file names (they are content-hashed), so an open tab keeps working. When the
  planner **code** is bumped (`PLANNER_SHA`), old hashed files are removed from `satellites/`; a tab that was open before
  that update may fail on its next search (the calculation script no longer exists under its old name) until reloaded.

## Rollback

Revert the bot commit in the website repo (GitHub Desktop or the web UI) and Pages republishes the previous folder. To
stop the automation, disable the workflow in the Actions tab or delete the file; nothing else depends on it.
