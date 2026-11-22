// Minimal static server for dist/, used by the browser tests.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.avif': 'image/avif', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

export function serve(root, port = 0) {
  const server = createServer(async (req, res) => {
    let p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root)) return res.writeHead(403).end();
    try {
      if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html');
      await stat(p);
    } catch {
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      return createReadStream(path.join(root, '404.html')).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
