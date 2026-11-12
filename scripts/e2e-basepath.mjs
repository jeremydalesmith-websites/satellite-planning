// Verifies a production build served under a sub-path (default /satellites/) behaves correctly.
// Manual check (needs Playwright; not part of `npm test`):
//   npm run build:satellites            # or: npm run build   (relative base)
//   node scripts/serve-subdir.mjs /satellites/ 4173 &
//   node scripts/e2e-basepath.mjs http://localhost:4173 /satellites/
//
// Leak detection is done two independent ways: (1) a permanent browser-side log of EVERY request
// (page and worker, never cleared), and (2) the test server's own record of every request outside
// the prefix. A negative control at the end proves both detectors really would catch a leak.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const origin = process.argv[2] ?? 'http://localhost:4173';
const prefix = (process.argv[3] ?? '/satellites/').replace(/\/?$/, '/');
const noSlash = origin + prefix.slice(0, -1); // the one deliberate non-prefixed navigation (host redirects it)
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const rel = (u) => u.replace(origin, '');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: 'America/New_York', locale: 'en-US' });
const page = await ctx.newPage();
const all = []; // permanent log, never cleared
const bad = [];
const consoleProblems = [];
ctx.on('request', (r) => all.push(r.url()));
ctx.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${rel(r.url())}`); });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleProblems.push(m.text()); });
page.on('pageerror', (e) => consoleProblems.push(e.message));
const since = (mark) => all.slice(mark);

async function loadsApp(url, label) {
  await page.goto(url);
  await page.waitForSelector('text=Find available event windows', { timeout: 20000 });
  check(`${label}: app renders`, true);
}

// 1. base URL: every script and stylesheet must come from under the prefix
let m = all.length;
await loadsApp(origin + prefix, `GET ${prefix}`);
const first = since(m);
const assets = first.filter((u) => /\.(js|css)(\?|$)/.test(u));
check('every script/stylesheet is under the prefix', assets.length > 0 && assets.every((u) => u.startsWith(origin + prefix + 'assets/')), assets.map(rel).join(' '));
check('data files requested under the prefix', first.some((u) => u.endsWith(prefix + 'data/elements.json')) && first.some((u) => u.endsWith(prefix + 'data/status.json')));

// 2. a real search exercises the Web Worker and result rendering
m = all.length;
await page.fill('input[placeholder="e.g. 42.35"]', '42.0');
await page.fill('input[placeholder="e.g. -71.06"]', '-71.5');
for (const d of ['Saturday', 'Sunday']) for (const p of ['midday', 'evening']) await page.check(`input[aria-label="${d} ${p}"]`);
await page.fill('input[aria-describedby="opp-err"]', '2');
await page.click('text=Find event windows');
await page.waitForSelector('#results-title', { timeout: 60000 });
const workerReqs = since(m).filter((u) => /predict\.worker-.*\.js/.test(u));
check('Web Worker script was loaded, from under the prefix', workerReqs.length > 0 && workerReqs.every((u) => u.startsWith(origin + prefix)), workerReqs.map(rel).join(' '));
check('results are shown', (await page.locator('section.event').count()) > 0, `${await page.locator('section.event').count()} cards`);

// 3. in-app navigation (tabs) and reload
await page.locator('section.event button:has-text("Save this event")').first().click();
await page.click('button.tab:has-text("Saved events")');
await page.waitForSelector('article.saved');
check('navigation to Saved events works', (await page.locator('article.saved').count()) === 1);
await page.click('button.tab:has-text("Plan")');
m = all.length;
await page.reload();
await page.waitForSelector('text=Find available event windows');
check('reload re-fetches data from under the prefix', since(m).some((u) => u.endsWith(prefix + 'data/elements.json')));
check('saved preferences survive reload', (await page.inputValue('input[placeholder="e.g. 42.35"]')) === '42.0');
await page.click('button.tab:has-text("Saved events")');
await page.waitForSelector('article.saved');
check('saved event survives reload and is re-checked', (await page.locator('article.saved .summary').first().innerText()).includes('Now:'));
await page.reload();
await page.waitForSelector('text=Saved events');
check('reload while on a non-default tab does not break', true);

// 4. other entry points
await loadsApp(origin + prefix + 'index.html', `GET ${prefix}index.html`);
await loadsApp(noSlash, `GET ${prefix.slice(0, -1)} (no trailing slash; host redirects)`);
check('no-trailing-slash visit ended on the slashed URL', page.url() === origin + prefix, page.url());

// 5. nothing outside the prefix was EVER requested (whole permanent log), checked two ways
const leaked = all.filter((u) => !u.startsWith(origin + prefix) && u.split('?')[0] !== noSlash);
check(`browser log: none of ${all.length} requests left the prefix`, leaked.length === 0, leaked.map(rel).join(' '));
const serverSide = await (await fetch(origin + '/__outside-hits')).json();
const unexpected = serverSide.filter((p) => p !== prefix.slice(0, -1));
check('server log: no request outside the prefix reached the host (nothing read from / or /hunt)', unexpected.length === 0, unexpected.join(' '));
check('no HTTP errors', bad.length === 0, bad.join(' '));
check('no console errors or warnings', consoleProblems.length === 0, consoleProblems.join(' | '));

// 6. negative control: prove the two leak detectors above can actually fail
await page.goto(origin + prefix);
await page.evaluate(() => fetch('/hunt/leak-control').catch(() => {}));
const controlBrowser = all.some((u) => u.endsWith('/hunt/leak-control'));
const controlServer = (await (await fetch(origin + '/__outside-hits')).json()).includes('/hunt/leak-control');
check('negative control: a deliberate request to /hunt/ IS caught by both detectors', controlBrowser && controlServer);

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
