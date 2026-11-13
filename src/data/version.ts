/**
 * Detects a page that is older than the published planner. A page opened before an update keeps its old code and data in
 * memory; the one thing it fetches later is the calculation script, whose file name changes with the code. So when a search
 * starts we make ONE small request for version.json and compare. Nothing polls, and a failed or missing check never blocks a
 * search (the worker-start failure handling in orbit/client.ts is the second line of defence).
 */
import { dataUrl } from './load.ts';

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

export const RELOAD_MESSAGE = 'A newer version of the planner has been published since this page was opened. Reload the page to use it. Nothing was calculated.';
export const WORKER_FAILED_MESSAGE = 'The calculation script could not be loaded. The planner was probably updated after this page was opened. Reload the page and try again.';

/** True only when the published build is KNOWN to differ from this page's build. Unknown (offline, no file, dev) is false. */
export async function newerVersionPublished(build: string = BUILD_ID, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (build === 'dev' || build === 'unknown') return false;
  try {
    const res = await fetchImpl(dataUrl('version.json'), { cache: 'no-cache' });
    if (!res.ok) return false;
    const body = (await res.json()) as { build?: unknown };
    return typeof body.build === 'string' && body.build !== '' && body.build !== build;
  } catch {
    return false;
  }
}
