// media.mjs - range-request streaming of local media for dashboard previews.
// SECURITY: only paths inside the ACTIVE client's data/ are served; everything
// else is 403. The data/ root is resolved per request from activeRoot() so a
// request scoped to client A can never read client B's media; an absolute path
// or any ".." segment is rejected outright (the per-client traversal guard).
import fs from 'node:fs';
import path from 'node:path';
import { sendJson, errorBody } from './util.mjs';
import { activeRoot } from './context.mjs';

const MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.srt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function serveMedia(req, res, url) {
  const p = url.searchParams.get('p');
  if (!p) return sendJson(res, 400, errorBody('invalid_input', 'missing p parameter'));
  // Per-client traversal guard: reject an absolute path or any ".." segment
  // BEFORE resolving, so a request can never climb out of the active client's
  // subtree (or reach another client's) regardless of where activeRoot() points.
  if (path.isAbsolute(p) || p.split(/[/\\]/).includes('..')) {
    return sendJson(res, 403, errorBody('invalid_input', 'path outside data/'));
  }
  const root = activeRoot();
  const allowedRoot = path.join(root, 'data') + path.sep;
  const abs = path.resolve(root, p);
  if (!abs.startsWith(allowedRoot)) return sendJson(res, 403, errorBody('invalid_input', 'path outside data/'));
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return sendJson(res, 404, errorBody('media_missing', `file not found: ${p}`));
  }
  if (!stat.isFile()) return sendJson(res, 404, errorBody('media_missing', `not a file: ${p}`));

  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
    return undefined;
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  });
  fs.createReadStream(abs).pipe(res);
  return undefined;
}
