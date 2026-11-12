// Serve ./dist under an arbitrary sub-path, to prove the build works from a sub-directory.
//   node scripts/serve-subdir.mjs /some/sub/dir/ 4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = (process.argv[2] ?? '/satellites/').replace(/\/?$/, '/');
const port = Number(process.argv[3] ?? 4173);
const root = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Other site content (not found here)</h1>');
    return;
  }
  let rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length))).replace(/^(\.\.[/\\])+/, '');
  if (rel === '.' || rel === '' || rel.endsWith('/')) rel = join(rel === '.' ? '' : rel, 'index.html');
  try {
    const p = join(root, rel);
    if (!(await stat(p)).isFile()) throw new Error('nf');
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }).end(await readFile(p));
  } catch {
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
  }
}).listen(port, () => console.log(`serving dist at http://localhost:${port}${prefix}`));
