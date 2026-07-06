#!/usr/bin/env node
// test/platform-validate-wave2.test.mjs - platformValidate readiness rules for
// the five wave-2 lanes (mastodon, wordpress, ghost, nostr, gbp). Sibling of
// test/platform-validate-lanes.test.mjs (same harness, same reason to exist):
// without the per-platform blocks, a post targeting an unconnected lane read
// ready:true while publish-due warn-skipped it forever.
//
// Proven here, per lane:
//   (1) connectivity: no credentials -> "not connected" problem + needsSetup
//       (the Setup-page link signal); the WordPress app-password triple is
//       all-or-nothing, and the identifier half-setups block separately with
//       the env var named: mastodon token without MASTODON_INSTANCE_URL,
//       nostr key without NOSTR_RELAYS, GBP token without account/location,
//   (2) content shape: mastodon 500 note cap against the EFFECTIVE text
//       (mastodonCaption override, the xCaption rule - both directions),
//       wordpress/ghost article requirements (title + body-or-caption
//       fallback), ghost excerpt>300 as an advisory truncation warning,
//       nostr text presence (nostrCaption override) + text-only media
//       warning, gbp 1500 summary cap + Event completeness + the
//       public-image-URL-only media warning,
//   (3) a well-shaped, approved post on a fully-connected lane is ready:true.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/platform-policy.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wave2-validate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'wave2');
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });
// A tiny mp4 so media-backed posts pass the generic media-exists check and the
// lane-specific media warnings (nostr text-only, gbp public-URL) can fire.
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const FUTURE = '2099-01-01T09:00:00Z';
const post = (id, platforms, extra = {}) => ({
  id, platforms, type: 'text', scheduledAt: FUTURE, caption: 'a quiet note',
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'wave2', path: 'data/plans/wave2/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Wave-2 lane readiness',
  timezone: 'UTC',
  posts: [
    // Well-shaped, one per lane: ready:true once the lane is connected.
    post('masto-ready', ['mastodon']),
    post('wp-ready', ['wordpress'], { title: 'A fine post' }),
    post('gh-ready', ['ghost'], { title: 'A fine post' }),
    post('no-ready', ['nostr']),
    post('gbp-ready', ['gbp']),
    // Content-shape offenders (connectivity resolved by then; each problem is
    // exactly what its engine warn-skips or the API rejects at publish time).
    post('masto-long', ['mastodon'], { caption: 'a'.repeat(520) }),
    post('masto-override-long', ['mastodon'], { mastodonCaption: 'a'.repeat(520) }),
    post('masto-override-ok', ['mastodon'], { caption: 'a'.repeat(520), mastodonCaption: 'a short toot instead' }),
    post('wp-notitle', ['wordpress']),
    post('wp-nobody', ['wordpress'], { title: 'A fine post', caption: '' }),
    post('wp-bodyonly', ['wordpress'], { title: 'A fine post', caption: '', body: '## markdown body\n\nlong-form content.' }),
    post('gh-notitle', ['ghost']),
    post('gh-nobody', ['ghost'], { title: 'A fine post', caption: '' }),
    post('gh-excerpt', ['ghost'], { title: 'A fine post', excerpt: 'e'.repeat(320) }),
    post('no-notext', ['nostr'], { caption: '' }),
    post('no-override', ['nostr'], { caption: '', nostrCaption: 'a note signed into the void' }),
    post('no-media', ['nostr'], { type: 'reel', path: 'data/media/clip.mp4' }),
    post('gbp-long', ['gbp'], { caption: 'a'.repeat(1600) }),
    post('gbp-event-half', ['gbp'], { gbp: { topic: 'event', eventTitle: 'Launch party' } }),
    post('gbp-event-full', ['gbp'], { gbp: { topic: 'event', eventTitle: 'Launch party', eventStart: '2099-01-02', eventEnd: '2099-01-03' } }),
    post('gbp-media-nourl', ['gbp'], { type: 'reel', path: 'data/media/clip.mp4' }),
    post('gbp-media-url', ['gbp'], { type: 'reel', path: 'data/media/clip.mp4', image: 'https://example.com/promo.jpg' }),
  ],
}, null, 2));

const { platformValidate } = await import('../lib/writes.mjs');
const validate = async (postId) => {
  const r = await platformValidate({ campaign: 'wave2', postId });
  assert.ok(r.ok, `platformValidate(${postId}): ${JSON.stringify(r)}`);
  return r.platforms;
};

