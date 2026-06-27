// static.mjs - serves the built dashboard (app/dist) with SPA fallback.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './util.mjs';

// app/dist is a BUILT code asset, so it lives with the install, not the workspace.
const DIST = path.join(REPO_ROOT, 'app', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pendpost</title>
<style>body{font-family:system-ui;background:#0c0f12;color:#d4dde3;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:560px;padding:2rem;line-height:1.6}code{background:#1a2026;padding:2px 6px;border-radius:6px}</style></head>
<body><main><h1>pendpost</h1>
<p>The server is running, but the dashboard has not been built yet.</p>
<p>Build: <code>cd app &amp;&amp; npm run build</code></p>
<p>API: <a href="/api/health" style="color:#80b3cc">/api/health</a> · <a href="/api/plans" style="color:#80b3cc">/api/plans</a></p>
</main></body></html>`;

export function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const abs = path.resolve(DIST, `.${pathname}`);
  const fallback = path.join(DIST, 'index.html');

  const serve = (file) => {
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(body);
  };

  if (abs.startsWith(DIST + path.sep) || abs === fallback) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return serve(abs);
    if (fs.existsSync(fallback)) return serve(fallback); // SPA route fallback
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PLACEHOLDER);
  return undefined;
}
