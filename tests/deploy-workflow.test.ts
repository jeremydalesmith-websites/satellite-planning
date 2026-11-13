import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the PROPOSED update workflow (deploy/update-satellites.yml, not enabled). The workflow cannot be run locally, so
 * these tests pin down the properties that must not drift: what triggers it, what it may touch, how it publishes, and that the
 * planner commit it pins contains every approved app change.
 */
const yml = readFileSync('deploy/update-satellites.yml', 'utf8').replace(/\r\n/g, '\n');
const steps = yml.slice(yml.indexOf('\n    steps:'));
const code = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // ignore comments
const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });

describe('triggers and concurrency', () => {
  it('runs on a daily schedule and on manual dispatch only (no push or pull_request trigger, so it cannot loop)', () => {
    expect(code).toMatch(/schedule:\n\s+- cron: '[^']+'/);
    expect(code).toContain('workflow_dispatch');
    expect(code).not.toMatch(/\n\s+(push|pull_request|pull_request_target|workflow_run|repository_dispatch):/);
    expect(code).toMatch(/cron: '\d+ \d+ \* \* \*'/); // once a day
  });
  it('never overlaps itself and never cancels a run in progress', () => {
    expect(code).toMatch(/concurrency:\n\s+group: update-satellites\n\s+cancel-in-progress: false/);
  });
});

describe('credentials and permissions', () => {
  it('has no default permissions; the job gets read access to contents and issue writing only', () => {
    expect(code).toMatch(/\npermissions: \{\}/);
    expect(code).toMatch(/permissions:\n\s+contents: read[^\n]*\n\s+issues: write/);
    expect(code).not.toMatch(/contents: write|pages: write|id-token|actions: write/);
  });
  it('the push and the Pages calls use the scoped secret, never the built-in token', () => {
    expect(code).toContain('secrets.SITE_PUSH_TOKEN');
    expect(code).toMatch(/token: \$\{\{ secrets\.SITE_PUSH_TOKEN \}\}/);
    const issueStep = steps.slice(steps.indexOf('Tell the owner if anything failed'));
    expect(issueStep).toContain('github.token'); // only the failure issue uses the built-in token
    expect(steps.slice(0, steps.indexOf('Tell the owner if anything failed'))).not.toMatch(/github\.token|GITHUB_TOKEN/);
  });
  it('the planner checkout gets no push credential', () => {
    expect(code).toMatch(/path: planner\n\s+persist-credentials: false/);
  });
});

describe('publication', () => {
  it('requests a Pages build explicitly after the push, and does not rely on the push to publish', () => {
    expect(code).toContain('-X POST "repos/$repo/pages/builds"');
    expect(code.indexOf('git push origin')).toBeLessThan(code.indexOf('/pages/builds'));
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
  it('touches only satellites/: a guard refuses any other path, pushes are never forced, and the push is last before verification', () => {
    expect(code).toContain("grep -v '^satellites/'");
    expect(code).toContain('git add -A -- satellites');
    expect(code).not.toMatch(/git push[^\n]*(--force| -f\b|\+HEAD)/);
    expect(code).toContain('git pull --rebase origin main');
  });
  it('strict refresh and validation run before anything is copied or pushed', () => {
    const at = (s: string) => code.indexOf(s);
    expect(at('npm run refresh-data:strict')).toBeGreaterThan(0);
    expect(at('npm run refresh-data:strict')).toBeLessThan(at('npm run validate-data'));
    expect(at('npm run validate-data')).toBeLessThan(at('npm run build:satellites'));
    expect(at('npm run build:satellites')).toBeLessThan(at('rsync'));
    expect(at('rsync')).toBeLessThan(at('git push origin'));
    expect(code).not.toMatch(/continue-on-error/);
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
  it.skipIf(!known)('has the same app source, scripts, data tooling and lockfile as HEAD (if this fails, move the pin to the newer commit)', () => {
    const diff = git('diff', '--name-only', sha, 'HEAD', '--', ...appPaths);
    expect(diff.stdout.trim()).toBe('');
  });
  it.skipIf(!known)('already contains each behavior the automation needs', () => {
    for (const [file, text] of [
      ['src/cluster/cluster.ts', 'rankResults'],
      ['src/data/refresh.ts', 'statusAttemptFromBody'],
      ['src/data/validate.ts', 'validateDataFiles'],
      ['src/data/version.ts', 'newerVersionPublished'],
      ['scripts/validate-data.ts', 'validateDataFiles'],
      ['package.json', 'refresh-data:strict'],
    ] as const) {
      expect(git('show', `${sha}:${file}`).stdout, `${file} at the pinned commit`).toContain(text);
    }
  });
});
