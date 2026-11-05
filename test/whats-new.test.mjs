#!/usr/bin/env node
// test/whats-new.test.mjs - What's new after an update (docs/specs/whats-new.md).
//
// (a) the release gate: lib/whats-new.json is valid and carries an entry for the
//     running VERSION, so a release bump without notes fails `npm test`, the
//     pre-push engine gate and `npm run check`.
// (b) the seen marker: fresh install shows nothing, an existing install shows the
//     running version once, several skipped versions show newest first, and the
//     marker never moves past what runs.
// (c) the routes: GET /api/whats-new and POST /api/whats-new/seen.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-whatsnew-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

let server = null;
try {
  const { VERSION } = await import('../lib/util.mjs');
  const wn = await import('../lib/whats-new.mjs');
  const doc = JSON.parse(fs.readFileSync(wn.NOTES_PATH, 'utf8'));

  // ===== (a) the release gate ================================================
  const problems = wn.validateNotes(doc);
  ok(problems.length === 0, `lib/whats-new.json is valid${problems.length ? `: ${problems.join('; ')}` : ''}`);
  ok(Boolean(wn.entryFor(VERSION)), `lib/whats-new.json has an entry for the running version ${VERSION} (write it before \`node ops/release.mjs bump\`)`);
  ok(doc.releases[0].version === VERSION, `the newest entry (${doc.releases[0].version}) is the running version ${VERSION}`);

  const base = { version: '9.1.0', date: '2026-11-05', highlights: { en: ['One.'], 'de-CH': ['Eins.'] } };
  ok(wn.validateNotes({ releases: [base] }).length === 0, 'a minimal entry is valid');
  ok(wn.validateNotes({ releases: [{ ...base, highlights: { en: ['A \u2014 b.'], 'de-CH': ['Eins.'] } }] }).some((p) => /em or en dash/.test(p)), 'an em dash is refused');
  ok(wn.validateNotes({ releases: [{ ...base, highlights: { en: ['One.'], 'de-CH': ['Gro\u00dfe Freude.'] } }] }).some((p) => /sharp s/.test(p)), 'the sharp s is refused in de-CH');
  ok(wn.validateNotes({ releases: [{ ...base, highlights: { en: ['One.'] } }] }).some((p) => /de-CH needs/.test(p)), 'a missing de-CH translation is refused');
  ok(wn.validateNotes({ releases: [{ ...base, highlights: { en: ['1', '2', '3', '4'], 'de-CH': ['1', '2', '3', '4'] } }] }).some((p) => /1 to 3/.test(p)), 'more than three highlights are refused');
  ok(wn.validateNotes({ releases: [{ ...base, version: '9.0.0' }, base] }).some((p) => /newest first/.test(p)), 'entries out of order are refused');
  ok(wn.validateNotes({ releases: [base, base] }).some((p) => /twice/.test(p)), 'a duplicate version is refused');
  ok(wn.validateNotes({ releases: [{ ...base, date: '5.11.2026' }] }).some((p) => /date/.test(p)), 'a bad date is refused');
  ok(wn.compareVersions('2.10.0', '2.9.0') === 1 && wn.compareVersions('2.9.0', '2.10.0') === -1 && wn.compareVersions('1.0.0', '1.0.0') === 0, 'versions compare numerically, not as text');
  ok(wn.loadNotes()[0].url === `${wn.RELEASES_URL}/tag/v${doc.releases[0].version}`, 'the full-notes link defaults to the GitHub release of that version');

  // ===== (b) the seen marker =================================================
  const notes = [
    { version: '3.0.0', date: '2026-12-01', highlights: base.highlights },
    { version: '2.11.0', date: '2026-11-20', highlights: base.highlights },
    { version: '2.10.0', date: '2026-11-02', highlights: base.highlights },
    { version: '2.9.0', date: '2026-10-28', highlights: base.highlights },
  ];
  const fresh = fs.mkdtempSync(path.join(WS, 'fresh-'));
  ok(wn.seedSeen({ running: '2.11.0', dataRoot: fresh, notes }) === '2.11.0', 'a fresh workspace starts at the running version');
  ok(wn.whatsNew({ running: '2.11.0', dataRoot: fresh, notes }).unseen.length === 0, 'so a fresh install shows nothing');

  const existing = fs.mkdtempSync(path.join(WS, 'existing-'));
  fs.writeFileSync(path.join(existing, 'clients.json'), '{"clients":[]}');
  ok(wn.seedSeen({ running: '2.11.0', dataRoot: existing, notes }) === '2.10.0', 'an existing install starts one version below');
  let r = wn.whatsNew({ running: '2.11.0', dataRoot: existing, notes });
  ok(r.unseen.map((e) => e.version).join() === '2.11.0', 'so it shows the running version once');
  ok(r.recent.map((e) => e.version).join() === '2.11.0,2.10.0,2.9.0', 'recent lists what runs and older, never a newer version');
  ok(wn.seedSeen({ running: '2.11.0', dataRoot: existing, notes }) === null, 'the baseline never overwrites a record');
  wn.markSeen('2.11.0', existing);
  ok(wn.whatsNew({ running: '2.11.0', dataRoot: existing, notes }).unseen.length === 0, 'after marking seen nothing shows');

  const skipped = fs.mkdtempSync(path.join(WS, 'skipped-'));
  wn.markSeen('2.9.0', skipped);
  r = wn.whatsNew({ running: '3.0.0', dataRoot: skipped, notes });
  ok(r.unseen.map((e) => e.version).join() === '3.0.0,2.11.0,2.10.0', 'skipped versions all show, newest first');

  const none = fs.mkdtempSync(path.join(WS, 'none-'));
  ok(wn.whatsNew({ running: '2.11.0', dataRoot: none, notes }).unseen.length === 0, 'no record at all counts as seen = running');
  fs.writeFileSync(path.join(none, wn.SEEN_NAME), 'not json');
  ok(wn.readSeen(none) === null, 'a broken marker reads as no record, never a crash');
  ok(wn.whatsNew({ running: '2.12.0', dataRoot: none, notes }).unseen.length === 0, 'a running version without notes shows nothing');

  // ===== (c) the routes =====================================================
  const { handleApi } = await import('../lib/api.mjs');
  server = http.createServer((req, res) => handleApi(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${url}/api/whats-new/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // An existing workspace below the running version: the route shows its notes.
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', wn.SEEN_NAME), JSON.stringify({ seen: '0.0.1' }));
  let res = await fetch(`${url}/api/whats-new`);
  let body = await res.json();
  ok(res.status === 200 && body.version === VERSION, 'GET /api/whats-new names the running version');
  ok(body.unseen[0]?.version === VERSION && body.unseen[0].highlights.en.length > 0 && body.unseen[0].highlights['de-CH'].length > 0, 'and its unseen notes in en and de-CH');
  res = await post({ version: '99.0.0' });
  ok(res.status === 400, 'a version newer than the running one is refused');
  res = await post({ version: 'latest' });
  ok(res.status === 400, 'a malformed version is refused');
  res = await post({});
  body = await res.json();
  ok(res.status === 200 && body.seen === VERSION && body.unseen.length === 0, 'POST /api/whats-new/seen with no version marks the running one');
  body = await (await fetch(`${url}/api/whats-new`)).json();
  ok(body.unseen.length === 0 && body.recent.length > 0, 'after that GET shows nothing unseen but keeps the recent notes');

  console.log(`[whats-new] OK - notes valid with an entry for ${VERSION}, seen marker, routes (${pass} assertions).`);
} catch (err) {
  console.error(`[whats-new] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(WS, { recursive: true, force: true });
}
