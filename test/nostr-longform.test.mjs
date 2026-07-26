#!/usr/bin/env node
// test/nostr-longform.test.mjs - Spec 18: Nostr NIP-23 long-form articles (kind
// 30023) + the NIP-96/98 media-upload sub-flow, exercised two ways:
//
//   A. PURE helpers (fast, deterministic, no relay): buildLongformTags (the NIP-23
//      tag mapping), planArticleImage (the P9 image-resolution decision) and
//      buildNostrEvent (the per-type kind selection: 30023 article | 1068 poll |
//      1 note) - so the kind/tags/content are asserted without a relay round-trip.
//
//   B. The REAL cmdPublishDue path in a subprocess with a STUBBED global WebSocket
//      (a FakeRelay that ACKs every EVENT and captures the signed event) - so the
//      end-to-end envelope behaviours the spec's acceptance scenarios describe are
//      proven on the live engine: a happy article, the media_not_configured degrade
//      (a local image + no NOSTR_MEDIA_SERVER never throws), an empty body [warn]-skip
//      (no row), and a type=text short note still building kind-1 (regression guard).
//
// Zero-dep node:assert. Mirrors the FakeRelay pattern in test/richer-analytics.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const NOSTR_SCRIPT = path.join(REPO, 'scripts', 'nostr-social.mjs');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };
const tagVal = (tags, name) => (tags.find((t) => t[0] === name) || [])[1];
const tagVals = (tags, name) => tags.filter((t) => t[0] === name).map((t) => t[1]);

