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

  // A valid item and entry; each case below breaks exactly one rule.
  const item = (over = {}) => ({
    kind: 'new',
    icon: 'layers',
    title: { en: 'Also as story', 'de-CH': 'Auch als Story' },
    body: { en: 'One post goes out as a feed post and a story.', 'de-CH': 'Ein Beitrag erscheint als Feed-Beitrag und als Story.' },
    ...over,
  });
  const base = { version: '9.1.0', date: '2026-11-05', items: [item(), item({ kind: 'improved', icon: 'shield-check', go: 'approvals' })] };
  const withItem = (over) => ({ releases: [{ ...base, items: [item(over), item()] }] });
  const refused = (d, re) => wn.validateNotes(d).some((p) => re.test(p));
  ok(wn.validateNotes({ releases: [base] }).length === 0, 'a minimal entry with two items is valid');
  ok(wn.KINDS.join() === 'new,improved,fixed' && Object.isFrozen(wn.KINDS) && Object.isFrozen(wn.ICONS), 'KINDS and ICONS are frozen lists');
  const lucideDir = ['app/node_modules', '../../../app/node_modules'].map((d) => path.join(import.meta.dirname, '..', d, 'lucide-react/dist/esm/icons')).find((d) => fs.existsSync(d));
  if (lucideDir) ok(wn.ICONS.every((n) => fs.existsSync(path.join(lucideDir, `${n}.js`))), 'every ICONS name exists in lucide-react');
  ok(refused({ releases: [{ ...base, items: [item()] }] }, /2 to 4 "items"/), 'a single item is refused');
  ok(refused({ releases: [{ ...base, items: [item(), item(), item(), item(), item()] }] }, /2 to 4 "items"/), 'five items are refused');
  ok(refused({ releases: [{ ...base, items: undefined }] }, /2 to 4 "items"/), 'an entry without items is refused');
  ok(refused({ releases: [{ version: '9.1.0', date: '2026-11-05', highlights: { en: ['One.'], 'de-CH': ['Eins.'] } }] }, /"highlights" is the old format/), 'the legacy highlights shape is refused with a clear message');
  ok(refused(withItem({ kind: 'added' }), /"kind" must be one of/), 'an unknown kind is refused');
  ok(refused(withItem({ icon: 'rocket-ship' }), /not in ICONS/), 'an icon outside ICONS is refused');
  ok(refused(withItem({ go: 'Approvals' }), /"go" must be a lowercase slug/), 'a go key that is not a lowercase slug is refused');
  ok(refused(withItem({ go: 'a' }), /"go"/), 'a one-letter go key is refused');
  ok(refused(withItem({ title: { en: 'A title that is far too long to fit', 'de-CH': 'Kurz' } }), /title\.en is over 32/), 'a title over 32 characters is refused');
  ok(refused(withItem({ title: { en: 'Also as story.', 'de-CH': 'Auch als Story' } }), /title\.en ends with a period/), 'a title ending in a period is refused');
  ok(refused(withItem({ body: { en: `${'x'.repeat(90)}.`, 'de-CH': 'Ein Satz.' } }), /body\.en is over 90/), 'a body over 90 characters is refused');
  ok(refused(withItem({ body: { en: 'One post. Two stories.', 'de-CH': 'Ein Satz.' } }), /body\.en is more than one sentence/), 'a body of two sentences is refused');
  ok(refused(withItem({ body: { en: 'No period at the end', 'de-CH': 'Ein Satz.' } }), /body\.en does not end with a period/), 'a body without a closing period is refused');
  ok(refused(withItem({ title: { en: 'Also as story' } }), /title\.de-CH is missing/), 'a missing de-CH title is refused');
  ok(refused(withItem({ body: { en: 'One sentence.' } }), /body\.de-CH is missing/), 'a missing de-CH body is refused');
  ok(refused(withItem({ body: { en: 'A \u2014 b.', 'de-CH': 'Ein Satz.' } }), /em or en dash/), 'an em dash is refused');
  ok(refused(withItem({ title: { en: 'A \u2013 b', 'de-CH': 'Kurz' } }), /em or en dash/), 'an en dash in a title is refused');
  ok(refused(withItem({ body: { en: 'One.', 'de-CH': 'Gro\u00dfe Freude.' } }), /sharp s/), 'the sharp s is refused in de-CH');
  ok(refused({ releases: [{ ...base, version: '9.0.0' }, base] }, /newest first/), 'entries out of order are refused');
  ok(refused({ releases: [base, base] }, /twice/), 'a duplicate version is refused');
  ok(refused({ releases: [{ ...base, version: '9.1' }] }, /x\.y\.z/), 'a bad version is refused');
  ok(refused({ releases: [{ ...base, date: '5.11.2026' }] }, /date/), 'a bad date is refused');
  ok(wn.compareVersions('2.10.0', '2.9.0') === 1 && wn.compareVersions('2.9.0', '2.10.0') === -1 && wn.compareVersions('1.0.0', '1.0.0') === 0, 'versions compare numerically, not as text');
  const loaded = wn.loadNotes();
  ok(wn.CHANGELOG_URL === 'https://pendpost.com/changelog', 'the full notes live on the pendpost.com changelog');
  ok(loaded[0].url === `https://pendpost.com/changelog#v${doc.releases[0].version}`, 'the full-notes link is the changelog anchor of that version');
  ok(loaded.every((r) => Array.isArray(r.items) && r.items.length >= 2 && !('highlights' in r)), 'loadNotes returns items, never highlights');

  // ===== (b) the seen marker =================================================
  const notes = [
    { version: '3.0.0', date: '2026-12-01', items: base.items },
    { version: '2.11.0', date: '2026-11-20', items: base.items },
    { version: '2.10.0', date: '2026-11-02', items: base.items },
    { version: '2.9.0', date: '2026-10-28', items: base.items },
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
  const top = body.unseen[0];
  ok(top?.version === VERSION && top.items.length >= 2 && top.items.every((i) => i.title.en && i.title['de-CH'] && i.body.en && i.body['de-CH']), 'and its unseen items in en and de-CH');
  ok(body.releasesUrl === 'https://pendpost.com/changelog' && top.url === `https://pendpost.com/changelog#v${VERSION}`, 'the full-notes links point at the changelog');
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
