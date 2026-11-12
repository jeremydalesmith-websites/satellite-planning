// Manual browser check (not part of `npm test`; needs Playwright installed globally or locally).
//   npm run build && node scripts/serve-subdir.mjs /satellites/ 4173 &
//   node scripts/e2e-smoke.mjs http://localhost:4173/satellites/ ./shots
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/satellites/';
const shots = process.argv[3] ?? './shots';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: 'America/New_York', locale: 'en-US' });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });

await page.goto(url);
await page.waitForSelector('text=Find available event windows');

// 1. validation with nothing filled in
await page.click('text=Find event windows');
const errs = await page.locator('.error-summary li').allTextContents();
console.log('validation messages:', errs);
await page.screenshot({ path: `${shots}/1-validation.png`, fullPage: true });

// 2. fill the form
await page.fill('input[placeholder="e.g. 42.35"]', '42.0');
await page.fill('input[placeholder="e.g. -71.06"]', '-71.5');
for (const d of ['Saturday', 'Sunday']) for (const p of ['midday', 'evening']) await page.check(`input[aria-label="${d} ${p}"]`);
for (const d of ['Tuesday', 'Thursday']) await page.check(`input[aria-label="${d} evening"]`);
await page.fill('input[aria-describedby="opp-err"]', '2');
await page.click('text=Find event windows');
await page.waitForSelector('#results-title', { timeout: 60000 });
const title = await page.textContent('#results-title');
console.log('results title:', title);
await page.screenshot({ path: `${shots}/2-results-desktop.png`, fullPage: true });
const cards = await page.locator('section.event').count();
console.log('event cards:', cards);

// 3. save first event, view saved tab
if (cards > 0) {
  await page.locator('section.event button:has-text("Save this event")').first().click();
  await page.click('button.tab:has-text("Saved events")');
  await page.waitForSelector('article.saved');
  console.log('saved cards:', await page.locator('article.saved').count());
  console.log('saved summary:', (await page.locator('article.saved .summary').first().textContent())?.replace(/\s+/g, ' '));
  await page.screenshot({ path: `${shots}/3-saved.png`, fullPage: true });
}

// 4. phone viewport
await page.setViewportSize({ width: 390, height: 844 });
await page.click('button.tab:has-text("Plan")');
await page.screenshot({ path: `${shots}/4-phone-form.png`, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('horizontal overflow on phone:', overflow);

console.log('PROBLEMS:', problems.length ? problems : 'none');
await browser.close();