try {
  const { buildLongformTags, planArticleImage, buildNostrEvent, buildImetaTag, publishedAtSecFor, keysFromSecret } =
    await import('../scripts/nostr-social.mjs');

  // A known keypair from a raw hex secret (no env needed - keysFromSecret is pure).
  const keys = keysFromSecret('11'.repeat(32));

  // ---- A1. buildLongformTags: the NIP-23 kind-30023 tag mapping -----------------
  const tags = buildLongformTags(
    { id: 'na1', title: 'Hello world', excerpt: 'A short summary' },
    'https://cdn.example/hero.png', 1700000000, ['#nostr', 'longform', '#nostr'],
  );
  ok(tagVal(tags, 'd') === 'na1', "d defaults to post.id when no blogSlug ('na1')");
  ok(tagVal(tags, 'title') === 'Hello world', 'title tag = post.title');
  ok(tagVal(tags, 'summary') === 'A short summary', 'summary tag = post.excerpt');
  ok(tagVal(tags, 'published_at') === '1700000000', 'published_at tag = the injected unix seconds (string)');
  ok(tagVal(tags, 'image') === 'https://cdn.example/hero.png', 'image tag = the resolved header-image URL');
  ok(JSON.stringify(tagVals(tags, 't')) === JSON.stringify(['nostr', 'longform', 'nostr']), "each hashtag maps to a 't' topic tag with the leading '#' stripped");

  const slugTags = buildLongformTags({ id: 'na1', blogSlug: 'my-custom-slug' }, null, 1700000000, []);
  ok(tagVal(slugTags, 'd') === 'my-custom-slug', 'd tag = post.blogSlug when set (parameterized-replaceable identity override)');
  ok(!slugTags.some((t) => t[0] === 'image'), 'the image tag is OMITTED when no image resolved (no broken tag)');
  ok(!slugTags.some((t) => t[0] === 't'), 'no t tags when there are no hashtags');

  // ---- A2. planArticleImage: the P9 image-resolution decision (no I/O) ----------
  ok(planArticleImage({ image: 'https://x/a.png', localPath: null, mediaServer: null }).mode === 'url', 'an already-remote http(s) image resolves to mode "url" (used directly, no upload)');
  ok(planArticleImage({ image: 'https://x/a.png', localPath: null, mediaServer: null }).imageUrl === 'https://x/a.png', 'mode "url" carries the URL verbatim');
  const degrade = planArticleImage({ image: '', localPath: '/tmp/render.png', mediaServer: null });
  ok(degrade.mode === 'degrade' && degrade.warning === 'media_not_configured', 'a LOCAL render with NO media server degrades (warning media_not_configured)');
  ok(planArticleImage({ image: '', localPath: '/tmp/render.png', mediaServer: 'https://m' }).mode === 'upload', 'a LOCAL render + a configured media server resolves to mode "upload"');
  ok(planArticleImage({ image: '', localPath: null, mediaServer: 'https://m' }).mode === 'none', 'no image + no local render = mode "none" (an image-less article is legitimate)');

  // ---- A3. buildNostrEvent: per-type kind selection + content ------------------
  const article = buildNostrEvent(
    { type: 'nostr-longform', id: 'na1', title: 'T', excerpt: 'E', body: 'Hello **world**', hashtags: ['#a', 'b'] },
    { keys, imageUrl: 'https://cdn.example/x.png', publishedAt: 1700000000 },
  );
  ok(article.kind === 30023, 'nostr-longform -> a kind-30023 event (NIP-23 long-form)');
  ok(article.content === 'Hello **world**', 'the article content is the Markdown body (verbatim)');
  ok(tagVal(article.tags, 'd') === 'na1' && tagVal(article.tags, 'title') === 'T' && tagVal(article.tags, 'summary') === 'E', 'the article event carries the d/title/summary tags');
  ok(tagVal(article.tags, 'image') === 'https://cdn.example/x.png' && JSON.stringify(tagVals(article.tags, 't')) === JSON.stringify(['a', 'b']), 'the article event carries the image + t tags');
  ok(typeof article.id === 'string' && article.id.length === 64 && typeof article.sig === 'string', 'the article event is signed (64-hex id + sig)');

  // Regression: a type=text post still builds a kind-1 NIP-01 short note, unchanged.
  const note = buildNostrEvent({ type: 'text', id: 'p2', nostrCaption: 'hi note' }, { keys });
  ok(note.kind === 1, 'REGRESSION: a type=text post still builds a kind-1 note');
  ok(note.content === 'hi note' && Array.isArray(note.tags) && note.tags.length === 0, 'the kind-1 note content = the note text, with no tags');

  // Regression: a type=poll post still builds a kind-1068 NIP-88 poll event (spec 10).
  const poll = buildNostrEvent(
    { type: 'poll', id: 'p3', caption: 'Q?', poll: { options: ['a', 'b'], durationMinutes: 60 } },
    { keys, relays: ['wss://relay-a'] },
  );
  ok(poll.kind === 1068, 'REGRESSION: a type=poll post still builds a kind-1068 poll event');
  ok(poll.content === 'Q?' && poll.tags.some((t) => t[0] === 'option'), 'the poll event content = the question, with option tags');

  // ---- A4. buildImetaTag + a media SHORT note (NIP-92) vs a byte-identical bare note --
  const imeta = buildImetaTag({ url: 'https://m.test/x.png', m: 'image/png', dim: '800x600', ox: 'abc123' });
  ok(JSON.stringify(imeta) === JSON.stringify(['imeta', 'url https://m.test/x.png', 'm image/png', 'dim 800x600', 'ox abc123']), 'buildImetaTag carries url/m/dim/ox as space-delimited fields (NIP-92)');
  ok(JSON.stringify(buildImetaTag({ url: 'https://m.test/y.png', m: 'image/png' })) === JSON.stringify(['imeta', 'url https://m.test/y.png', 'm image/png']), 'buildImetaTag omits absent fields (no broken empty field)');
  const mediaNote = buildNostrEvent({ type: 'text', id: 'm1', nostrCaption: 'look at this' }, { keys, media: { url: 'https://m.test/x.png', m: 'image/png' } });
  ok(mediaNote.kind === 1, 'a media short note is still a kind-1 event');
  ok(mediaNote.content === 'look at this\nhttps://m.test/x.png', 'the media note appends the media URL to the content (NIP-92 convention)');
  ok(mediaNote.tags.some((t) => t[0] === 'imeta' && t[1] === 'url https://m.test/x.png'), 'the media note carries a NIP-92 imeta tag');
  // REGRESSION: a no-media text note stays a BARE kind-1 - no tags, unchanged content.
  const bareNote = buildNostrEvent({ type: 'text', id: 'm2', nostrCaption: 'look at this' }, { keys });
  ok(bareNote.kind === 1 && bareNote.tags.length === 0 && bareNote.content === 'look at this', 'REGRESSION: a no-media text note is BYTE-IDENTICAL (bare kind-1, no tags, unchanged content)');

  // ---- A5. publishedAtSecFor: NIP-23 published_at = the FIRST-publish timestamp -----
  ok(publishedAtSecFor({ postedAt: '2020-01-02T03:04:05Z' }, 1700000000000) === Math.floor(Date.parse('2020-01-02T03:04:05Z') / 1000), 'publishedAtSecFor reuses post.postedAt (first-publish ts) when set - re-publish does not re-date the article');
  ok(publishedAtSecFor({}, 1700000000000) === 1700000000, 'publishedAtSecFor falls back to now (seconds) when postedAt is absent (a first publish)');
  ok(publishedAtSecFor({ postedAt: 'not-a-date' }, 1700000000000) === 1700000000, 'publishedAtSecFor falls back to now for an unparseable postedAt (never NaN)');

  // ---- B. The REAL cmdPublishDue path (subprocess + stubbed relay) -------------
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-longform-'));
  fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
  // NOSTR_MEDIA_SERVER is DELIBERATELY absent so a2's local-image article degrades.
  fs.writeFileSync(path.join(WS, '.env'), `NOSTR_PRIVATE_KEY=${'11'.repeat(32)}\nNOSTR_RELAYS=wss://relay-test\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(WS, 'render.png'), Buffer.from('89504e470d0a1a0a', 'hex')); // a stub PNG header (bytes only)
  const PLAN = path.join(WS, 'data', 'plans', 'c1.json');
  const base = { platforms: ['nostr'], executionMode: 'fully-scheduled', status: 'planned', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' };
  fs.writeFileSync(PLAN, JSON.stringify({
    campaign: 'c1',
    posts: [
      { ...base, id: 'a1', type: 'nostr-longform', title: 'Happy', excerpt: 'sum', body: '# Heading\n\nBody text.', image: 'https://cdn.example/hero.png', hashtags: ['#x'] },
      { ...base, id: 'a2', type: 'nostr-longform', title: 'Local img', body: 'Article with a local render.', path: path.join(WS, 'render.png') },
      { ...base, id: 'a3', type: 'nostr-longform', title: 'Empty', body: '   ' },
      { ...base, id: 't1', type: 'text', nostrCaption: 'a plain short note' },
    ],
  }, null, 2));

  const CAPTURE = path.join(WS, 'captured.json');
  const liveEnv = { ...process.env };
  delete liveEnv.PENDPOST_MODE; // exercise the REAL path, never the mock driver
  const wrapper = `
    const { writeFileSync } = await import('node:fs');
    const captured = [];
    class FakeRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let frame; try { frame = JSON.parse(raw); } catch { return; }
        if (frame[0] === 'EVENT') {
          const ev = frame[1];
          captured.push(ev);
          setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', ev.id, true]) }), 0);
        }
      }
      close() { /* no-op - never emits a close frame */ }
    }
    globalThis.WebSocket = FakeRelay;
    process.on('exit', () => { try { writeFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify(captured)); } catch {} });
    process.argv = [process.argv[0], ${JSON.stringify(NOSTR_SCRIPT)}, 'publish-due', '--plan', ${JSON.stringify(PLAN)}, '--json', '--actor', 'pendpost'];
    await import(${JSON.stringify(NOSTR_SCRIPT)});
  `;
  const out = execFileSync(process.execPath, ['-e', wrapper], { cwd: REPO, env: { ...liveEnv, PENDPOST_ROOT: WS }, encoding: 'utf8' });
  const envelope = JSON.parse(out.trim().split('\n').pop());
  const rows = envelope.results || [];
  const rowFor = (id) => rows.find((r) => r.postId === id);
  const captured = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
  const evFor = (id) => captured.find((e) => e.id === (rowFor(id) || {}).id);

  ok(envelope.ok === true, 'publish-due returns ok:true (no throw across the whole run)');
  // a3 (empty body) is [warn]-skipped: no result row, and it never got signed.
  ok(!rowFor('a3'), 'an empty-body article is [warn]-skipped - no result row emitted');
  ok(rows.length === 3, 'exactly the 3 non-empty posts (a1, a2, t1) produced a row');

  // a1: happy article - a signed kind-30023 event with content=body + the image tag.
  const a1 = rowFor('a1');
  ok(a1 && a1.ok === true && typeof a1.id === 'string' && !a1.warning, 'a1 (happy article) publishes ok:true with an event id and NO warning');
  const a1ev = evFor('a1');
  ok(a1ev && a1ev.kind === 30023, 'the REAL publish path signed a1 as a kind-30023 article');
  ok(a1ev && a1ev.content === '# Heading\n\nBody text.', 'a1 event content = the Markdown body');
  ok(a1ev && tagVal(a1ev.tags, 'd') === 'a1' && tagVal(a1ev.tags, 'image') === 'https://cdn.example/hero.png', 'a1 event carries d=post.id + the remote image tag (used directly, no upload)');

  // a2: local image + NO NOSTR_MEDIA_SERVER -> text-only degrade (never a throw).
  const a2 = rowFor('a2');
  ok(a2 && a2.ok === true && a2.warning === 'media_not_configured', 'a2 (local image, no media server) degrades: ok:true + warning media_not_configured (P9, no throw)');
  const a2ev = evFor('a2');
  ok(a2ev && a2ev.kind === 30023 && !a2ev.tags.some((t) => t[0] === 'image'), 'a2 published as a kind-30023 article WITHOUT an image tag (text-only degrade)');

  // t1: a plain short note - the kind-1 path is unchanged (regression guard).
  const t1 = rowFor('t1');
  ok(t1 && t1.ok === true && !t1.warning, 't1 (type=text) still publishes ok:true');
  const t1ev = evFor('t1');
  ok(t1ev && t1ev.kind === 1 && t1ev.content === 'a plain short note', 'REGRESSION: t1 is still a kind-1 note with the note text unchanged');

  fs.rmSync(WS, { recursive: true, force: true });

  // ---- C. --dry-run performs NO upload + NO relay publish (side-effect-free) --------
  // The pre-fix bug: uploadNostrMedia ran BEFORE the dry-run gate, so a dry-run did a
  // real signed NIP-96 upload. Here NOSTR_MEDIA_SERVER is SET and both posts carry a
  // local render, so a leaked upload would call fetch. We assert fetch is NEVER called,
  // NO event is signed/published (empty capture), and the plan stays 'planned'.
  const DWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-dry-'));
  fs.mkdirSync(path.join(DWS, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(DWS, '.env'), `NOSTR_PRIVATE_KEY=${'11'.repeat(32)}\nNOSTR_RELAYS=wss://relay-test\nNOSTR_MEDIA_SERVER=https://media.test\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(DWS, 'render.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const DPLAN = path.join(DWS, 'data', 'plans', 'd1.json');
  fs.writeFileSync(DPLAN, JSON.stringify({
    campaign: 'd1',
    posts: [
      { ...base, id: 'da1', type: 'nostr-longform', title: 'Dry article', body: 'Body.', path: path.join(DWS, 'render.png') },
      { ...base, id: 'dt1', type: 'text', nostrCaption: 'dry note', path: path.join(DWS, 'render.png') },
    ],
  }, null, 2));
  const DCAP = path.join(DWS, 'events.json');
  const DFETCH = path.join(DWS, 'fetch.json');
  const dryWrapper = `
    const { writeFileSync } = await import('node:fs');
    const captured = [];
    const fetchCalls = [];
    globalThis.fetch = async (...a) => { fetchCalls.push(String(a[0])); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
    class FakeRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) { let f; try { f = JSON.parse(raw); } catch { return; } if (f[0] === 'EVENT') { captured.push(f[1]); setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', f[1].id, true]) }), 0); } }
      close() {}
    }
    globalThis.WebSocket = FakeRelay;
    process.on('exit', () => { try { writeFileSync(${JSON.stringify(DCAP)}, JSON.stringify(captured)); writeFileSync(${JSON.stringify(DFETCH)}, JSON.stringify(fetchCalls)); } catch {} });
    process.argv = [process.argv[0], ${JSON.stringify(NOSTR_SCRIPT)}, 'publish-due', '--plan', ${JSON.stringify(DPLAN)}, '--dry-run', '--json'];
    await import(${JSON.stringify(NOSTR_SCRIPT)});
  `;
  execFileSync(process.execPath, ['-e', dryWrapper], { cwd: REPO, env: { ...liveEnv, PENDPOST_ROOT: DWS }, encoding: 'utf8' });
  const dryEvents = JSON.parse(fs.readFileSync(DCAP, 'utf8'));
  const dryFetch = JSON.parse(fs.readFileSync(DFETCH, 'utf8'));
  ok(dryFetch.length === 0, 'dry-run performs NO NIP-96 upload (fetch is never called - the upload is gated behind the dry-run check)');
  ok(dryEvents.length === 0, 'dry-run signs + publishes NO event (nothing fanned to a relay)');
  const dryPlan = JSON.parse(fs.readFileSync(DPLAN, 'utf8'));
  ok(dryPlan.posts.every((p) => p.status === 'planned' && !p.nostrEventId), 'dry-run mutates no plan state (posts stay planned, no nostrEventId)');
  fs.rmSync(DWS, { recursive: true, force: true });

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[nostr-longform] OK - NIP-23 kind-30023 tag mapping + content, planArticleImage P9 decision, per-type kind selection (article/poll/note), NIP-92 imeta media short note + byte-identical bare note, published_at first-publish reuse, the REAL publish path (happy article, media_not_configured degrade, empty-body skip, kind-1 regression), and a side-effect-free --dry-run (no upload, no publish) (${pass} assertions).`);
} catch (err) {
  console.error(`[nostr-longform] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
}
