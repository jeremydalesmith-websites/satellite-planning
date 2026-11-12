// Verifies a production build served under a sub-path (default /satellites/) behaves correctly.
// Manual check (needs Playwright; not part of `npm test`):
//   npm run build:satellites            # or: npm run build   (relative base)
//   node scripts/serve-subdir.mjs /satellites/ 4173 &
//   node scripts/e2e-basepath.mjs http://localhost:4173 /satellites/
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const origin = process.argv[2] ?? 'http://localhost:4173';
const prefix = (process.argv[3] ?? '/satellites/').replace(/\/?$/, '/');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: 'America/New_York', locale: 'en-US' });
const page = await ctx.newPage();
const requests = [];
const bad = [];
const consoleProblems = [];
page.on('request', (r) => requests.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleProblems.push(m.text()); });
page.on('pageerror', (e) => consoleProblems.push(e.message));
const fresh = () => requests.splice(0, requests.length);

async function loadsApp(url, label) {
  await page.goto(url);
  await page.waitForSelector('text=Find available event windows', { timeout: 20000 });
  check(`${label}: app renders`, true);
}

// 1. base URL
await loadsApp(origin + prefix, `GET ${prefix}`);
const first = fresh();
check('assets requested under the prefix', first.some((u) => u.includes(prefix + 'assets/')), first.filter((u) => u.includes('assets/')).map((u) => u.replace(origin, '')).join(' '));
check('data files requested under the prefix', first.some((u) => u.endsWith(prefix + 'data/elements.json')) && first.some((u) => u.endsWith(prefix + 'data/status.json')));

// 2. a real search exercises the Web Worker and result rendering
await page.fill('input[placeholder="e.g. 42.35"]', '42.0');
await page.fill('input[placeholder="e.g. -71.06"]', '-71.5');
for (const d of ['Saturday', 'Sunday']) for (const p of ['midday', 'evening']) await page.check(`input[aria-label="${d} ${p}"]`);
await page.fill('input[aria-describedby="opp-err"]', '2');
await page.click('text=Find event windows');
await page.waitForSelector('#results-title', { timeout: 60000 });
const afterSearch = fresh();
check('search completes (worker script loaded from the prefix)', afterSearch.some((u) => /assets\/predict\.worker-.*\.js/.test(u) && u.includes(prefix)), afterSearch.filter((u) => u.includes('worker')).map((u) => u.replace(origin, '')).join(' '));
check('results are shown', (await page.locator('section.event').count()) > 0, `${await page.locator('section.event').count()} cards`);

// 3. in-app navigation (tabs) and reload
await page.locator('section.event button:has-text("Save this event")').first().click();
await page.click('button.tab:has-text("Saved events")');
await page.waitForSelector('article.saved');
check('navigation to Saved events works', (await page.locator('article.saved').count()) === 1);
await page.click('button.tab:has-text("Plan")');
fresh();
await page.reload();
await page.waitForSelector('text=Find available event windows');
check('reload keeps working and re-fetches data under the prefix', fresh().some((u) => u.endsWith(prefix + 'data/elements.json')));
check('saved preferences survive reload', (await page.inputValue('input[placeholder="e.g. 42.35"]')) === '42.0');
await page.click('button.tab:has-text("Saved events")');
await page.waitForSelector('article.saved');
check('saved event survives reload and is re-checked', (await page.locator('article.saved .summary').first().innerText()).includes('Now:'));
await page.reload();
await page.waitForSelector('text=Saved events');
check('reload while on a non-default tab does not break', true);

// 4. other entry points
await loadsApp(origin + prefix + 'index.html', `GET ${prefix}index.html`);
await loadsApp(origin + prefix.slice(0, -1), `GET ${prefix.slice(0, -1)} (no trailing slash; host redirects)`);
check('no-trailing-slash visit ended on the slashed URL', page.url() === origin + prefix, page.url());

// 5. nothing outside the prefix was ever requested; sibling app untouched
// The one deliberate request without the slash is the test's own navigation to /satellites (the host redirects it).
const outside = requests.filter((u) => !u.startsWith(origin + prefix) && u.split('?')[0] !== origin + prefix.slice(0, -1));
check('no request left the prefix (nothing read from / or /hunt)', outside.length === 0 && first.concat(afterSearch).every((u) => u.startsWith(origin + prefix)), outside.join(' '));
check('no HTTP errors', bad.length === 0, bad.join(' '));
check('no console errors or warnings', consoleProblems.length === 0, consoleProblems.join(' | '));
const other = await ctx.newPage();
await other.goto(origin + '/hunt/');
check('sibling /hunt/ is still served by the other app, unchanged', (await other.locator('#other-app').count()) === 1);

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
