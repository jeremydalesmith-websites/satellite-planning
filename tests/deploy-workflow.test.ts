import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Guards on the PROPOSED update workflow (deploy/update-satellites.yml, not enabled). The workflow cannot be run locally, so
 * these tests pin down the properties that must not drift: what triggers it, what it may touch, where the token goes, how it
 * publishes, its time limits, and that the planner commit it pins contains every approved app change. The one shell guard that
 * decides "do not publish" is also executed for real, below.
 */
const yml = readFileSync('deploy/update-satellites.yml', 'utf8').replace(/\r\n/g, '\n');
const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // ignore full-line comments
const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

interface Step { name: string; text: string }
const stepsOf = (): Step[] => {
  const body = code.slice(code.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
  return body.split(/\n(?=      - )/).map((text) => ({ name: /(?:name: |uses: )([^\n]+)/.exec(text)?.[1]?.trim() ?? text.slice(0, 40), text }));
};
const steps = stepsOf();
const step = (fragment: string) => {
  const s = steps.find((x) => x.name.includes(fragment));
  if (!s) throw new Error(`no step containing "${fragment}"`);
  return s;
};
const indexOfStep = (fragment: string) => steps.indexOf(step(fragment));

describe('triggers and concurrency', () => {
  const on = /\non:\n((?:  [^\n]*\n|\n)+)/.exec(code + '\n')?.[1] ?? '';
  it('has the manual trigger and exactly one daily schedule, and nothing else can start it (so it cannot loop)', () => {
    expect(on).toMatch(/^  workflow_dispatch:/m);
    expect(on.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().split(':')[0])).toEqual(['schedule', 'workflow_dispatch']);
    expect(code).not.toMatch(/\n\s+(push|pull_request|pull_request_target|workflow_run|repository_dispatch|workflow_call):/);
    expect(code.match(/\bcron:/g)).toHaveLength(1); // one schedule entry, not several
  });
  it('runs once a day at 09:17 UTC: fixed minute and hour, every day, an off-the-hour minute', () => {
    const cron = /cron: '([^']+)'/.exec(code)?.[1] ?? '';
    expect(cron).toBe('17 9 * * *');
    const [minute, hour, dom, month, dow] = cron.split(' ');
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/); // a single hour: not "*" or a list, so once per day
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    expect(Number(minute)).not.toBe(0);
  });
  it('the README states the same time, with the local-time conversion and the daylight-saving shift', () => {
    const readme = readFileSync('deploy/README.md', 'utf8');
    expect(readme).toContain("cron: '17 9 * * *'");
    expect(readme).toMatch(/09:17 UTC/);
    expect(readme).toMatch(/3:17 AM/);
    expect(readme).toMatch(/4:17 AM/);
    expect(yml).toContain('(03:17 US Central standard time, 04:17 daylight time)');
  });
  it('never overlaps itself and never cancels a run in progress', () => {
    expect(code).toMatch(/concurrency:\n\s+group: update-satellites\n\s+cancel-in-progress: false/);
  });
});

