// Serve ./dist under an arbitrary sub-path, to prove a build works from a sub-directory
// WITHOUT touching anything else on a domain. Emulates what a static host (GitHub Pages) does:
//   - /satellites  -> 301 -> /satellites/            (trailing-slash redirect)
//   - /satellites/ -> dist/index.html
//   - every other path (e.g. /hunt/) is answered by a stand-in "other app" page so a test can
//     prove this app never reads or overwrites it.
//
//   node scripts/serve-subdir.mjs /satellites/ 4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = (process.argv[2] ?? '/satellites/').replace(/\/?$/, '/');
const port = Number(process.argv[3] ?? 4173);
const root = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };

// Server-side record of every request that was NOT for this app's prefix. A test can read it from
// /__outside-hits (itself not counted) to prove, independently of the browser, that the app
// never reached outside its sub-path.
const outsideHits = [];

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__outside-hits') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outsideHits));
    return;
  }
  if (url.pathname === prefix.slice(0, -1)) {
    res.writeHead(301, { location: prefix + url.search }).end();
    return;
  }
  if (!url.pathname.startsWith(prefix)) {
    outsideHits.push(url.pathname);
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>OTHER APP</title><h1 id="other-app">Other site content at ${url.pathname}</h1>`);
    return;
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { res.writeHead(400).end('bad request'); return; }
  let rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  if (rel === '.' || rel === '' || rel.endsWith('/')) rel = join(rel === '.' ? '' : rel, 'index.html');
  try {
    const p = join(root, rel);
    if (!(await stat(p)).isFile()) throw new Error('nf');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(await readFile(p));
  } catch {
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
  }
}).listen(port, () => console.log(`serving dist at http://localhost:${port}${prefix}`));