try {
  // ===== (1) connectivity: nothing connected -> every lane blocks with needsSetup =====
  for (const [id, lane, label] of [
    ['masto-ready', 'mastodon', 'Mastodon'],
    ['wp-ready', 'wordpress', 'WordPress'],
    ['gh-ready', 'ghost', 'Ghost'],
    ['no-ready', 'nostr', 'Nostr'],
    ['gbp-ready', 'gbp', 'Google Business Profile'],
  ]) {
    const v = (await validate(id))[lane];
    ok(v.ready === false, `${lane}: an approved post on an unconnected lane is NOT ready`);
    ok(v.problems.some((p) => new RegExp(`${label}.*not connected`, 'i').test(p)), `${lane}: carries a "${label} not connected" problem`);
    ok(v.needsSetup === true, `${lane}: needsSetup routes the fix to the Setup page`);
  }

  // ===== (2) half-setups: partial credentials still block, identifiers named =====
  fs.writeFileSync(path.join(WS, '.env'), [
    // WordPress app-password auth is a triple - two of three is NOT connected.
    'WORDPRESS_SITE_URL=https://blog.example.com',
    'WORDPRESS_USERNAME=owner',
    // GBP token without the target identifiers - connected but unroutable.
    'GBP_ACCESS_TOKEN=sentinel-gbp',
    // Mastodon token without the instance URL - authenticated but unroutable
    // (the publisher throws at publish time without it).
    'MASTODON_ACCESS_TOKEN=sentinel-masto',
    // Nostr signing key without a relay list - signable but undeliverable.
    'NOSTR_PRIVATE_KEY=sentinel-nsec',
    '',
  ].join('\n'), { mode: 0o600 });
  const wpHalf = (await validate('wp-ready')).wordpress;
  ok(wpHalf.ready === false && wpHalf.problems.some((p) => /WordPress not connected/.test(p)), 'wordpress: site URL + username without the app password is still not connected');
  ok(wpHalf.needsSetup === true, 'wordpress: the missing app password is a Setup-page fix (needsSetup)');
  const gbpHalf = (await validate('gbp-ready')).gbp;
  ok(gbpHalf.ready === false && gbpHalf.problems.some((p) => /gbpAccountId/.test(p) && /gbpLocationId/.test(p)), 'gbp: a token without account/location blocks, naming both identifiers');
  ok(gbpHalf.problems.every((p) => !/not connected/i.test(p)), 'gbp: the identifier half-setup does NOT double-report "not connected"');
  ok(gbpHalf.needsSetup === true, 'gbp: the missing identifiers are a Setup-page fix (needsSetup)');
  const mastoHalf = (await validate('masto-ready')).mastodon;
  ok(mastoHalf.ready === false && mastoHalf.problems.some((p) => /MASTODON_INSTANCE_URL/.test(p)), 'mastodon: a token without the instance URL blocks, naming MASTODON_INSTANCE_URL');
  ok(mastoHalf.problems.every((p) => !/not connected/i.test(p)), 'mastodon: the instance half-setup does NOT double-report "not connected"');
  ok(mastoHalf.needsSetup === true, 'mastodon: the missing instance URL is a Setup-page fix (needsSetup)');
  const nostrHalf = (await validate('no-ready')).nostr;
  ok(nostrHalf.ready === false && nostrHalf.problems.some((p) => /NOSTR_RELAYS/.test(p)), 'nostr: a signing key without relays blocks, naming NOSTR_RELAYS');
  ok(nostrHalf.problems.every((p) => !/not connected/i.test(p)), 'nostr: the relay half-setup does NOT double-report "not connected"');
  ok(nostrHalf.needsSetup === true, 'nostr: the missing relays are a Setup-page fix (needsSetup)');

  // ===== fully connected from here on =====
  fs.writeFileSync(path.join(WS, '.env'), [
    'MASTODON_INSTANCE_URL=https://mastodon.example',
    'MASTODON_ACCESS_TOKEN=sentinel-masto',
    'WORDPRESS_SITE_URL=https://blog.example.com',
    'WORDPRESS_USERNAME=owner',
    'WORDPRESS_APP_PASSWORD=sentinel-wp',
    'GHOST_SITE_URL=https://ghost.example.com',
    'GHOST_ADMIN_API_KEY=abcdef123456:sentinel-ghost',
    'NOSTR_PRIVATE_KEY=sentinel-nsec',
    'NOSTR_RELAYS=wss://relay.example',
    'GBP_ACCESS_TOKEN=sentinel-gbp',
    'GBP_ACCOUNT_ID=accounts/123',
    'GBP_LOCATION_ID=locations/456',
    '',
  ].join('\n'), { mode: 0o600 });

  // ===== (3) well-shaped + connected + approved -> ready:true, clean =====
  for (const [id, lane] of [['masto-ready', 'mastodon'], ['wp-ready', 'wordpress'], ['gh-ready', 'ghost'], ['no-ready', 'nostr'], ['gbp-ready', 'gbp']]) {
    const v = (await validate(id))[lane];
    ok(v.ready === true && v.problems.length === 0 && v.needsSetup === false, `${lane}: a well-shaped approved post on the connected lane is ready:true`);
  }

  // ===== (4) mastodon: 500 cap on the EFFECTIVE text (mastodonCaption || caption) =====
  const mLong = (await validate('masto-long')).mastodon;
  ok(mLong.ready === false && mLong.problems.some((p) => /500/.test(p)), 'mastodon: a 520-char caption names the 500 cap');
  const mOverLong = (await validate('masto-override-long')).mastodon;
  ok(mOverLong.problems.some((p) => /500/.test(p) && /mastodonCaption/.test(p)), 'mastodon: an over-cap mastodonCaption OVERRIDE blocks (it is the effective text), pointing at mastodonCaption');
  const mOverOk = (await validate('masto-override-ok')).mastodon;
  ok(mOverOk.ready === true && mOverOk.problems.length === 0, 'mastodon: a short mastodonCaption RESCUES an over-cap shared caption (the override wins both ways)');

  // ===== (5) wordpress/ghost: article shape = title + body-or-caption fallback =====
  for (const [prefix, lane, label] of [['wp', 'wordpress', 'WordPress'], ['gh', 'ghost', 'Ghost']]) {
    const noTitle = (await validate(`${prefix}-notitle`))[lane];
    ok(noTitle.ready === false && noTitle.problems.some((p) => new RegExp(`${label}.*title`).test(p)), `${lane}: a post without a title blocks (articles need one)`);
    const noBody = (await validate(`${prefix}-nobody`))[lane];
    ok(noBody.ready === false && noBody.problems.some((p) => new RegExp(`${label}.*body`).test(p)), `${lane}: a title with neither body nor caption blocks (nothing to publish)`);
  }
  const wpBodyOnly = (await validate('wp-bodyonly')).wordpress;
  ok(wpBodyOnly.ready === true && wpBodyOnly.problems.length === 0, 'wordpress: a markdown body with an empty caption satisfies the body-or-caption fallback');

  // ===== (6) ghost excerpt: over-300 is an advisory truncation warning, not a blocker =====
  const ghExcerpt = (await validate('gh-excerpt')).ghost;
  ok(ghExcerpt.problems.length === 0 && ghExcerpt.ready === true, 'ghost: a 320-char excerpt is NOT a blocker (the engine truncates)');
  ok(ghExcerpt.warnings.some((w) => /300/.test(w)), 'ghost: the over-long excerpt carries a 300-cap truncation warning');

  // ===== (7) nostr: text presence (nostrCaption || caption); media publishes text only =====
  const nNoText = (await validate('no-notext')).nostr;
  ok(nNoText.ready === false && nNoText.problems.some((p) => /note text/i.test(p)), 'nostr: a post with no text blocks (nothing to sign)');
  const nOverride = (await validate('no-override')).nostr;
  ok(nOverride.ready === true && nOverride.problems.length === 0, 'nostr: a nostrCaption override satisfies text presence with an empty caption');
  const nMedia = (await validate('no-media')).nostr;
  ok(nMedia.problems.length === 0 && nMedia.ready === true, 'nostr: a media post is NOT blocked (the note still publishes)');
  ok(nMedia.warnings.some((w) => /text only/i.test(w)), 'nostr: the media post carries a text-only advisory warning');

  // ===== (8) gbp: 1500 summary cap, Event completeness, public-image-URL media warning =====
  const gLong = (await validate('gbp-long')).gbp;
  ok(gLong.ready === false && gLong.problems.some((p) => /1500/.test(p)), 'gbp: a 1600-char caption names the 1500 cap');
  const gEventHalf = (await validate('gbp-event-half')).gbp;
  ok(gEventHalf.ready === false && gEventHalf.problems.some((p) => /event title, start and end/i.test(p)), 'gbp: an Event post missing start/end blocks (completeness rule)');
  const gEventFull = (await validate('gbp-event-full')).gbp;
  ok(gEventFull.ready === true && gEventFull.problems.length === 0, 'gbp: a complete Event (title + start + end) is ready');
  const gMediaNoUrl = (await validate('gbp-media-nourl')).gbp;
  ok(gMediaNoUrl.problems.length === 0 && gMediaNoUrl.ready === true, 'gbp: a media post without post.image is NOT blocked (the post still publishes)');
  ok(gMediaNoUrl.warnings.some((w) => /public URL/i.test(w)), 'gbp: the URL-less media post carries the public-URL-only advisory warning');
  const gMediaUrl = (await validate('gbp-media-url')).gbp;
  ok(gMediaUrl.warnings.length === 0 && gMediaUrl.ready === true, 'gbp: a media post WITH post.image set is clean (the URL is what v4 takes)');

  console.log(`[platform-validate-wave2] OK - mastodon/wordpress/ghost/nostr/gbp readiness: connectivity + half-setups block with needsSetup, content shapes match the engines, advisory warnings never gate ready (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