describe('the publication token is kept away from project and third-party code', () => {
  const withToken = steps.filter((s) => s.text.includes('secrets.SITE_PUSH_TOKEN'));
  it('is given only to the preflight check, the push and the Pages build request, each as that step\'s own env', () => {
    expect(withToken.map((s) => s.name)).toEqual([
      expect.stringContaining('Check the token'),
      expect.stringContaining('Commit and push'),
      expect.stringContaining('Ask GitHub Pages to build'),
    ]);
    for (const s of withToken) expect(s.text).toMatch(/\n\s+env:\n(\s+\w+: [^\n]+\n)*?\s+\w+: \$\{\{ secrets\.SITE_PUSH_TOKEN \}\}/);
  });
  it('no checkout receives it and every checkout declines to persist credentials', () => {
    const checkouts = steps.filter((s) => s.text.includes('actions/checkout'));
    expect(checkouts).toHaveLength(2);
    for (const c of checkouts) {
      expect(c.text).toContain('persist-credentials: false');
      expect(c.text).not.toMatch(/\n\s+token:/);
    }
  });
  it('the token is never in play while dependencies are installed or while tests and builds run', () => {
    const publish = indexOfStep('Check out the website');
    for (const name of ['Install the planner', 'Download fresh data', 'Validate the data', 'Test and build', 'Check the build']) {
      expect(indexOfStep(name)).toBeLessThan(publish); // all project code runs BEFORE the website is even checked out
    }
    // ...and none of those steps (nor setup-node) mentions the token; the only earlier step that does is the 2-minute preflight
    for (const s of steps.slice(0, publish)) if (!s.name.includes('Check the token')) expect(s.text).not.toContain('SITE_PUSH_TOKEN');
  });
  it('is handed to Git per command, never written into Git configuration, and its encoded form is masked', () => {
    const push = step('Commit and push').text;
    expect(push).toContain('::add-mask::$basic');
    expect(push).toContain('git -c "http.https://github.com/.extraheader=');
    expect(code).not.toMatch(/git config[^\n]*(extraheader|credential|url\.)/);
    expect(code).not.toMatch(/remote (set-url|add)/);
    expect(code).not.toMatch(/set -x|bash -x|ACTIONS_STEP_DEBUG/); // nothing prints commands (and so arguments)
    expect(code).not.toMatch(/echo (?!"::add-mask::)[^\n]*\$\{?(SITE_PUSH_TOKEN|basic|GH_TOKEN)/); // the token is never echoed (the mask command itself is the one exception)
  });
  it('the built-in token is read-only for contents and is the only one used for the failure issue', () => {
    expect(code).toMatch(/\npermissions: \{\}/);
    expect(code).toMatch(/permissions:\n\s+contents: read[^\n]*\n\s+issues: write/);
    expect(code).not.toMatch(/contents: write|pages: write|id-token|actions: write/);
    expect(step('Tell the owner').text).toContain('github.token');
    for (const s of steps) if (!s.name.includes('Tell the owner')) expect(s.text).not.toMatch(/github\.token|GITHUB_TOKEN/);
  });
});

describe('publication', () => {
  it('requests a Pages build explicitly after the push, and does not rely on the push to publish', () => {
    expect(code).toContain('-X POST "repos/$repo/pages/builds"');
    expect(code.indexOf('gitauth push origin')).toBeLessThan(code.indexOf('/pages/builds'));
  });
  it('checks first that the site is still published from the main branch', () => {
    expect(code).toContain('.build_type == "legacy" and .source.branch == "main"');
    expect(code.indexOf('.build_type == "legacy"')).toBeLessThan(code.indexOf('Check out the website'));
  });
  it('only succeeds when the PUBLIC site serves the new download time, with a cache-busting request', () => {
    expect(code).toContain('${SITE_URL}data/status.json');
    expect(code).toMatch(/\?cb=\$\(date \+%s\)/);
    expect(code).toContain('downloadedAt');
    expect(code).toMatch(/SITE_URL: https:\/\/k1kfx\.com\/satellites\//);
  });
  it('touches only satellites/: a guard refuses any other path, and pushes are never forced', () => {
    expect(code).toContain("grep -v '^satellites/'");
    expect(code).toContain('git add -A -- satellites');
    expect(code).not.toMatch(/(git|gitauth) push[^\n]*(--force| -f\b|\+HEAD)/);
    expect(code).toContain('gitauth pull --rebase origin main');
  });
  it('strict refresh and validation run before anything is copied or pushed', () => {
    const at = (s: string) => code.indexOf(s);
    expect(at('npm run refresh-data:strict')).toBeGreaterThan(0);
    expect(at('npm run refresh-data:strict')).toBeLessThan(at('npm run validate-data'));
    expect(at('npm run validate-data')).toBeLessThan(at('npm run build:satellites'));
    expect(at('npm run build:satellites')).toBeLessThan(at('rsync'));
    expect(at('rsync')).toBeLessThan(at('gitauth push origin'));
    expect(code).not.toMatch(/continue-on-error/);
  });
});

describe('time limits', () => {
  const minutes = (s: Step) => Number(/timeout-minutes: (\d+)/.exec(s.text)?.[1] ?? NaN);
  const job = Number(/\n    timeout-minutes: (\d+)/.exec(code)?.[1]);
  it('every step has its own limit, and the job limit is above their sum so a stalled step fails as a step', () => {
    for (const s of steps) expect(minutes(s), `${s.name} has no timeout-minutes`).toBeGreaterThan(0);
    expect(steps.reduce((sum, s) => sum + minutes(s), 0)).toBeLessThan(job);
  });
  it('the download phase limit is far below the job limit and above the command\'s own deadline', () => {
    const download = minutes(step('Download fresh data'));
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const deadline = Number(/--deadline-min (\d+)/.exec(pkg.scripts['refresh-data:strict'] ?? '')?.[1]);
    expect(deadline).toBeGreaterThan(0);
    expect(deadline).toBeLessThan(download);
    expect(download).toBeLessThan(job / 4);
  });
  it('the failure-report step runs on failure, and the file does not promise delivery after a cancellation or job timeout', () => {
    expect(step('Tell the owner').text).toContain('if: failure()');
    expect(yml).toMatch(/best effort, not\n# a guarantee/);
    expect(yml).not.toMatch(/guaranteed|always (reported|notified)/i);
  });
});

describe('the build guard really stops publication', () => {
  // The step is extracted from the workflow and run with bash against a scratch dist/. A negated `! grep` would not stop a
  // `set -e` script (a negated command never trips it), which is the bug this guards against.
  const bashes = ['C:\\Program Files\\Git\\bin\\bash.exe', '/usr/bin/bash', '/bin/bash'].filter((p) => existsSync(p));
  const bash = bashes[0];
  const work = mkdtempSync(join(tmpdir(), 'guard-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const run = (script: string, cwd: string) => {
    const shim = join(work, 'bin');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'node'), '#!/bin/sh\nexit 0\n'); // the final validation step is exercised elsewhere
    return spawnSync(bash!, ['-e', '-c', script], { cwd, encoding: 'utf8', env: { ...process.env, PATH: shim + delimiter + (process.env.PATH ?? '') } });
  };
  const script = (() => {
    const m = /\n\s+run: \|\n((?:\s{10}[^\n]*\n?)+)/.exec(step('Check the build before publishing').text + '\n');
    return m ? m[1]!.split('\n').map((l) => l.slice(10)).join('\n') : '';
  })();
  const dist = (indexHtml: string, files = ['version.json', 'data/elements.json', 'data/status.json']) => {
    const dir = mkdtempSync(join(work, 'case-'));
    mkdirSync(join(dir, 'dist', 'data'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), indexHtml);
    for (const f of files) writeFileSync(join(dir, 'dist', f), '{}');
    return dir;
  };
  const good = '<script src="/satellites/assets/index-abc.js"></script>';

  it.skipIf(!bash)('the extracted step is the guard script, with an explicit conditional and no negated grep', () => {
    expect(script).toContain("if grep -qi 'hunt' dist/index.html; then");
    expect(script).not.toMatch(/^\s*!\s*grep/m);
  });
  it.skipIf(!bash)('passes on a clean build', () => {
    expect(run(script, dist(good)).status).toBe(0);
  });
  it.skipIf(!bash)('FAILS (nonzero, with a message) when the build mentions the fox-hunting app, in any case', () => {
    for (const html of [`${good}<a href="/hunt/">x</a>`, `${good} Hunt`]) {
      const r = run(script, dist(html));
      expect(r.status, html).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/mentions 'hunt'/);
    }
  });
  it.skipIf(!bash)('FAILS when the base path is wrong or a required file is missing', () => {
    expect(run(script, dist('<script src="./assets/x.js"></script>')).status).not.toBe(0);
    expect(run(script, dist(good, ['data/elements.json', 'data/status.json'])).status).not.toBe(0); // no version.json
  });
  it.skipIf(!bash)('the old negated form would NOT have failed, which is why it was replaced', () => {
    const old = script.replace(/if grep -qi 'hunt' dist\/index\.html; then[\s\S]*?\nfi\n/, "! grep -rqi 'hunt' dist/index.html\n");
    expect(old).toContain("! grep -rqi 'hunt'");
    expect(run(old, dist(`${good} hunt`)).status).toBe(0); // the bug: a mention goes unnoticed
  });
});

describe('the pinned planner commit contains every approved app change', () => {
  const sha = /PLANNER_SHA: ([0-9a-f]{40})/.exec(yml)?.[1] ?? '';
  const known = sha !== '' && git('cat-file', '-e', `${sha}^{commit}`).status === 0; // a shallow clone may not have it
  const appPaths = ['src', 'scripts', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

  it('is a full 40-character commit id, not a branch', () => {
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(code).toMatch(/repository: \$\{\{ env\.PLANNER_REPO \}\}\n\s+ref: \$\{\{ env\.PLANNER_SHA \}\}/); // the planner is checked out at the pin
  });
  it.skipIf(!known)('is an ancestor of HEAD', () => {
    expect(git('merge-base', '--is-ancestor', sha, 'HEAD').status).toBe(0);
  });
  // Work that is committed but deliberately NOT deployed yet (awaiting approval) is listed here, so the pin guard stays strict for
  // everything else. Each entry says why it cannot change what visitors get. Remove an entry when its feature is approved and the
  // pin is moved past it.
  const UNDEPLOYED_ADDITIONS = [
    'src/export/ics.ts', // calendar builder: not imported by any app code, so it is not in the published build
    'src/domain/policy.ts', // calendar constants only: checked below to be additions with no removed or changed line
  ];
  it.skipIf(!known)('has the same app source, scripts, data tooling and lockfile as HEAD (if this fails, move the pin to the newer commit)', () => {
    const changed = git('diff', '--name-only', sha, 'HEAD', '--', ...appPaths).stdout.trim().split('\n').filter(Boolean);
    expect(changed.filter((f) => !UNDEPLOYED_ADDITIONS.includes(f))).toEqual([]);
  });
  it.skipIf(!known)('the listed undeployed changes are only additions (nothing existing was altered), and nothing app-side imports the calendar builder', () => {
    for (const f of UNDEPLOYED_ADDITIONS) {
      const stat = git('diff', '--numstat', sha, 'HEAD', '--', f).stdout.trim();
      if (stat === '') continue; // unchanged since the pin
      const [added, removed] = stat.split(/\s+/);
      expect(Number(added), `${f} added lines`).toBeGreaterThanOrEqual(0);
      expect(removed, `${f} must have no removed lines`).toBe('0');
    }
    const importers = git('grep', '-l', "export/ics", 'HEAD', '--', 'src').stdout.trim();
    expect(importers).toBe('');
  });
  it.skipIf(!known)('already contains each behavior the automation needs', () => {
    for (const [file, text] of [
      ['src/cluster/cluster.ts', 'rankResults'],
      ['src/data/refresh.ts', 'statusAttemptFromBody'],
      ['src/data/validate.ts', 'validateDataFiles'],
      ['src/data/version.ts', 'newerVersionPublished'],
      ['scripts/validate-data.ts', 'validateDataFiles'],
      ['package.json', 'refresh-data:strict'],
      ['package.json', '--deadline-min'],
    ] as const) {
      expect(git('show', `${sha}:${file}`).stdout, `${file} at the pinned commit`).toContain(text);
    }
  });
});

describe('YAML validity (GitHub rejected the first installed copy with "error in your yaml syntax on line 103")', () => {
  // The repository has no YAML parser, so the one common way a hand-written workflow breaks is checked directly: an UNQUOTED value
  // that contains ": " (a colon and a space) is read as a nested mapping and is a syntax error. The whole file was also parsed
  // with a real YAML parser (yaml 2.x, installed in a scratch folder, not a repository dependency) before it was installed.
  const offending = (text: string) =>
    text.split('\n').filter((l) => {
      const m = /^\s*(?:- )?(name|if|uses|working-directory|timeout-minutes|runs-on|cron|group): (.*)$/.exec(l);
      if (!m) return false;
      const value = m[2]!.replace(/\s+#.*$/, ''); // a trailing comment is not part of the value
      return !/^['"|>]/.test(value) && value.includes(': ');
    });
  it('no unquoted name/if/uses value contains a colon followed by a space', () => {
    expect(offending(yml)).toEqual([]);
  });
  it('the check catches the exact line that GitHub rejected', () => {
    expect(offending('      - name: Download fresh data (strict: any failure stops the run and writes nothing)')).toHaveLength(1);
    expect(offending("      - name: 'Download fresh data (strict mode: any failure stops the run)'")).toEqual([]);
  });
  it('every step name is present once the quoting is accounted for', () => {
    expect(steps.some((s) => s.name.includes('Download fresh data'))).toBe(true);
    expect(steps).toHaveLength(13);
  });
});
