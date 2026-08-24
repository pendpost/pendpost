// mock-driver.mjs - the credential-free driver. It implements the same envelope
// contract the real engines emit (see ./interface.mjs), but talks to NOTHING:
// no Meta/LinkedIn/YouTube/Cloudinary calls ever happen. It fabricates platform
// ids + realistic metrics, mirrors the real engines' plan mutations (so the
// scheduler, dashboard and insights all see a published post), and records every
// fake publish in data/.mock-ledger.json for transparency.
//
// This is the adoption unlock: a stranger with zero credentials runs the FULL
// loop (draft -> approve -> schedule -> publish -> insights). It is also reused
// as test infrastructure (test/mock-loop.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, atomicWriteJson, readEnv, parseCsvRows } from '../util.mjs';
import { isPollPost, pollBlocker, POLL_LANE_LIMITS } from '../poll.mjs';
import { isCarouselPost, carouselItems, carouselBlocker, carouselUnsupported, CAROUSEL_LANE_LIMITS } from '../carousel.mjs';
import { effectivePublicUrl } from '../public-media.mjs';
import { recordAttempt } from '../publish-hold.mjs';
import { getPosting } from '../config.mjs';
import { COMMENT_CAPABILITIES, LANE_OBJECT_FIELD } from '../comments.mjs';
import { stampFollowup, needsFollowupCheck } from '../radar.mjs';
import { classifySubRules } from '../reddit-norms.mjs';
import { assertMockRootAllowed } from '../mode.mjs';

// ---- deterministic-but-realistic fake data -------------------------------

let idCounter = 0;
function uniq() {
  idCounter += 1;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
function mockId(prefix) { return `mock_${prefix}_${uniq()}`; }
function mockShareUrn() { return `urn:li:share:mock${Math.floor(Math.random() * 1e12)}`; }
function mockYtId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = 'mock';
  for (let i = 0; i < 7; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s; // 11 chars, YouTube-id shaped
}

// Seeded PRNG so a post's metrics are STABLE across insight sweeps (insights.mjs
// only appends history when metrics change - stable numbers keep that honest).
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function metricsFor(platform, postId) {
  const r = seeded(`${postId}:${platform}`);
  const n = (min, max) => Math.floor(min + r() * (max - min));
  if (platform === 'instagram') return { plays: n(800, 5000), reach: n(700, 4500), likes: n(40, 400), comments: n(2, 40), shares: n(1, 30), saved: n(5, 80) };
  if (platform === 'facebook') return { views: n(500, 4000), reach: n(400, 3500), likes: n(20, 300), comments: n(1, 30), shares: n(1, 25) };
  if (platform === 'youtube') return { views: n(300, 6000), likes: n(15, 500), comments: n(0, 60) };
  // Spec 08 (richer analytics): reach/engagement are two more fields the SAME
  // real totalShareStatistics response carries - mirrored here so mock/live
  // never disagree on shape. LinkedIn's `engagement` is a RATE (a 0-1 decimal),
  // NOT a count, so it is seeded as a float in [0,1) - a rate is meaningful
  // per-post but must never be summed across posts (see RATE_METRIC_KEYS).
  if (platform === 'linkedin') return { impressions: n(600, 5000), clicks: n(10, 200), likes: n(20, 300), comments: n(1, 40), shares: n(1, 30), reach: n(500, 4500), engagement: Number(r().toFixed(4)) };
  if (platform === 'x') return { impressions: n(700, 6000), likes: n(20, 400), comments: n(1, 40), shares: n(1, 50), bookmarks: n(0, 60) };
  if (platform === 'discord') return { reactions: n(0, 100), replies: n(0, 50) };
  // R3 (ux-audit 2026-08-04): mirrors the REAL cmdInsights shape (reddit-social.mjs
  // reads score/num_comments/upvote_ratio from /api/info) so mock/live never
  // disagree on shape. upvote_ratio is a RATE in [0,1] (like linkedin engagement),
  // seeded as a plausible 0.5-1.0 decimal - never summed across posts.
  if (platform === 'reddit') return { score: n(0, 1800), num_comments: n(0, 200), upvote_ratio: Number((0.5 + r() * 0.5).toFixed(2)) };
  if (platform === 'pinterest') return { impressions: n(100, 8000), saved: n(0, 400), clicks: n(0, 300) };
  if (platform === 'tiktok') return { views: n(500, 50000), likes: n(20, 4000), comments: n(0, 300), shares: n(0, 500) };
  if (platform === 'mastodon') return { favourites: n(5, 300), reblogs: n(0, 120), replies: n(0, 40) };
  if (platform === 'wordpress') return { views: n(50, 3000), comments: n(0, 40) };
  // Spec 08: ghost's real `insights` verb reads ?include=email,count.clicks -
  // opened/sent/clicks is the exact shape, mirrored here (views/members was
  // never real - the live verb used to be a documented no-op).
  if (platform === 'ghost') return { opened: n(0, 500), sent: n(100, 5000), clicks: n(0, 300) };
  // Spec 08: nostr's real `insights` verb counts kind-7 reactions + kind-9735
  // zap receipts only - mirrored here (no 'reposts', which the live verb never
  // fetches). Spec 20 adds zapSats (summed value in sats from the receipts).
  if (platform === 'nostr') return { reactions: n(0, 80), zaps: n(0, 20), zapSats: n(0, 5000) };
  if (platform === 'gbp') return { views: n(100, 5000), ctaClicks: n(0, 150) };
  return { views: n(100, 1000) };
}

// Spec 08: youtube's supplementary watch-time time-series (a SEPARATE,
// yt-analytics.readonly-gated call in the real engine) - seeded independently
// of the base metricsFor('youtube', ...) numbers so the two can be granted/
// ungranted independently, exactly like the live degrade.
function ytWatchTimeFor(postId) {
  const r = seeded(`${postId}:youtube:analytics`);
  const n = (min, max) => Math.floor(min + r() * (max - min));
  return { watchTimeMin: n(5, 800), avgViewSec: n(8, 240) };
}

// Spec 08: telegram's real `insights` verb is account-scoped (getChatMemberCount) -
// the ONE honest number the Bot API has, with no per-post breakdown. Seeded on a
// fixed key (not a postId) since it is not post-specific.
function telegramSubscribers() {
  const r = seeded('telegram:subscribers');
  return Math.floor(200 + r() * 5000);
}

// ---- plan helpers (raw post objects, same fields the real engines write) ---

function loadPlan(planPath) { return JSON.parse(fs.readFileSync(planPath, 'utf8')); }
function savePlan(planPath, plan) { atomicWriteJson(planPath, plan); }

function platformPending(post, platform) {
  if (platform === 'facebook') return !(post.fbPostId || post.fbReelId);
  if (platform === 'instagram') return !post.igMediaId;
  if (platform === 'linkedin') return !post.liPostId;
  if (platform === 'youtube') return !post.ytVideoId;
  if (platform === 'x') return !post.xPostId;
  if (platform === 'telegram') return !post.tgMessageId;
  if (platform === 'discord') return !post.dcMessageId;
  if (platform === 'reddit') return !post.redditPostId;
  if (platform === 'pinterest') return !post.pinId;
  if (platform === 'tiktok') return !post.tiktokVideoId;
  if (platform === 'mastodon') return !(post.mastodonStatusId || post.mastodonScheduledId);
  if (platform === 'wordpress') return !post.wordpressPostId;
  if (platform === 'ghost') return !post.ghostPostId;
  if (platform === 'nostr') return !post.nostrEventId;
  if (platform === 'gbp') return !post.gbpPostId;
  if (platform === 'bluesky') return !post.blueskyPostId; // spec 34: Radar reply-to-external lane
  return false;
}

// Mirror lanesFor's due gates so CLI `publish-due` with no --only behaves like
// the scheduler: meta/linkedin fire when due, youtube schedules ahead of due,
// and the mastodon/wordpress/ghost native lanes fire whenever owed (ahead of
// due they schedule natively, past due they publish immediately).
function eligible(platform, post) {
  if (post.approval !== 'approved' || post.status === 'posted') return false;
  // Publish hold (lib/publish-hold.mjs): the failure cap is spent - the live engines'
  // publish-due loops skip a held post, so the mock's fence must too (test fidelity).
  if (post.publishHold) return false;
  const due = Date.parse(post.scheduledAt || '');
  if (Number.isNaN(due)) return false;
  const now = Date.now();
  const platforms = post.platforms || [];
  if (platform === 'youtube') return platforms.includes('youtube') && !post.ytVideoId && due > now;
  if (platform === 'mastodon') return platforms.includes('mastodon') && !post.mastodonStatusId && !post.mastodonScheduledId;
  if (platform === 'wordpress') return platforms.includes('wordpress') && !post.wordpressPostId;
  if (platform === 'ghost') return platforms.includes('ghost') && !post.ghostPostId;
  if (platform === 'meta') {
    return due <= now && ((platforms.includes('instagram') && !post.igMediaId)
      || (platforms.includes('facebook') && post.type === 'reel' && !post.fbReelId && !post.fbPostId));
  }
  if (platform === 'linkedin') return due <= now && platforms.includes('linkedin') && !post.liPostId;
  if (platform === 'x') return due <= now && platforms.includes('x') && !post.xPostId;
  if (platform === 'telegram') return due <= now && platforms.includes('telegram') && !post.tgMessageId;
  if (platform === 'discord') return due <= now && platforms.includes('discord') && !post.dcMessageId;
  if (platform === 'reddit') return due <= now && platforms.includes('reddit') && !post.redditPostId;
  if (platform === 'pinterest') return due <= now && platforms.includes('pinterest') && !post.pinId;
  if (platform === 'tiktok') return due <= now && platforms.includes('tiktok') && !post.tiktokVideoId;
  if (platform === 'nostr') return due <= now && platforms.includes('nostr') && !post.nostrEventId;
  if (platform === 'gbp') return due <= now && platforms.includes('gbp') && !post.gbpPostId;
  // Spec 34: bluesky fires ONLY a Radar reply-to-external post (post.radarReplyTo),
  // never a general publish - the SAME gate the real scheduler's lanesOwed applies.
  if (platform === 'bluesky') return due <= now && platforms.includes('bluesky') && Boolean(post.radarReplyTo) && !post.blueskyPostId;
  return false;
}

// Spec 21 (alt-text): whether THIS mock publish carries media to attach alt-text
// to, mirroring each live engine's own media check with no filesystem/network
// access - x keys off isTextPost (post.type==='text' has no media), wordpress off
// the local media file the sideload would upload, pinterest off the public pin
// image url every real pin requires. Unknown platforms default to true (no gate).
function hasMockMedia(platform, post) {
  // A poll is media-less on every lane (its alt rides uploadMedia, which polls skip),
  // so exclude it exactly like a text post - otherwise a poll carrying stray altText
  // would get a mock set-alt row the live engine never produces (mock/live drift).
  if (platform === 'x') return post.type !== 'text' && post.type !== 'poll';
  if (platform === 'wordpress') return Boolean(post.file || post.path);
  if (platform === 'pinterest') return Boolean(String(post.imageUrl || '').trim());
  return true;
}

// Spec 10 (native poll): a poll TYPE's publish row carries the assembled poll object
// (options + duration) so a mock-mode test can assert the driver "saw" the poll the
// live engine would attach, with no network. Empty object for a non-poll post, so a
// normal publish row is byte-identical to before. Rides AS A FIELD on the publish row
// (not a separate action), so convergence-to-posted is unaffected.
function pollEcho(post) {
  return post.type === 'poll' && post.poll && typeof post.poll === 'object'
    ? { poll: { options: Array.isArray(post.poll.options) ? [...post.poll.options] : [], durationMinutes: post.poll.durationMinutes ?? null, multiple: post.poll.multiple === true } }
    : {};
}

// Spec 05 (native carousel): a carousel TYPE's publish row carries the assembled child
// count (carousel:{items:N}) so a mock-mode test can assert the driver "saw" the N child
// containers / media_ids / image URNs the live engine would build, with no network. Empty
// object for a non-carousel post, so a normal publish row is byte-identical to before.
// Rides AS A FIELD on the publish row (not a separate action), so convergence-to-posted
// is unaffected.
function carouselEcho(post) {
  return isCarouselPost(post) ? { carousel: { items: carouselItems(post).length } } : {};
}

// Spec 16 (reddit link/image/native-video + flair): the SAME kind rule the live engine's
// cmdPublishDue uses (redditSubmitKind), inlined here to keep lib/ from importing a
// scripts/ engine. poll/carousel are handled by their own echoes/blocks, so they return
// null and attach NO reddit echo. A reddit-media-submit test asserts this mock kind
// matches the engine's exported redditSubmitKind, guarding drift.
function redditMockKind(post) {
  // E1: a carousel now has a real reddit submit path, so the mock names its kind like
  // every other one. A poll still returns null (pollEcho covers it).
  if (isCarouselPost(post)) return 'gallery';
  if (isPollPost(post)) return null;
  if (post.type === 'image') return 'image';
  if (post.type === 'video') return 'video';
  const u = post.redditUrl || post.externalUrl || post.url || post.link || '';
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? 'link' : 'self';
}
// A reddit image/video publish row echoes the KIND the live engine would submit + any
// flair the submit form would carry, so a mock-mode test asserts the driver "saw" them
// with no network. Empty for a poll/carousel (their own echoes cover them).
function redditEcho(post) {
  const kind = redditMockKind(post);
  if (!kind) return {};
  const echo = { kind };
  if (post.redditFlairId) echo.flair_id = post.redditFlairId;
  if (post.redditFlairText) echo.flair_text = post.redditFlairText;
  return { reddit: echo };
}
// Mirror the live engine's fail-closed degrade (spec §4): an image/video submission with
// no local render, or a video with no public poster (imageUrl), is a STRUCTURED ok:false
// skip - never a bare self/text fallback. Returns { errorCode, errorMessage } or null.
function redditMediaSkip(post) {
  const kind = redditMockKind(post);
  const hasMedia = Boolean(post.file || post.path);
  if (kind === 'image' && !hasMedia) return { errorCode: 'media_missing', errorMessage: 'reddit image submission needs a local media render' };
  if (kind === 'video') {
    if (!hasMedia) return { errorCode: 'media_missing', errorMessage: 'reddit video submission needs a local media render' };
    if (!String(post.imageUrl || '').trim()) return { errorCode: 'unsupported', errorMessage: 'reddit video submission needs a public cover image (imageUrl) as the poster' };
  }
  return null;
}

// Spec 34: a Radar reply-to-external post REPLIES to the signal thread instead of a
// normal publish. The mock mints the reply id (redditPostId/mastodonStatusId/blueskyPostId)
// + a { action:'publish', radarReply } echo, so the approve->publish loop fires it exactly
// like a real reply with NO network. A target externalId containing 'gone' simulates a 404
// thread => a structured radar_target_gone skip (mirrors handleReplyToReview's 'missing'
// convention), so the fail-closed target-gone path is testable offline. The reply targets
// ONE lane (its source); a call for any other lane no-ops (empty results).
const RADAR_REPLY_ID_FIELD = { reddit: 'redditPostId', mastodon: 'mastodonStatusId', bluesky: 'blueskyPostId', nostr: 'nostrEventId' };
function radarReplyLanes(platform, post) {
  const rr = post.radarReplyTo;
  const src = rr && rr.source;
  if (platform !== src) return []; // WRONG-TARGET guard: a reply targets exactly its source lane
  // EARLY-FIRE guard (safety review #4): a reply never posts before its scheduledAt, even on
  // a native-anytime lane (mastodon). Mirrors the live engines' dueMs>now skip so the mock
  // and live agree that a future-scheduled reply waits.
  const due = Date.parse(post.scheduledAt || '');
  if (!Number.isNaN(due) && due > Date.now()) return [];
  const idField = RADAR_REPLY_ID_FIELD[src];
  if (!idField || post[idField]) return []; // unknown source or already replied
  if (post.radarReplyState === 'target_gone') return []; // terminal - never re-attempt
  // R11/N2: thread UNDER the author's follow-up comment when captured (parentExternalId), else
  // the thread root - the EXACT selection the live reddit/mastodon/bluesky engines make, so the
  // mock (this test path) and live agree on what a reply targets.
  const ext = String(rr.parentExternalId || rr.externalId || '');
  if (/gone/i.test(ext)) {
    // TERMINAL target-gone (safety review #5): stamp radarReplyState so the REAL scheduler's
    // lanesOwed stops owing the lane -> the post never re-fires (mirrors the live engines).
    post.radarReplyState = 'target_gone';
    return [{ platform: src, action: 'publish', ok: false, errorCode: 'radar_target_gone', errorMessage: `mock: reply target ${ext} is no longer available` }];
  }
  post[idField] = mockId(`${src}reply`);
  // Mirror the LIVE engines that persist the reply's own public URL at publish
  // (mastodon: the status-create response url; nostr: the njump permalink) - mock/
  // live parity so the Radar card's "Beantwortet" links an answer in mock walks too.
  if (src === 'mastodon' || src === 'nostr') post.externalUrl = `https://mock.social/${src}/${post[idField]}`;
  post.status = 'posted';
  post.postedAt = new Date().toISOString();
  return [{ platform: src, action: 'publish', ok: true, id: post[idField], radarReply: ext }];
}

function publishLanes(platform, post, plan = null) {
  const platforms = post.platforms || [];
  const results = [];
  // Spec 34: a Radar reply-to-external post short-circuits the normal publish - it
  // replies to the external thread (or degrades to radar_target_gone). Handled BEFORE
  // any poll/carousel/type gate since a reply carries none of those.
  if (post.radarReplyTo) return radarReplyLanes(platform, post);
  // Spec 10: a poll that can't be built (under-options / out-of-range duration /
  // over-long question) yields the SAME structured invalid_poll row the live engines
  // push (their fail-closed backstop), instead of a silent publish - so mock and live
  // agree on the blocked-poll path. Poll-capable single-lane engines only; the question
  // is the caption (mock has no per-lane caption override).
  const pollLimits = POLL_LANE_LIMITS[platform];
  if (isPollPost(post) && pollLimits && platforms.includes(platform) && platformPending(post, platform)) {
    const reason = pollBlocker(post, (post.caption || '').trim(), pollLimits);
    if (reason) return [{ platform, action: 'publish', ok: false, errorCode: 'invalid_poll', errorMessage: reason }];
  }
  // Spec 05: a carousel that can't be assembled (under 2 items / over the lane cap /
  // an image+video mix on X / a malformed slide) yields the SAME structured
  // invalid_carousel row the live engines push (their fail-closed backstop), instead of
  // a silent publish - so mock and live agree on the blocked-carousel path. The meta
  // engine id maps to the instagram publish lane; the single-lane engines key on their
  // own id. platformPending guards a re-run from re-blocking an already-published lane.
  if (isCarouselPost(post)) {
    const lane = platform === 'meta' ? 'instagram' : platform;
    const carLimits = CAROUSEL_LANE_LIMITS[lane];
    if (carLimits && platforms.includes(lane) && platformPending(post, lane)) {
      const reason = carouselBlocker(post, lane);
      if (reason) return [{ platform: lane, action: 'publish', ok: false, errorCode: 'invalid_carousel', errorMessage: reason }];
      // Spec 05 review (mock<->live coherence): a well-formed carousel whose lane has no
      // LOCAL assembly seam degrades to the SAME structured `unsupported` row the live
      // engines push (IG-with-any-image / pinterest / reddit) - never a false ok:true. This
      // is why the mock previously masked the IG-image validator gap (the tests saw ok:true).
      const unsupported = carouselUnsupported(post, lane, getPosting());
      if (unsupported) return [{ platform: lane, action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: unsupported }];
    }
  }
  if (platform === 'meta') {
    // Spec 39 §4e: mock and live must AGREE on the IG feed-image path (this exact
    // branch used to publish ok:true while the live engine silently skipped -
    // defect 2). An effective public URL publishes; none yields the SAME
    // structured `unsupported` row the live engine pushes (the redditMediaSkip
    // pattern), keyed through the shared lib/public-media.mjs resolver.
    if (platforms.includes('instagram') && !post.igMediaId && post.type === 'image' && !effectivePublicUrl(post, getPosting())) {
      // Stays attempt-less (live parity: the engine's no-URL path is a bare RUN row).
      results.push({ platform: 'instagram', action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: 'instagram feed image needs a public image URL (set imageUrl, or set a public media host in Settings)' });
    } else if (platforms.includes('instagram') && !post.igMediaId) {
      // Live parity: the engine records EVERY real publish attempt via recordAttempt
      // (lib/publish-hold.mjs), which is also what stamps/clears the publishHold cap -
      // so a mock-driven test exercises the exact hold semantics.
      const igAction = post.type === 'image' ? 'publish-image' : 'publish';
      const fail = mockFailFor('instagram');
      if (fail) {
        recordAttempt(post, { ts: new Date().toISOString(), platform: 'instagram', action: igAction, ok: false, errorCode: fail.code, errorMessage: fail.message, lateMin: 0, actor: 'mock' });
        results.push({ platform: 'instagram', action: igAction, ok: false, errorCode: fail.code, errorMessage: fail.message });
      } else {
        post.igMediaId = mockId('ig');
        recordAttempt(post, { ts: new Date().toISOString(), platform: 'instagram', action: igAction, ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: 'mock' });
        results.push({ platform: 'instagram', action: igAction, ok: true, ...carouselEcho(post) });
      }
    }
    if (platforms.includes('facebook') && post.type === 'reel' && !post.fbReelId && !post.fbPostId) { post.fbReelId = mockId('fb'); results.push({ platform: 'facebook', action: 'publish', ok: true }); }
  } else if (platform === 'linkedin') {
    if (platforms.includes('linkedin') && !post.liPostId) {
      post.liPostId = mockShareUrn();
      results.push({ platform: 'linkedin', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post) });
      // Spec 11: mirrors the live engine's post-publish first-comment call
      // (scripts/linkedin-social.mjs postComment), captured here (no network) so
      // a test can assert the comment rode the publish + stamped liCommentId.
      if (post.firstComment) {
        post.liCommentId = mockId('licomment');
        results.push({ platform: 'linkedin', action: 'post-comment', ok: true, id: post.liCommentId });
      }
    }
  } else if (platform === 'x') {
    if (platforms.includes('x') && !post.xPostId) {
      // Mirror the real engine's fail-closed reply-chain contract (scripts/
      // x-social.mjs cmdPublishDue): a reply publishes only once its parent has a
      // minted id. An unpublished parent DEFERS (parent_unpublished, retryable);
      // a dangling reference is terminal (parent_missing). Mock-mode tests and
      // demos therefore exercise the exact thread semantics of the live lane.
      const parent = post.xReplyTo && plan ? (plan.posts || []).find((p) => p.id === post.xReplyTo) : null;
      if (post.xReplyTo && plan && !parent) {
        results.push({ platform: 'x', action: 'publish', ok: false, errorCode: 'parent_missing', errorMessage: `xReplyTo "${post.xReplyTo}" names no post in this plan` });
      } else if (parent && !parent.xPostId) {
        results.push({ platform: 'x', action: 'publish', ok: false, errorCode: 'parent_unpublished', errorMessage: `waiting for parent "${post.xReplyTo}" to publish before threading`, deferred: true });
      } else {
        post.xPostId = mockId('x');
        results.push({ platform: 'x', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post) });
        // Spec 21: mirrors the live engine's post-FINALIZE alt-text call, captured
        // here (no network) so a test can assert the alt param rode the publish.
        if (post.altText && hasMockMedia('x', post)) results.push({ platform: 'x', action: 'set-alt', ok: true, altText: post.altText });
      }
    }
  } else if (platform === 'telegram') {
    if (platforms.includes('telegram') && !post.tgMessageId) { post.tgMessageId = mockId('tg'); results.push({ platform: 'telegram', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post) }); }
  } else if (platform === 'discord') {
    if (platforms.includes('discord') && !post.dcMessageId) { post.dcMessageId = mockId('dc'); results.push({ platform: 'discord', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post) }); }
  } else if (platform === 'reddit') {
    if (platforms.includes('reddit') && !post.redditPostId) {
      // Spec 16: an image/video with no bytes (or a video with no poster) degrades to a
      // structured ok:false skip, mirroring the live engine - never a text fallback.
      const skip = redditMediaSkip(post);
      if (skip) {
        results.push({ platform: 'reddit', action: 'publish', ok: false, ...skip });
      } else {
        post.redditPostId = mockId('rd');
        results.push({ platform: 'reddit', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post), ...redditEcho(post) });
      }
    }
  } else if (platform === 'pinterest') {
    if (platforms.includes('pinterest') && !post.pinId) {
      // Spec 17: the branch decision is post.type==='video' ALONE (mirrors the live
      // engine exactly - it never falls back to an image pin once a post is
      // type=video). A video pin needs a local render (post.file/path) AND the
      // public imageUrl as its REQUIRED cover; either missing is a structured
      // ok:false skip (never a silent image fallback). A media:write-absent token
      // (PENDPOST_MOCK_UNGRANTED=pinterest, the SAME convention every other lane's
      // P9 mock degrade uses) degrades to the exact needs_scope shape the live
      // 403 produces, with no network.
      // Order mirrors the live engine exactly: render presence, then the cover
      // (both pre-upload gates, no network yet), THEN the media:write scope (only
      // reachable once an upload is actually attempted).
      const isVideoPin = post.type === 'video';
      if (isVideoPin) {
        if (!(post.file || post.path)) {
          results.push({ platform: 'pinterest', action: 'publish', ok: false, errorCode: 'media_missing', errorMessage: 'pinterest video pin needs a local video render (post.path/file) to upload' });
        } else if (!String(post.imageUrl || '').trim()) {
          results.push({ platform: 'pinterest', action: 'publish', ok: false, errorCode: 'unsupported', errorMessage: 'pinterest video pin needs a public cover image (imageUrl) as cover_image_url' });
        } else if (mockUngranted('pinterest')) {
          results.push({ platform: 'pinterest', action: 'publish', ok: false, error: 'needs_scope', scope: 'media:write' });
        } else {
          post.pinId = mockId('pin');
          results.push({
            platform: 'pinterest', action: 'publish', ok: true,
            media: { sourceType: 'video_id' },
            ...(post.pinBoardSection ? { boardSectionId: post.pinBoardSection } : {}),
          });
          if (post.altText) results.push({ platform: 'pinterest', action: 'set-alt', ok: true, altText: post.altText });
        }
      } else {
        post.pinId = mockId('pin');
        results.push({
          platform: 'pinterest', action: 'publish', ok: true, ...carouselEcho(post),
          ...(post.pinBoardSection ? { boardSectionId: post.pinBoardSection } : {}),
        });
        // Spec 21: mirrors the live create-pin body's alt_text (needs the public
        // image url every real pin requires), captured for test assertion.
        if (post.altText && hasMockMedia('pinterest', post)) results.push({ platform: 'pinterest', action: 'set-alt', ok: true, altText: post.altText });
      }
    }
  } else if (platform === 'tiktok') {
    if (platforms.includes('tiktok') && !post.tiktokVideoId) {
      post.tiktokVideoId = mockId('tt');
      // Spec 27: draft/pending-review handoff - the video would land in the
      // creator's TikTok inbox instead of publishing direct; captured as a flag
      // on the same publish row (no separate action, no network).
      results.push({ platform: 'tiktok', action: 'publish', ok: true, ...(post.publishAsDraft === true ? { draft: true } : {}) });
    }
  } else if (platform === 'mastodon') {
    // Native lane: ahead of due it hands off to the (mock) instance queue; past
    // due it publishes immediately - the exact real-engine `schedule` split.
    if (platforms.includes('mastodon') && !post.mastodonStatusId && !post.mastodonScheduledId) {
      if (Date.parse(post.scheduledAt || '') > Date.now()) {
        post.mastodonScheduledId = mockId('mastosched');
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'mastodon', action: 'schedule-native', ok: true, ...pollEcho(post), ...carouselEcho(post) });
      } else {
        post.mastodonStatusId = mockId('masto');
        results.push({ platform: 'mastodon', action: 'publish', ok: true, ...pollEcho(post), ...carouselEcho(post) });
      }
    }
  } else if (platform === 'wordpress') {
    if (platforms.includes('wordpress') && !post.wordpressPostId) {
      post.wordpressPostId = mockId('wp');
      // Spec 27: a draft handoff always falls back to the immediate draft-create
      // path (mirrors the live engine's cmdSchedule) - a draft has no scheduled
      // fire, so it never takes the schedule-native branch below.
      const draftHandoff = post.publishAsDraft === true;
      if (!draftHandoff && Date.parse(post.scheduledAt || '') > Date.now()) {
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'wordpress', action: 'schedule-native', ok: true });
      } else {
        results.push({ platform: 'wordpress', action: 'publish', ok: true, ...(draftHandoff ? { draft: true } : {}) });
      }
      // Spec 21: mirrors the live engine's follow-up attachment alt_text/caption
      // update (buildPayload), captured for test assertion. Fires on either branch
      // above - the real update rides the shared content-assembly step.
      if (post.altText && hasMockMedia('wordpress', post)) results.push({ platform: 'wordpress', action: 'set-alt', ok: true, altText: post.altText });
      // Spec 13: mirrors the live engine's category resolution + SEO meta
      // (embedded in the create body) + the feature-image-alt follow-up (only
      // meaningful alongside a feature image, like altText above) - captured as
      // one row so a mock-mode test can assert the fields rode the publish.
      const wpFeatureAlt = post.featureImageAlt && hasMockMedia('wordpress', post) ? post.featureImageAlt : null;
      if (post.metaTitle || post.metaDescription || post.wpCategories || wpFeatureAlt) {
        results.push({
          platform: 'wordpress', action: 'set-seo', ok: true,
          metaTitle: post.metaTitle || null, metaDescription: post.metaDescription || null,
          wpCategories: post.wpCategories || null, featureImageAlt: wpFeatureAlt,
        });
      }
    }
  } else if (platform === 'ghost') {
    if (platforms.includes('ghost') && !post.ghostPostId) {
      post.ghostPostId = mockId('ghost');
      if (Date.parse(post.scheduledAt || '') > Date.now()) {
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'ghost', action: 'schedule-native', ok: true });
      } else {
        results.push({ platform: 'ghost', action: 'publish', ok: true });
      }
      // Spec 13: Ghost's SEO fields are native post fields (no attachment
      // round-trip) - captured whenever present, regardless of a feature image.
      if (post.metaTitle || post.metaDescription || post.featureImageAlt) {
        results.push({
          platform: 'ghost', action: 'set-seo', ok: true,
          metaTitle: post.metaTitle || null, metaDescription: post.metaDescription || null,
          featureImageAlt: post.featureImageAlt || null,
        });
      }
    }
  } else if (platform === 'nostr') {
    if (platforms.includes('nostr') && !post.nostrEventId) { post.nostrEventId = mockId('nostr'); results.push({ platform: 'nostr', action: 'publish', ok: true, ...pollEcho(post) }); }
  } else if (platform === 'gbp') {
    if (platforms.includes('gbp') && !post.gbpPostId) { post.gbpPostId = mockId('gbp'); results.push({ platform: 'gbp', action: 'publish', ok: true }); }
  } else if (platform === 'youtube') {
    if (platforms.includes('youtube') && !post.ytVideoId) {
      post.ytVideoId = mockYtId();
      if (post.status !== 'posted') post.status = 'scheduled'; // native publishAt
      results.push({ platform: 'youtube', action: 'schedule', ok: true });
    }
  }
  // Convergence: a publish-NOW result marks the post posted once every targeted
  // platform carries publish evidence (a native hand-off - youtube publishAt,
  // mastodon/wordpress/ghost schedule-native - stays 'scheduled', never posted).
  // A 'set-alt' (spec 21), 'set-seo' (spec 13) or 'post-comment' (spec 11) row
  // rides ALONGSIDE its 'publish' row on the SAME mock call, so convergence keys
  // off "every row is a publish or one of its companion rows" rather than "every
  // row is exactly publish" - otherwise an alt-texted/SEO-metadata'd/first-
  // commented post would never converge to 'posted'.
  const publishedNow = results.some((r) => r.action === 'publish');
  if (publishedNow && results.every((r) => r.action === 'publish' || r.action === 'set-alt' || r.action === 'post-comment' || r.action === 'set-seo')) {
    const pending = platforms.filter((p) => platformPending(post, p));
    if (!pending.length) { post.status = 'posted'; post.postedAt = new Date().toISOString(); }
  }
  return results;
}

function appendLedger(entries) {
  if (!entries.length) return;
  const file = path.join(DATA_ROOT, '.mock-ledger.json');
  let log = [];
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) log = parsed; } catch { /* fresh */ }
  log.push(...entries);
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); atomicWriteJson(file, log.slice(-500)); } catch { /* ledger is best-effort */ }
}

// ---- command handlers ------------------------------------------------------

function handlePublish(platform, planPath, only) {
  const plan = loadPlan(planPath);
  // --only narrows WHICH post to look at; it must never REPLACE the eligible()
  // approval/due/status fence (that was the mock-only bypass an approval-gate test
  // could silently pass through - the real scheduler always enforces eligible()
  // regardless of --only, so the mock must too, for test fidelity).
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true) && eligible(platform, p));
  const results = [];
  const ledger = [];
  const now = new Date().toISOString();
  for (const post of posts) {
    for (const r of publishLanes(platform, post, plan)) {
      results.push({ postId: post.id, ...r });
      ledger.push({ ts: now, mode: 'mock', campaign: plan.campaign || null, postId: post.id, platform: r.platform, action: r.action });
      // Live parity: every live engine records its publish/schedule attempt via
      // recordAttempt (which also maintains publishHold). Instagram already
      // records inline in publishLanes (it has the mockFailFor failure seam);
      // every other lane's fake publish records here, with the SAME action name
      // the live engine uses (youtube's ahead-of-due handoff is recorded as
      // 'schedule-native' by scripts/yt-social.mjs cmdSchedule).
      if (r.platform !== 'instagram' && r.ok === true
        && (r.action === 'publish' || r.action === 'schedule' || r.action === 'schedule-native')) {
        const action = r.platform === 'youtube' && r.action === 'schedule' ? 'schedule-native' : r.action;
        recordAttempt(post, { ts: now, platform: r.platform, action, ok: true, errorCode: null, errorMessage: null, lateMin: 0, actor: 'mock' });
      }
    }
  }
  if (results.length) savePlan(planPath, plan);
  appendLedger(ledger);
  return { ok: true, results };
}

function handleInsights(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  // Spec 08: telegram is account-scoped (subscriber count), not per-post - ONE
  // row for the whole call, mirroring the real getChatMemberCount engine verb
  // (which never iterates posts either). Emitted only when at least one
  // telegram post has evidence, matching the sweep's evidence-gated spawn.
  if (platform === 'telegram' && posts.some((p) => p.tgMessageId)) {
    results.push({ postId: null, platform: 'telegram', action: 'insights', ok: true, scope: 'account', metrics: { subscribers: telegramSubscribers() } });
  }
  for (const post of posts) {
    if (platform === 'meta') {
      if (post.igMediaId) results.push({ postId: post.id, platform: 'instagram', action: 'insights', ok: true, metrics: metricsFor('instagram', post.id) });
      if (post.fbReelId || post.fbPostId) results.push({ postId: post.id, platform: 'facebook', action: 'insights', ok: true, metrics: metricsFor('facebook', post.id) });
    } else if (platform === 'linkedin') {
      if (post.liPostId) results.push({ postId: post.id, platform: 'linkedin', action: 'insights', ok: true, metrics: metricsFor('linkedin', post.id) });
    } else if (platform === 'x') {
      if (post.xPostId) results.push({ postId: post.id, platform: 'x', action: 'insights', ok: true, metrics: metricsFor('x', post.id) });
    } else if (platform === 'discord') {
      if (post.dcMessageId) results.push({ postId: post.id, platform: 'discord', action: 'insights', ok: true, metrics: metricsFor('discord', post.id) });
    } else if (platform === 'reddit') {
      if (post.redditPostId) results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: metricsFor('reddit', post.id) });
    } else if (platform === 'pinterest') {
      if (post.pinId) results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: true, metrics: metricsFor('pinterest', post.id) });
    } else if (platform === 'tiktok') {
      if (post.tiktokVideoId) results.push({ postId: post.id, platform: 'tiktok', action: 'insights', ok: true, metrics: metricsFor('tiktok', post.id) });
    } else if (platform === 'mastodon') {
      if (post.mastodonStatusId) results.push({ postId: post.id, platform: 'mastodon', action: 'insights', ok: true, metrics: metricsFor('mastodon', post.id) });
    } else if (platform === 'wordpress') {
      if (post.wordpressPostId) results.push({ postId: post.id, platform: 'wordpress', action: 'insights', ok: true, metrics: metricsFor('wordpress', post.id) });
    } else if (platform === 'ghost') {
      if (post.ghostPostId) results.push({ postId: post.id, platform: 'ghost', action: 'insights', ok: true, metrics: metricsFor('ghost', post.id) });
    } else if (platform === 'nostr') {
      if (post.nostrEventId) results.push({ postId: post.id, platform: 'nostr', action: 'insights', ok: true, metrics: metricsFor('nostr', post.id) });
    } else if (platform === 'gbp') {
      if (post.gbpPostId) results.push({ postId: post.id, platform: 'gbp', action: 'insights', ok: true, metrics: metricsFor('gbp', post.id) });
    } else if (platform === 'youtube') {
      if (post.ytVideoId) {
        // Spec 08: watch-time is a SEPARATE, yt-analytics.readonly-gated call in
        // the real engine - PENDPOST_MOCK_UNGRANTED=youtube mirrors that degrade
        // (base statistics still present, the two extra fields simply absent).
        const metrics = metricsFor('youtube', post.id);
        if (!mockUngranted('youtube')) Object.assign(metrics, ytWatchTimeFor(post.id));
        results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: true, metrics });
      }
    }
  }
  return { ok: true, results };
}

// Mock release (make-live recovery): a mock post with a fabricated native id
// flips live with no network. Mirrors the engine `release` envelope shape for
// every native lane that has one (youtube / wordpress / ghost).
function handleRelease(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  const releasable = {
    youtube: { id: (p) => p.ytVideoId, state: 'public', permalink: (p) => `https://youtu.be/${p.ytVideoId}` },
    wordpress: { id: (p) => p.wordpressPostId, state: 'published', permalink: (p) => `https://mock.blog/?p=${p.wordpressPostId}` },
    ghost: { id: (p) => p.ghostPostId, state: 'published', permalink: (p) => `https://mock.site/${p.ghostPostId}/` },
  };
  const lane = releasable[platform];
  for (const post of posts) {
    if (!lane || !(post.platforms || []).includes(platform) || !lane.id(post)) continue;
    results.push({ postId: post.id, platform, action: 'release', ok: true, id: lane.id(post), live: true, state: lane.state, permalink: lane.permalink(post) });
  }
  return { ok: true, results };
}

// Mock resolve (the mastodon post-fire reconcile): a scheduled queue entry past
// its due minute resolves to a fabricated live status id + posted, exactly the
// terminal state the real engine reaches. Before due it stays queued (skip).
function handleResolve(platform, planPath, only) {
  if (platform !== 'mastodon') return { ok: true, results: [] };
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  for (const post of posts) {
    if (!(post.platforms || []).includes('mastodon') || !post.mastodonScheduledId || post.mastodonStatusId) continue;
    if (Date.parse(post.scheduledAt || '') > Date.now()) continue; // still queued
    post.mastodonStatusId = mockId('masto');
    post.status = 'posted';
    post.postedAt = new Date().toISOString();
    results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: true, id: post.mastodonStatusId, permalink: `https://mock.instance/@mockuser/${post.mastodonStatusId}` });
  }
  if (results.length) savePlan(planPath, plan);
  return { ok: true, results };
}

// The verify-failure seam (the PENDPOST_MOCK_FAIL idiom): PENDPOST_MOCK_VERIFY_FAIL
// lists lanes whose mock READ-BACK must report a terminal not-live state, as
// `platform[:state]` comma entries (state defaults to 'missing'). Lets a test drive
// the real verifySweep -> engine -> bounded-recheck path (lib/verify.mjs) with no
// live API - the same convention PENDPOST_MOCK_FAIL uses for the publish path.
function mockVerifyFailFor(platform) {
  for (const raw of String(process.env.PENDPOST_MOCK_VERIFY_FAIL || '').split(',')) {
    const [p, state] = raw.trim().split(':');
    if (p && p.toLowerCase() === String(platform).toLowerCase()) return { state: state || 'missing' };
  }
  return null;
}

// Mock read-back: a post that already carries a fabricated id reads as LIVE,
// so the full mock loop (publish -> verify) lands a verified-live post with no
// network. Mirrors the engine `verify` envelope shape exactly.
function handleVerify(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  const liveState = { instagram: 'published', facebook: 'published', youtube: 'public', linkedin: 'published', x: 'published', telegram: 'sent', discord: 'posted', reddit: 'posted', pinterest: 'published', tiktok: 'published', mastodon: 'published', wordpress: 'published', ghost: 'published', nostr: 'published', gbp: 'live' };
  const permalinkFor = (p, post) => {
    if (p === 'youtube') return `https://youtu.be/${post.ytVideoId}`;
    if (p === 'linkedin') return `https://www.linkedin.com/feed/update/${post.liPostId}`;
    if (p === 'x') return `https://x.com/i/web/status/${post.xPostId}`;
    if (p === 'telegram') return `https://t.me/mockchannel/${post.tgMessageId}`;
    if (p === 'discord') return `https://discord.com/channels/mock/mock/${post.dcMessageId}`;
    if (p === 'reddit') return `https://www.reddit.com/comments/${post.redditPostId}/`;
    if (p === 'pinterest') return `https://www.pinterest.com/pin/${post.pinId}/`;
    if (p === 'tiktok') return `https://www.tiktok.com/@mockcreator/video/${post.tiktokVideoId}`;
    if (p === 'mastodon') return `https://mock.instance/@mockuser/${post.mastodonStatusId}`;
    if (p === 'wordpress') return `https://mock.blog/?p=${post.wordpressPostId}`;
    if (p === 'ghost') return `https://mock.site/${post.ghostPostId}/`;
    if (p === 'nostr') return `https://njump.me/${post.nostrEventId}`;
    if (p === 'gbp') return `https://local.google.com/mock/${post.gbpPostId}`;
    return `https://example.invalid/mock/${p}/${post.id}`;
  };
  for (const post of posts) {
    const targeted = post.platforms || [];
    const has = { instagram: post.igMediaId, facebook: post.fbReelId || post.fbPostId, youtube: post.ytVideoId, linkedin: post.liPostId, x: post.xPostId, telegram: post.tgMessageId, discord: post.dcMessageId, reddit: post.redditPostId, pinterest: post.pinId, tiktok: post.tiktokVideoId, mastodon: post.mastodonStatusId, wordpress: post.wordpressPostId, ghost: post.ghostPostId, nostr: post.nostrEventId, gbp: post.gbpPostId };
    const row = (p) => {
      const fail = mockVerifyFailFor(p);
      return fail
        ? { postId: post.id, platform: p, action: 'verify', ok: true, live: false, state: fail.state, permalink: null }
        : { postId: post.id, platform: p, action: 'verify', ok: true, live: true, state: liveState[p], permalink: permalinkFor(p, post) };
    };
    if (platform === 'meta') {
      for (const p of ['instagram', 'facebook']) {
        if (targeted.includes(p) && has[p]) results.push(row(p));
      }
    } else if (targeted.includes(platform) && has[platform]) {
      results.push(row(platform));
    }
  }
  return { ok: true, results };
}

// The inbound-engagement seam (spec 02, Pattern P6). Mock `comments` fabricates a
// small canned thread in the canonical normalized shape ({ commentId, author, text,
// ts, postId, kind }); mock `reply` acknowledges with a fabricated id. Both DEGRADE
// like the live path: when PENDPOST_MOCK_UNGRANTED lists this platform they return
// the exact { ok:false, error:'needs_scope', scope } the engine emits without a
// granted OAuth tier - so a test exercises the P9 shape with no live API.
function mockUngranted(platform) {
  return String(process.env.PENDPOST_MOCK_UNGRANTED || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(String(platform).toLowerCase());
}

// The publish-failure seam (the PENDPOST_MOCK_UNGRANTED idiom): PENDPOST_MOCK_FAIL
// lists lanes whose mock publish must FAIL, as `platform[:code[:message]]` comma
// entries - e.g. 'instagram:9004:Only photo or video can be accepted as media type.'.
// Lets a test drive the real scheduler -> engine -> recordAttempt path into the
// publish-hold cap (lib/publish-hold.mjs) with no live API. A numeric-looking code is
// coerced to Number to match the live engines' err.fbCode shape.
function mockFailFor(platform) {
  for (const raw of String(process.env.PENDPOST_MOCK_FAIL || '').split(',')) {
    const [p, code, ...rest] = raw.trim().split(':');
    if (!p || p.toLowerCase() !== String(platform).toLowerCase()) continue;
    const c = (code || 'engine_failure').trim();
    return {
      code: /^\d+$/.test(c) ? Number(c) : c,
      message: rest.join(':').trim() || `mock ${platform} publish failure`,
    };
  }
  return null;
}
function handleComments(platform, only) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: `mock:${platform}:comments`, platform, results: [] };
  }
  const postId = only || 'mock-post';
  // R12 (BU-9): STABLE per (platform, postId) ids + timestamps, exactly as a real platform
  // returns the SAME comment id across reads. A per-read random id (the old `mock_c_${uniq()}`)
  // made every panel re-open look like a NEW comment, so the relationship-memory store accreted
  // a fresh 'they' exchange each time and the "Nth exchange" chip inflated (a read + a reply
  // read as "4th"). With a stable ref the read dedupes across re-opens and a read + a reply on
  // one comment accretes to exactly exchangeCount 2 -> the chip reads "2nd exchange".
  const slug = String(postId).replace(/[^A-Za-z0-9]/g, '');
  const items = [
    { kind: 'comment', commentId: `mock_c_${platform}_${slug}_1`, author: 'mock_reader', text: `Great ${platform} post!`, ts: '2026-01-02T09:00:00.000Z', postId },
    { kind: 'comment', commentId: `mock_c_${platform}_${slug}_2`, author: 'another_fan', text: 'Where can I learn more?', ts: '2026-01-02T09:05:00.000Z', postId },
  ];
  return { ok: true, items, platform, postId, results: [] };
}
function handleReply(platform, only) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: `mock:${platform}:reply`, platform, results: [] };
  }
  const id = mockId('reply');
  // The row carries the documented { postId, platform, action, ok, id } shape so
  // mock matches the live engine (spec §C / P3). postId = the pendpost post id from
  // --only, or a stable placeholder for a CLI reply with no post context.
  const postId = only || 'mock-post';
  return { ok: true, id, platform, results: [{ postId, platform, action: 'reply', ok: true, id }] };
}

// The Radar (beta) listening seam (spec 32, Pattern P3/P9). Mock `radar` fabricates a
// small, STABLE, identity-free list of UNSCORED Signals (the lib face lib/radar.mjs
// scores + dedupes them) so the scorer + seam + Radar panel run credential-free and
// the beta panel renders offline BEFORE spec 33's live search engines exist. The
// externalIds are STABLE per source (not per-call random, like handleReviews) so a
// repeat scan dedupes to the SAME feed by source+externalId. It DEGRADES like the live
// 403/no-BYO-app path (P9): PENDPOST_MOCK_UNGRANTED=<source> returns the exact
// { ok:false, error:'needs_scope', scope } the engine emits with no search app connected.
// The canned texts deliberately span the intent range (a buying question, a competitor
// comparison, plain chatter) so a mock-mode ranking is visibly non-trivial. NO real
// usernames / handles / links - every author + url is a synthetic mock token.
const MOCK_RADAR_SCOPE = { reddit: 'reddit_oauth', mastodon: 'read:search', bluesky: 'bluesky_app_password', hackernews: null };
function handleRadar(platform, query) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: MOCK_RADAR_SCOPE[platform] || `mock:${platform}:search`, platform, results: [] };
  }
  let q = {};
  try { q = query && typeof query === 'string' ? JSON.parse(query) : (query && typeof query === 'object' ? query : {}); } catch { q = {}; }
  const competitor = Array.isArray(q.competitors) && q.competitors.length ? String(q.competitors[0]) : 'Buffer';
  const now = Date.now();
  const iso = (min) => new Date(now - min * 60000).toISOString();
  const community = platform === 'reddit' ? 'r/socialmedia' : (platform === 'mastodon' ? 'mastodon.social' : (platform === 'bluesky' ? 'bsky.app' : 'news.ycombinator.com'));
  // Stable ids keyed on the source so a repeat scan maps to the same signals (dedupe).
  const items = [
    { externalId: `mock-${platform}-1`, url: `https://mock.${platform}/1`, author: `mock_user_1`, community, ts: iso(45), text: `What tool should I use to schedule social posts across platforms? Looking for a tool that just works.` },
    { externalId: `mock-${platform}-2`, url: `https://mock.${platform}/2`, author: `mock_user_2`, community, ts: iso(240), text: `Is ${competitor} worth it, or is there a better alternative to ${competitor} for a small team?` },
    { externalId: `mock-${platform}-3`, url: `https://mock.${platform}/3`, author: `mock_user_3`, community, ts: iso(1200), text: `Just shipped a new feature today, feeling good about it.` },
  ];
  return { ok: true, platform, items, results: [{ platform, action: 'radar', ok: true, items }] };
}

// Spec 44 (READ-only, mock parity): the author-reply read-back. For each posted radar reply
// on this lane whose check is due, a target externalId marked 'replied' fabricates the
// author's response (deterministic, mirrors the 'gone' -> target_gone convention); every
// other reply just gets its lastCheckedTs stamped. Mutates + persists the plan exactly like
// the live verb, so a reconcile mock run is the same spawn+persist path as live. Never posts.
function handleRadarFollowup(platform, planPath, only) {
  if (!planPath) return { ok: true, platform, results: [] };
  const plan = loadPlan(planPath);
  const results = [];
  const now = new Date().toISOString();
  const touched = [];
  for (const post of plan.posts || []) {
    if (only && post.id !== only) continue;
    const rr = post.radarReplyTo;
    if (!rr || rr.source !== platform || !needsFollowupCheck(post)) continue;
    const replied = /replied/i.test(String(rr.externalId || ''));
    const hit = replied ? {
      replied: true,
      author: rr.author || 'buyer',
      text: `mock: thanks, that answered my question about ${rr.community || 'this'}`,
      permalink: `${rr.url || `https://mock.${platform}/thread`}#author-reply`,
      ts: now,
      // R11/N2 parity: the live parsers return the author reply's native id (the round-2
      // target); the mock fabricates a deterministic, charset-valid one so the whole
      // reply-to-the-reply loop is exercisable offline.
      commentId: `${platform}:authorreply:${String(rr.externalId || '').replace(/[^A-Za-z0-9]/g, '')}`,
    } : null;
    stampFollowup(post, hit, now);
    touched.push(post.id);
    results.push({ postId: post.id, platform, action: 'radar-followup', ok: true, authorReplied: Boolean(hit) });
  }
  if (touched.length) savePlan(planPath, plan);
  return { ok: true, platform, results };
}

// Nostr zaps (spec 20, Pattern P3, MONEY path). Mock `zap` NEVER touches a relay or a
// wallet: it returns a synthetic preimage so the full send flow (PostDetail modal ->
// send_zap -> engine) runs credential-free in tests + the demo, with ZERO real sats
// spent. It degrades to not_configured (scope nwc) when no NWC wallet is connected -
// the SAME structured shape the live cmdZap returns before any network call (P9). The
// row carries { action:'zap', id:'mock-preimage', metrics:{sats} } so the lib/UI face
// reads it exactly like the live envelope.
function handleZap(platform, only, amount, nwcConfigured) {
  if (!nwcConfigured) {
    return { ok: false, error: 'not_configured', scope: 'nwc', platform, results: [] };
  }
  const sats = Number.isInteger(amount) && amount > 0 ? amount : 0;
  const postId = only || 'mock-post';
  return { ok: true, platform, results: [{ postId, platform, action: 'zap', ok: true, id: 'mock-preimage', metrics: { sats } }] };
}

// GBP reviews (spec 03, Pattern P6 engagement). Mock `reviews` fabricates 2-3 canned
// reviews in the P6 inbound shape (varied rating, ONE already replied) so the read->
// reply loop runs credential-free; mock `reply-to-review` acknowledges with the review
// id. Both DEGRADE like the live 403 path (P9): PENDPOST_MOCK_UNGRANTED=gbp returns the
// exact { ok:false, error:'needs_scope', scope:'business.manage' } the engine emits with
// no allowlisted project. reply-to-review also mirrors the live input degrades so the
// tests can drive them offline: over-length text -> invalid_input; a review id carrying
// 'missing' -> review_missing (the 404 branch).
function handleReviews(platform) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const now = Date.now();
  const iso = (min) => new Date(now - min * 60000).toISOString();
  // STABLE review resource names (not per-call random) so the read is deterministic and
  // the seen-id dedup in listReviews works across reads (mirrors handlePerformance's
  // seeded fixtures). The base is a constant so a repeat read maps to the same ids.
  const base = 'accounts/1/locations/2/reviews';
  const items = [
    { commentId: `${base}/rev-1`, kind: 'review', author: 'Alex M.', text: 'Fantastic service, highly recommend!', ts: iso(30), rating: 5, reply: null, replyTs: null, platform, postId: null, permalink: null },
    { commentId: `${base}/rev-2`, kind: 'review', author: 'Jordan P.', text: 'Good, but the wait was a little long.', ts: iso(180), rating: 3, reply: 'Thanks for the feedback - we are working on it!', replyTs: iso(120), platform, postId: null, permalink: null },
    { commentId: `${base}/rev-3`, kind: 'review', author: 'Sam K.', text: '', ts: iso(1440), rating: 4, reply: null, replyTs: null, platform, postId: null, permalink: null },
  ];
  return { ok: true, platform, results: [{ platform, action: 'reviews', ok: true, items, averageRating: 4.0, totalReviewCount: items.length }] };
}
function handleReplyToReview(platform, reviewId, text, remove) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const id = (reviewId && String(reviewId).trim()) || 'accounts/1/locations/2/reviews/mock';
  const del = remove === true || !String(text || '').trim();
  if (!del && String(text).length > 4096) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  if (/missing/i.test(id)) {
    return { ok: false, error: 'review_missing', code: 'review_missing', platform, results: [] };
  }
  return { ok: true, platform, results: [{ postId: null, platform, action: 'reply-to-review', ok: true, id }] };
}

// GBP location media + attributes (spec 19, account management, Pattern P3/P9). Mock
// `media-add` fabricates a media resource name for either upload path (URL or local
// file - the mock never touches the network, so it fabricates the SAME envelope for
// both); mock `media-list` fabricates 2-3 canned gallery items; mock `attributes-get`
// fabricates a small canned attribute set; mock `attributes-set` acknowledges with the
// attribute name. All FOUR degrade like the live 403 path (P9): PENDPOST_MOCK_UNGRANTED
// =gbp returns the exact { ok:false, error:'needs_scope', scope:'business.manage' } the
// engine emits with no allowlisted project. media-add also mirrors the live input
// degrades so the tests can drive them offline: an unknown category -> invalid_input.
const MOCK_MEDIA_CATEGORIES = new Set(['COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'ROOMS', 'TEAMS', 'ADDITIONAL']);
// The SAME MEDIA_FORMATS enum the live engine validates (gbp-social.mjs) - mirrored
// here (spec 19 review, MINOR-6) so an unsupported format (e.g. GIF) is rejected in
// mock mode too, instead of silently succeeding and only failing once live.
const MOCK_MEDIA_FORMATS = new Set(['PHOTO', 'VIDEO']);

function handleMediaAdd(platform, sourceUrl, filePath, category, format) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const cat = String(category || '').trim().toUpperCase();
  if (!MOCK_MEDIA_CATEGORIES.has(cat)) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  const fmt = typeof format === 'string' && format.trim() ? format.trim().toUpperCase() : 'PHOTO';
  if (!MOCK_MEDIA_FORMATS.has(fmt)) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  if (!sourceUrl && !filePath) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  const id = mockId('gbpmedia');
  return { ok: true, id, platform, results: [{ platform, action: 'media-add', ok: true, id: `accounts/1/locations/2/media/${id}`, googleUrl: `https://mock.google/${id}` }] };
}

function handleMediaList(platform) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const base = 'accounts/1/locations/2/media';
  const items = [
    { id: `${base}/mock-1`, format: 'PHOTO', category: 'EXTERIOR', thumbnailUrl: 'https://mock.google/mock-1-thumb', googleUrl: 'https://mock.google/mock-1', createTime: new Date(Date.now() - 3 * 86400000).toISOString() },
    { id: `${base}/mock-2`, format: 'PHOTO', category: 'INTERIOR', thumbnailUrl: 'https://mock.google/mock-2-thumb', googleUrl: 'https://mock.google/mock-2', createTime: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: `${base}/mock-3`, format: 'VIDEO', category: 'AT_WORK', thumbnailUrl: 'https://mock.google/mock-3-thumb', googleUrl: 'https://mock.google/mock-3', createTime: new Date(Date.now() - 86400000).toISOString() },
  ];
  return { ok: true, platform, results: [{ platform, action: 'media-list', ok: true, items }] };
}

function handleAttributesGet(platform) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const base = 'attributes';
  const items = [
    { id: `${base}/has_wifi`, valueType: 'BOOL', values: [true] },
    { id: `${base}/wheelchair_accessible_entrance`, valueType: 'BOOL', values: [false] },
    { id: `${base}/from_the_business`, valueType: 'URL', values: [] },
  ];
  return { ok: true, platform, results: [{ platform, action: 'attributes-get', ok: true, items }] };
}

// The SAME valueType enum the live engine validates (gbp-social.mjs ATTR_VALUE_TYPES,
// spec 19 review MINOR-3) - an optional --value-type picks which field the fabricated
// row echoes (uriValues for URL), so a mock-mode test can drive the SAME URL-type
// round trip the live PATCH body exercises, with no network.
const MOCK_ATTR_VALUE_TYPES = new Set(['BOOL', 'ENUM', 'TEXT', 'NUMBER', 'URL', 'REPEATED_ENUM']);

function handleAttributesSet(platform, attribute, value, valueType) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', detail: 'Business Profile API pending approval', platform, results: [] };
  }
  const id = (attribute && String(attribute).trim()) || 'attributes/mock';
  if (value === undefined || value === null) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  const vt = typeof valueType === 'string' && valueType.trim() ? valueType.trim().toUpperCase() : '';
  if (vt && !MOCK_ATTR_VALUE_TYPES.has(vt)) {
    return { ok: false, error: 'invalid_input', code: 'invalid_input', platform, results: [] };
  }
  return { ok: true, platform, results: [{ platform, action: 'attributes-set', ok: true, id, ...(vt === 'URL' ? { uriValues: [{ uri: String(value) }] } : {}) }] };
}

// Ghost members + newsletters (spec 30, Pattern P3/P4/P9, account-scoped - no
// --plan). Mock `members`/`newsletters` fabricate a small, STABLE canned audience
// (deterministic across calls, like handleReviews) so the Setup card + tests get
// consistent numbers with no network. Mock `member-create`/`newsletter-create`
// mint a fake id (invalid_input on a missing required field, mirroring the live
// engine's local validation); `newsletter-update` echoes the requested id/status.
// `members-import` is the resilience-focused one: it classifies each row of
// --rows (a JSON array) or --file (a local CSV, parsed with the SAME zero-dep
// lib/util.mjs#parseCsvRows the live engine uses) with NO network call - a
// missing/malformed email -> failed[], an email containing "duplicate" ->
// skipped (simulates Ghost's real 422-on-duplicate-email), everything else ->
// created. UNLIKE the rest of this file's P9 degrades, `not_configured` (a
// missing GHOST_ADMIN_API_KEY) is NOT mocked here - it is a LIVE-only guard
// (mock mode never checks credentials, by design, on every lane) exercised
// against the live cmd* in test/ghost-members.test.mjs instead.
const MOCK_GHOST_NEWSLETTERS = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', slug: 'weekly', name: 'Weekly', status: 'active', subscribe_on_signup: true, members_count: 1090 },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', slug: 'monthly-digest', name: 'Monthly Digest', status: 'archived', subscribe_on_signup: false, members_count: 150 },
];
const MOCK_GHOST_MEMBERS = [
  { id: 'cccccccccccccccccccccccc', email: 'alex@example.com', name: 'Alex M.', status: 'free', labels: [{ id: 'l1', name: 'vip', slug: 'vip' }], newsletters: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Weekly', status: 'active' }] },
  { id: 'dddddddddddddddddddddddd', email: 'jordan@example.com', name: 'Jordan P.', status: 'paid', labels: [], newsletters: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Weekly', status: 'active' }] },
  { id: 'eeeeeeeeeeeeeeeeeeeeeeee', email: 'sam@example.com', name: 'Sam K.', status: 'comped', labels: [], newsletters: [] },
];

function handleGhostMembers(platform) {
  const counts = { total: 1240, free: 1090, paid: 100, comped: 50 };
  return { ok: true, platform, results: [{ platform, action: 'members', ok: true, counts, items: MOCK_GHOST_MEMBERS }] };
}

function handleGhostMemberCreate(platform, email) {
  if (!email || !String(email).trim()) {
    return { ok: true, platform, results: [{ platform, action: 'member-create', ok: false, errorCode: 'invalid_input', errorMessage: '--email is required' }] };
  }
  return { ok: true, platform, results: [{ platform, action: 'member-create', ok: true, id: mockId('member') }] };
}

// Row classifier shared by --rows (parsed JSON) and --file (parsed CSV) - a pure
// function of one row, NO network: missing/malformed email -> failed, an email
// containing "duplicate" -> skipped (simulates Ghost's real 422 on a dup email),
// otherwise -> created. Lets a mock-mode test drive all three outcomes by simply
// crafting the right synthetic email, exactly like handleReplyToReview's
// id-containing-"missing" convention.
function classifyGhostImportRow(row) {
  const email = row && typeof row.email === 'string' ? row.email.trim() : '';
  if (!email) return { outcome: 'failed', email: null, error: 'missing email' };
  if (/duplicate/i.test(email)) return { outcome: 'skipped', email };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { outcome: 'failed', email, error: 'invalid email' };
  return { outcome: 'created', email };
}

function handleGhostMembersImport(platform, rowsArg, filePathArg) {
  const hasRows = typeof rowsArg === 'string' && rowsArg.trim();
  const hasFile = typeof filePathArg === 'string' && filePathArg.trim();
  if (!hasRows && !hasFile) {
    return { ok: true, platform, results: [{ platform, action: 'members-import', ok: false, errorCode: 'invalid_input', errorMessage: 'members-import requires --file <csv> or --rows <json>' }] };
  }
  let rows = [];
  try {
    if (typeof rowsArg === 'string' && rowsArg.trim()) {
      const parsed = JSON.parse(rowsArg);
      rows = Array.isArray(parsed) ? parsed : [];
    } else if (typeof filePathArg === 'string' && filePathArg.trim()) {
      const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(DATA_ROOT, '..');
      const abs = path.isAbsolute(filePathArg) ? filePathArg : path.resolve(root, filePathArg);
      rows = fs.existsSync(abs) ? parseCsvRows(fs.readFileSync(abs, 'utf8')) : [];
    }
  } catch { rows = []; }
  let created = 0;
  let skipped = 0;
  const failed = [];
  for (const row of rows) {
    const c = classifyGhostImportRow(row);
    if (c.outcome === 'created') created += 1;
    else if (c.outcome === 'skipped') skipped += 1;
    else failed.push({ email: c.email, error: c.error });
  }
  return { ok: true, platform, results: [{ platform, action: 'members-import', ok: true, created, skipped, failed }] };
}

function handleGhostNewsletters(platform) {
  return { ok: true, platform, results: [{ platform, action: 'newsletters', ok: true, items: MOCK_GHOST_NEWSLETTERS }] };
}

function handleGhostNewsletterCreate(platform, name) {
  if (!name || !String(name).trim()) {
    return { ok: true, platform, results: [{ platform, action: 'newsletter-create', ok: false, errorCode: 'invalid_input', errorMessage: '--name is required' }] };
  }
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'newsletter';
  return { ok: true, platform, results: [{ platform, action: 'newsletter-create', ok: true, id: mockId('newsletter'), slug }] };
}

const MOCK_GHOST_NEWSLETTER_STATUSES = new Set(['active', 'archived']);
function handleGhostNewsletterUpdate(platform, id, status) {
  if (!id || !String(id).trim()) {
    return { ok: true, platform, results: [{ platform, action: 'newsletter-update', ok: false, errorCode: 'invalid_input', errorMessage: '--id is required' }] };
  }
  const st = typeof status === 'string' && status.trim() ? status.trim() : 'active';
  if (!MOCK_GHOST_NEWSLETTER_STATUSES.has(st)) {
    return { ok: true, platform, results: [{ platform, action: 'newsletter-update', ok: false, errorCode: 'invalid_input', errorMessage: '--status must be active|archived' }] };
  }
  return { ok: true, platform, results: [{ platform, action: 'newsletter-update', ok: true, id: String(id).trim(), status: st }] };
}

// Moderation (spec 06). Mock `moderate` acknowledges with a fabricated id when the
// action is in the lane's REAL supported set (COMMENT_CAPABILITIES - the SAME table
// the live runLaneModerate enforces, so mock can never offer what live cannot do),
// and returns the exact { ok:false, error:'unsupported_action', lane } the live path
// emits for a lane/action with no REST. It DEGRADES like the live path (P9): the
// ungranted signal returns { ok:false, error:'needs_scope', scope } with no network.
function handleModerate(platform, only, action) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: `mock:${platform}:moderate`, platform, results: [] };
  }
  const supported = COMMENT_CAPABILITIES[platform]?.moderate || [];
  if (!action || !supported.includes(action)) {
    return { ok: false, error: 'unsupported_action', lane: platform, platform, results: [] };
  }
  const id = 'mock-moderate';
  const postId = only || 'mock-post';
  return { ok: true, id, platform, results: [{ postId, platform, action: 'moderate', ok: true, id, moderation: action }] };
}

// Reactions (spec 24). Mock `react` acknowledges with a fabricated id when the reaction
// is in the lane's REAL supported set (COMMENT_CAPABILITIES.react - the SAME table the
// live runLaneReact enforces, so mock can never offer what live cannot do), and returns
// the exact { ok:false, error:'unsupported_reaction', lane } the live path emits for a
// lane/reaction with no REST. It DEGRADES like the live path (P9): the ungranted signal
// returns { ok:false, error:'needs_scope', scope } with no network. IDEMPOTENT by
// construction: the same reaction always maps to the same fabricated id + end state (no
// local state kept, so a repeat react returns the identical envelope); `--remove` clears
// (removed:true). reddit is absent from the react table, so it can never react here.
function handleReact(platform, only, reaction, emoji, remove) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: `mock:${platform}:react`, platform, results: [] };
  }
  const supported = COMMENT_CAPABILITIES[platform]?.react || [];
  if (!reaction || !supported.includes(reaction)) {
    return { ok: false, error: 'unsupported_reaction', lane: platform, platform, results: [] };
  }
  const id = 'mock-react';
  const postId = only || 'mock-post';
  void emoji;
  return { ok: true, id, platform, results: [{ postId, platform, action: 'react', ok: true, id, reaction, removed: Boolean(remove) }] };
}

// The account-scoped insights pass (spec 04, Pattern P5). Mock `performance`
// fabricates a canned location-wide performance payload in the canonical account
// row shape ({ postId:null, platform, action:'performance', ok:true, scope:'account',
// performance:{...} }); it DEGRADES like the live 403 path - when PENDPOST_MOCK_UNGRANTED
// lists this platform it returns the exact { ok:false, error:'needs_scope', scope }
// the engine emits without granted GBP access, so a test exercises the P9 shape
// with no live API. Seeded per platform so the numbers are stable across sweeps.
function handlePerformance(platform) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: 'business.manage', platform, results: [] };
  }
  const r = seeded(`${platform}:performance`);
  const n = (min, max) => Math.floor(min + r() * (max - min));
  return {
    ok: true,
    platform,
    results: [{
      postId: null, platform, action: 'performance', ok: true, scope: 'account',
      performance: {
        calls: n(10, 200), websiteClicks: n(20, 400), directions: n(5, 150),
        bookings: n(0, 40), conversations: n(0, 60), impressions: n(500, 9000),
        searchKeywords: [
          { keyword: 'coffee near me', count: n(120, 500) },
          { keyword: 'best espresso downtown', count: n(60, 250) },
          { keyword: 'cafe open now', count: n(20, 120) },
        ].sort((a, b) => b.count - a.count),
      },
    }],
  };
}

// The account-scoped demographics pass (spec 07, Pattern P5, the SAME account-pass
// seam spec 04 built for `performance`). Mock `demographics` fabricates a canned
// audience breakdown in the canonical account row shape ({ postId:null, platform,
// action:'demographics', ok:true, scope:'account', demographics:{...} }), shaped
// per-lane like the real APIs (age/gender/country/city for meta, age/gender for
// youtube, age/gender/region for pinterest, seniority/function/industry/region
// for linkedin - LinkedIn has no age/gender follower-statistics surface).
// Degrades like the live needs_scope path (P9) via
// the SAME PENDPOST_MOCK_UNGRANTED convention `performance` uses, with the exact
// scope string each lane's live degrade names (so mock/live never disagree).
// Seeded per platform so the numbers are stable across sweeps.
const DEMOGRAPHICS_SCOPE = {
  meta: 'instagram_business_manage_insights',
  youtube: 'yt-analytics.readonly',
  linkedin: 'rw_organization_admin',
  pinterest: 'ads:read',
};
function handleDemographics(platform) {
  if (mockUngranted(platform)) {
    return { ok: false, error: 'needs_scope', scope: DEMOGRAPHICS_SCOPE[platform] || 'demographics', platform, results: [] };
  }
  const r = seeded(`${platform}:demographics`);
  const n = (min, max) => Math.floor(min + r() * (max - min));
  const bucket = (labels) => Object.fromEntries(labels.map((l) => [l, n(5, 65)]));
  const AGE = ['18-24', '25-34', '35-44', '45-54'];
  const GENDER = ['male', 'female'];
  let demographics;
  if (platform === 'linkedin') {
    demographics = {
      seniority: bucket(['entry', 'senior', 'manager', 'director', 'vp']),
      function: bucket(['engineering', 'sales', 'marketing', 'operations']),
      industry: bucket(['software', 'retail', 'finance']),
      region: bucket(['north-america', 'europe', 'asia']),
    };
  } else if (platform === 'youtube') {
    demographics = { age: bucket(AGE), gender: bucket(GENDER) };
  } else if (platform === 'pinterest') {
    // Pinterest's ad_accounts audience_insights surface has no city breakdown -
    // {age, gender, region}, distinct from meta's {age, gender, country, city}.
    demographics = { age: bucket(AGE), gender: bucket(GENDER), region: bucket(['north-america', 'europe', 'asia']) };
  } else {
    demographics = { age: bucket(AGE), gender: bucket(GENDER), country: bucket(['US', 'GB', 'DE']), city: bucket(['New York', 'London', 'Berlin']) };
  }
  return {
    ok: true,
    platform,
    results: [{ postId: null, platform, action: 'demographics', ok: true, scope: 'account', demographics }],
  };
}

// Connected-account discovery (spec 22, Pattern P3/P9). Mock `discover` fabricates a
// canned identity + two manageable assets in the normalized envelope shape
// ({ platform, action:'discover', ok:true, identity, assets, selected }), so the
// Studio's DiscoveryBlock + its component tests run credential-free. It DEGRADES like
// the live needs-scope path: when PENDPOST_MOCK_UNGRANTED lists this platform it
// returns the exact { ok:false, error:'needs_scope', scope } row the engine emits
// without a granted tier - the P9 shape exercised with no live API. The row shape is
// built through the shared factories so mock can never drift from the live envelope.
async function handleDiscover(platform) {
  const { discoverOk, discoverNeedsScope, discoverAsset, DISCOVER_IDENTIFIER, DISCOVER_ASSET_KIND } = await import('../discovery.mjs');
  if (mockUngranted(platform)) {
    return { ok: true, results: [discoverNeedsScope(platform)] };
  }
  const kind = DISCOVER_ASSET_KIND[platform] || 'page';
  const idKey = DISCOVER_IDENTIFIER[platform] || null;
  const firstId = `mock_${platform}_asset_1`;
  const assets = [
    discoverAsset({ kind, id: firstId, name: `Mock ${platform} A`, current: true }),
    discoverAsset({ kind, id: `mock_${platform}_asset_2`, name: `Mock ${platform} B`, current: false }),
  ];
  const row = discoverOk(platform, {
    identity: { id: `mock_${platform}_id`, handle: `mock_${platform}`, name: `Mock ${platform} Account` },
    assets,
    selected: idKey ? { [idKey]: firstId } : {},
  });
  return { ok: true, results: [row] };
}

// Pre-submit validation reads (spec 09, Pattern P3/P9). Mock `presubmit`
// fabricates a DETERMINISTIC ready/blocked shape per lane so PlatformBlockers'
// merge + its tests run credential-free: a reddit post with no picked flair comes
// back flair-required (a BLOCKING problem, spec 36) + a restricted subreddit
// (problem, mirroring a locked-down test subreddit); once the post carries a
// redditFlairId the flair problem clears; a tiktok post is
// flagged with an over-limit caption (problem, when the caption exceeds the
// real CAPTION_LIMIT) and/or a disallowed privacy level (problem, when
// ttPrivacy requests anything other than the mock creator's one allowed level,
// SELF_ONLY) - a short caption with no ttPrivacy override is the CLEAN tiktok
// case (ready:true, empty arrays). Degrades exactly like the live path (P9):
// PENDPOST_MOCK_UNGRANTED listing this platform returns the ok:true/
// ready:null/needsScope-warning shape instead.
const TIKTOK_MOCK_CAPTION_LIMIT = 2200;
// The mock subreddit's title cap (post_requirements.title_text_max_length),
// so a too-long title flags the titleRule problem (§2: "title over the limit").
const REDDIT_MOCK_TITLE_MAX = 100;
// The mock subreddit's prose rule list (/r/<sub>/about/rules), shaped like a real developer
// subreddit's so the norm classifier has something honest to chew on credential-free.
const REDDIT_MOCK_PROSE_RULES = [
  { short_name: 'No AI generated slop', description: 'Low effort AI generated posts are removed on sight.' },
  { short_name: 'Self promotion is limited', description: 'Sharing your own project is fine if you are an active participant here.' },
];
function handlePresubmit(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true) && (p.platforms || []).includes(platform));
  const results = [];
  for (const post of posts) {
    if (mockUngranted(platform)) {
      results.push({ postId: post.id, platform, action: 'presubmit', ok: true, ready: null, problems: [], warnings: [{ code: 'needsScope', text: '' }], meta: {} });
      continue;
    }
    const problems = [];
    const warnings = [];
    if (platform === 'reddit') {
      // Spec 36: flair-required with no picked flair is a BLOCKING problem (was a
      // spec-16 warning) - silent once the post carries a redditFlairId.
      if (!post.redditFlairId) problems.push({ code: 'flairRequired', text: '' });
      problems.push({ code: 'restricted', text: 'restricted' });
      // Title-length cap (mirrors the live title_text_max_length check): the
      // title is post.title, else the first non-empty caption line (titleFor).
      const title = (post.title || '').trim() || (post.caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
      if (title.length > REDDIT_MOCK_TITLE_MAX) problems.push({ code: 'titleRule', text: `over ${REDDIT_MOCK_TITLE_MAX} chars` });
      // The mock subreddit's PROSE rules, run through the SAME classifier the live path uses
      // (never a second hand-written copy of the codes - one rule set, two callers). The
      // fixture mirrors a real developer subreddit, so the credential-free path exercises the
      // norm-warning rows end to end. flairExpected stays silent here: the mock sub already
      // requires a flair, so that row would duplicate the blocking flairRequired problem.
      warnings.push(...classifySubRules({
        rules: REDDIT_MOCK_PROSE_RULES,
        submitText: '',
        flairRequired: true,
        hasFlair: Boolean(post.redditFlairId),
      }));
    } else if (platform === 'tiktok') {
      const caption = (post.ttCaption || post.caption || '').trim();
      if (caption.length > TIKTOK_MOCK_CAPTION_LIMIT) problems.push({ code: 'captionLength', text: `${caption.length}/${TIKTOK_MOCK_CAPTION_LIMIT}` });
      const wanted = (post.ttPrivacy || 'SELF_ONLY').toString().trim().toUpperCase();
      if (wanted !== 'SELF_ONLY') problems.push({ code: 'privacy', text: wanted });
    }
    results.push({ postId: post.id, platform, action: 'presubmit', ok: true, ready: problems.length === 0, problems, warnings, meta: {} });
  }
  return { ok: true, results };
}

// YouTube playlists (spec 15, Pattern P3/P4/P9). Mock playlists-list/playlist-
// create/playlist-add fabricate the same shape the live engine returns with no
// network call. playlist-add persists the membership on the SAME plan-based
// post.ytPlaylistItems echo the live engine writes (engine-owned field), so a
// second add against the same plan entry resolves to duplicate:true with zero
// live state - the identical outcome the live pre-list dup check achieves via a
// real API call. Degrades via the shared PENDPOST_MOCK_UNGRANTED convention
// (P9); the RESULT ROW - not the top envelope - carries needs_scope, mirroring
// how the live engine never throws on a 403 (main() still emits {ok:true, ...RUN}).
const MOCK_PLAYLISTS = [
  { id: 'mock_playlist_series_a', title: 'Series A', privacy: 'public', itemCount: 4 },
  { id: 'mock_playlist_series_b', title: 'Series B', privacy: 'unlisted', itemCount: 1 },
];
function handlePlaylistsList(platform) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'playlists-list', ok: false, error: 'needs_scope', scope: 'youtube' }] };
  }
  return { ok: true, results: [{ platform, action: 'playlists-list', ok: true, playlists: MOCK_PLAYLISTS }] };
}
function handlePlaylistCreate(platform, title, description, privacy) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'playlist-create', ok: false, error: 'needs_scope', scope: 'youtube' }] };
  }
  void description; // mirrors the live call's shape; not echoed back (title is)
  void privacy;
  return { ok: true, results: [{ platform, action: 'playlist-create', ok: true, id: mockId('playlist'), title: title || 'pendpost playlist' }] };
}
function handlePlaylistAdd(platform, planPath, only, playlistIdArg, videoIdArg) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'playlist-add', ok: false, error: 'needs_scope', scope: 'youtube' }] };
  }
  let plan = null;
  let post = null;
  if (planPath) {
    plan = loadPlan(planPath);
    post = (plan.posts || []).find((p) => (only ? p.id === only : true) && (p.platforms || []).includes(platform));
  }
  const videoId = videoIdArg || (post && post.ytVideoId) || mockYtId();
  const playlistId = playlistIdArg || MOCK_PLAYLISTS[0].id;
  // Only echo/dedup against the post's membership when the resolved video actually
  // IS the post's published video. An explicit videoId override for a DIFFERENT
  // video is an ad-hoc add that must NOT record a false membership on this post
  // (mirrors the live engine's post.ytVideoId === videoId echo guard).
  if (post && post.ytVideoId === videoId) {
    post.ytPlaylistItems = Array.isArray(post.ytPlaylistItems) ? post.ytPlaylistItems : [];
    const existing = post.ytPlaylistItems.find((e) => e.playlistId === playlistId);
    if (existing) {
      return { ok: true, results: [{ postId: post.id, platform, action: 'playlist-add', ok: true, id: existing.itemId, playlistId, videoId, duplicate: true }] };
    }
    const itemId = mockId('plitem');
    post.ytPlaylistItems.push({ playlistId, itemId });
    savePlan(planPath, plan);
    return { ok: true, results: [{ postId: post.id, platform, action: 'playlist-add', ok: true, id: itemId, playlistId, videoId }] };
  }
  // Ad-hoc (no --plan/--only context, or a videoId override that isn't this post's
  // video): no persisted state to dedup against + no echo, so every call is a fresh
  // "add".
  return { ok: true, results: [{ postId: post ? post.id : null, platform, action: 'playlist-add', ok: true, id: mockId('plitem'), playlistId, videoId }] };
}

// Pinterest board + section CRUD (spec 29, Pattern P3+P4+P9). Mock board-list
// fabricates two canned boards ({id,name,privacy,pinCount}) so Setup's
// BoardManager panel renders offline/in tests - UNLIKE the spec-17 board-sections
// read (which stays live-only), board-list is mockable BY DESIGN and never gates
// on PENDPOST_MOCK_UNGRANTED (boards:read is the ORIGINAL scope, mirroring the
// live board-list/board-sections split). The four WRITES degrade via the SAME
// PENDPOST_MOCK_UNGRANTED convention every other P9 mock write uses (a token
// predating spec 29's NEW boards:write scope is the live case).
const MOCK_BOARDS = [
  { id: 'mock_pinterest_board_1', name: 'Mock Board A', privacy: 'PUBLIC', pinCount: 12 },
  { id: 'mock_pinterest_board_2', name: 'Mock Board B', privacy: 'SECRET', pinCount: 3 },
];
function handleBoardList(platform) {
  // Spec 29 review (MINOR-4): read the WORKSPACE's own PINTEREST_BOARD_ID for
  // `current` (mirrors the live cmdBoardList's `current: boardId()` echo)
  // instead of hardcoding the first canned board - so a "Set as destination"
  // write (config_set -> .env) is reflected back here in mock/demo mode too.
  // Falls back to the first canned board only when nothing is configured yet.
  const current = readEnv('PINTEREST_BOARD_ID') || MOCK_BOARDS[0].id;
  return { ok: true, results: [{ platform, action: 'board-list', ok: true, boards: MOCK_BOARDS, current }] };
}
function handleBoardCreate(platform, name, description, privacy) {
  void description; // mirrors handlePlaylistCreate's shape; not echoed back (name is)
  void privacy;
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'board-create', ok: false, error: 'needs_scope', scope: 'boards:write' }] };
  }
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: true, results: [{ platform, action: 'board-create', ok: false, error: 'invalid_input', message: '--name is required' }] };
  }
  return { ok: true, results: [{ platform, action: 'board-create', ok: true, id: mockId('board'), name: name.trim() }] };
}
function handleBoardUpdate(platform, boardIdArg, name) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'board-update', ok: false, error: 'needs_scope', scope: 'boards:write' }] };
  }
  if (typeof boardIdArg !== 'string' || !boardIdArg.trim()) {
    return { ok: true, results: [{ platform, action: 'board-update', ok: false, error: 'invalid_input', message: '--id (board id) is required' }] };
  }
  return { ok: true, results: [{ platform, action: 'board-update', ok: true, id: boardIdArg, name: (typeof name === 'string' && name.trim()) ? name.trim() : null }] };
}
function handleBoardSectionCreate(platform, boardIdArg, name) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'board-section-create', ok: false, error: 'needs_scope', scope: 'boards:write', boardId: boardIdArg || null }] };
  }
  if (typeof boardIdArg !== 'string' || !boardIdArg.trim() || typeof name !== 'string' || !name.trim()) {
    return { ok: true, results: [{ platform, action: 'board-section-create', ok: false, error: 'invalid_input', message: '--board and --name are required' }] };
  }
  return { ok: true, results: [{ platform, action: 'board-section-create', ok: true, boardId: boardIdArg, id: mockId('section'), name: name.trim() }] };
}
function handleBoardSectionUpdate(platform, boardIdArg, sectionIdArg, name) {
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action: 'board-section-update', ok: false, error: 'needs_scope', scope: 'boards:write', boardId: boardIdArg || null }] };
  }
  if (typeof boardIdArg !== 'string' || !boardIdArg.trim() || typeof sectionIdArg !== 'string' || !sectionIdArg.trim() || typeof name !== 'string' || !name.trim()) {
    return { ok: true, results: [{ platform, action: 'board-section-update', ok: false, error: 'invalid_input', message: '--board, --section and --name are required' }] };
  }
  return { ok: true, results: [{ platform, action: 'board-section-update', ok: true, boardId: boardIdArg, id: sectionIdArg, name: name.trim() }] };
}

// Edit-after-publish (spec 12, Pattern P3+P9): push a content/metadata edit to an
// already-published minted object (youtube videos.update / telegram editMessage* /
// discord PATCH .../messages/{id}). Mock acknowledges with the post's EXISTING
// minted id (LANE_OBJECT_FIELD - the SAME table resolveCommentTarget uses) since
// the live verb never mints a NEW id, only re-sends content - a repeat edit reads
// as the same object. A post with no minted id for this lane no-ops with a clear
// result (mirrors the live "bare CLI run is safe" guard; editPublished itself
// already filters to minted lanes before calling here, so this only matters for a
// direct CLI run). Degrades like the live path (P9): PENDPOST_MOCK_UNGRANTED
// listing this platform (youtube missing the write scope is the live degrade
// case) returns needs_scope with no network - the RESULT ROW carries it, mirroring
// the playlists degrade above (the top envelope stays ok:true).
function handleEdit(platform, planPath, only) {
  if (mockUngranted(platform)) {
    // Spec 12 review (nit #7): only youtube's edit is gated by an OAuth WRITE
    // scope (mirrors the live 403->needs_scope degrade in scripts/yt-social.mjs
    // cmdEdit) - telegram/discord edit over a static bot-token/webhook, so there
    // is no scope to name for them (hardcoding 'youtube' there was a lie).
    const row = { platform, action: 'edit', ok: false, error: 'needs_scope' };
    if (platform === 'youtube') row.scope = 'youtube';
    return { ok: true, results: [row] };
  }
  const idField = LANE_OBJECT_FIELD[platform];
  let post = null;
  if (planPath) {
    const plan = loadPlan(planPath);
    post = (plan.posts || []).find((p) => (only ? p.id === only : true) && (p.platforms || []).includes(platform));
  }
  const postId = post ? post.id : (only || 'mock-post');
  if (post && idField && !post[idField]) {
    return { ok: true, results: [{ postId, platform, action: 'edit', ok: true, skipped: 'no_minted_id' }] };
  }
  const id = (post && idField && post[idField]) || mockId('edit');
  return { ok: true, results: [{ postId, platform, action: 'edit', ok: true, id }] };
}

// Discord guild scheduled events (spec 26, Pattern P3+P9): mock `schedule-event`
// mints a fake guild-event id and persists it as post.dcEventId - IDEMPOTENT (a
// post that already carries dcEventId no-ops with the SAME id, unchanged:true)
// so a repeat call never mints a second event, mirroring the live GET-and-no-op
// path. Degrades honestly (P9): no bot token configured -> a needs_scope RESULT
// ROW (never a top-level ok:false - the live cmdScheduleEvent never throws
// either), with no plan mutation.
function handleScheduleEvent(platform, planPath, only, botTokenConfigured) {
  let plan = null;
  let post = null;
  if (planPath) {
    plan = loadPlan(planPath);
    post = (plan.posts || []).find((p) => (only ? p.id === only : true) && (p.platforms || []).includes(platform));
  }
  const postId = post ? post.id : (only || 'mock-post');
  if (!botTokenConfigured) {
    return { ok: true, results: [{ postId, platform, action: 'schedule-event', ok: false, error: 'needs_scope', scope: 'discord_bot_token+MANAGE_EVENTS' }] };
  }
  if (post && post.dcEventId) {
    return { ok: true, results: [{ postId, platform, action: 'schedule-event', ok: true, id: post.dcEventId, unchanged: true }] };
  }
  const id = mockId('event');
  if (post) {
    post.dcEventId = id;
    savePlan(planPath, plan);
  }
  return { ok: true, results: [{ postId, platform, action: 'schedule-event', ok: true, id }] };
}

// Mastodon pin/unpin (spec 31, Pattern P3+P9). Mock `pin`/`unpin` track pinned
// state on the SAME plan-based post.mastodonPinned echo the live engine writes
// (engine-owned field, mirrors handlePlaylistAdd's post.ytPlaylistItems), so a
// repeat call resolves IDEMPOTENT (alreadyPinned/alreadyUnpinned) with zero live
// state - the identical outcome the live GET-before-write achieves via a real
// API call. Degrades via the shared PENDPOST_MOCK_UNGRANTED convention (P9).
function handlePin(platform, planPath, only, idArg, pin) {
  const action = pin ? 'pin' : 'unpin';
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action, ok: false, error: 'needs_scope', scope: 'write:accounts' }] };
  }
  let plan = null;
  let post = null;
  if (planPath) {
    plan = loadPlan(planPath);
    post = (plan.posts || []).find((p) => (only ? p.id === only : true) && (p.platforms || []).includes(platform) && p.mastodonStatusId);
  }
  const statusId = (typeof idArg === 'string' && idArg.trim()) || (post && post.mastodonStatusId) || null;
  const postId = post ? post.id : null;
  if (!statusId) {
    return { ok: true, results: [{ postId, platform, action, ok: false, error: 'invalid_input', errorMessage: 'no status id resolved' }] };
  }
  const currentlyPinned = post ? post.mastodonPinned === true : false;
  const already = pin ? currentlyPinned : !currentlyPinned;
  if (post) {
    post.mastodonPinned = pin;
    savePlan(planPath, plan);
  }
  return { ok: true, results: [{ postId, platform, action, ok: true, id: statusId, ...(already ? (pin ? { alreadyPinned: true } : { alreadyUnpinned: true }) : {}) }] };
}

// Mastodon follow/unfollow (spec 31, Pattern P3+P9). Mock `follow`/`unfollow`
// fabricate an account id for any non-empty --acct; an acct containing "unknown"
// simulates the live search-miss path (mirrors handleReplyToReview's id-
// containing-"missing" convention) so invalid_input is exercisable offline.
// Degrades via the shared PENDPOST_MOCK_UNGRANTED convention (P9).
function handleFollow(platform, acctArg, follow) {
  const action = follow ? 'follow' : 'unfollow';
  if (mockUngranted(platform)) {
    return { ok: true, results: [{ platform, action, ok: false, error: 'needs_scope', scope: 'write:follows' }] };
  }
  const acct = String(acctArg || '').trim().replace(/^@/, '');
  if (!acct) {
    return { ok: true, results: [{ platform, action, ok: false, error: 'invalid_input', errorMessage: '--acct is required' }] };
  }
  if (/unknown/i.test(acct)) {
    return { ok: true, results: [{ platform, action, ok: false, error: 'invalid_input', errorMessage: `could not resolve @${acct}` }] };
  }
  return { ok: true, results: [{ platform, action, ok: true, id: mockId('account'), acct, following: follow }] };
}

// Nostr social-graph (spec 31, Pattern P3+P9). Mock `relay-list-set`/`list-set`
// fabricate an event id + echo the shape a test asserts against (count/kind) with
// NO relay round-trip; mock `list-get` fabricates a small canned tag list per
// kind (mirrors handleReviews' stable canned fixtures) so the read renders
// offline. Nostr has no OAuth scope (a sealed key either signs or it does not),
// so these do not gate on PENDPOST_MOCK_UNGRANTED - only on malformed input,
// exactly like the live engine's own pre-flight validation.
const MOCK_NIP51_LIST_KINDS = [10000, 10001, 30000];
const MOCK_LIST_GET_KINDS = [...MOCK_NIP51_LIST_KINDS, 10002];

function handleRelayListSet(platform, relaysArg) {
  let relays;
  try { relays = JSON.parse(typeof relaysArg === 'string' ? relaysArg : '[]'); } catch { relays = null; }
  const valid = Array.isArray(relays) && relays.length > 0 && relays.every((r) => Array.isArray(r) && typeof r[0] === 'string' && /^wss?:\/\//i.test(r[0]));
  if (!valid) {
    return { ok: true, results: [{ platform, action: 'relay-list-set', ok: false, error: 'invalid_input', errorMessage: '--relays must be a non-empty JSON array of [wss://url, marker?] pairs' }] };
  }
  return { ok: true, results: [{ platform, action: 'relay-list-set', ok: true, id: mockId('event'), count: relays.length }] };
}

function handleListSet(platform, kindArg, itemsArg) {
  const kind = Number(kindArg);
  if (!MOCK_NIP51_LIST_KINDS.includes(kind)) {
    return { ok: true, results: [{ platform, action: 'list-set', ok: false, error: 'invalid_input', errorMessage: `kind must be one of ${MOCK_NIP51_LIST_KINDS.join(',')}` }] };
  }
  let items;
  try { items = JSON.parse(typeof itemsArg === 'string' ? itemsArg : '[]'); } catch { items = null; }
  if (!Array.isArray(items)) {
    return { ok: true, results: [{ platform, action: 'list-set', ok: false, error: 'invalid_input', errorMessage: '--items must be a JSON array' }] };
  }
  return { ok: true, results: [{ platform, action: 'list-set', ok: true, id: mockId('event'), kind, count: items.length }] };
}

function handleListGet(platform, kindArg) {
  const kind = Number(kindArg);
  if (!MOCK_LIST_GET_KINDS.includes(kind)) {
    return { ok: true, results: [{ platform, action: 'list-get', ok: false, error: 'invalid_input', errorMessage: `kind must be one of ${MOCK_LIST_GET_KINDS.join(',')}` }] };
  }
  const items = kind === 30000 ? [['p', 'mock_followed_pubkey_1'], ['d', 'pendpost']]
    : kind === 10002 ? [['r', 'wss://relay.mock.example']]
    : [['e', 'mock_event_1']];
  return { ok: true, results: [{ platform, action: 'list-get', ok: true, kind, id: mockId('event'), items }] };
}

// The single entry point the engines call in mock mode. platform is the engine
// identity ('meta'|'linkedin'|'youtube'); command is the CLI command. Returns
// the standard envelope - the caller writes it to stdout as one JSON line.
export async function runMockCommand({
  platform, command, planPath = null, only = null,
  title = null, description = null, privacy = null, playlistId = null, videoId = null,
  action = null, reaction = null, emoji = null, remove = false,
  reviewId = null, text = null, amount = null, nwcConfigured = false,
  botTokenConfigured = false,
  sourceUrl = null, filePath = null, category = null, format = null, attribute = null, value = null, valueType = null,
  // Spec 28 review (MINOR-6): the profile verb's --probe flag - threaded through so
  // mock mode can distinguish a probe (read-only tier check) from an apply, exactly
  // like the live engines do.
  probe = false,
  // Spec 29: Pinterest board/section CRUD extra flags (--name/--board/--section -
  // title/description/privacy above are reused for the board's own fields).
  name = null, boardId = null, sectionId = null,
  // Spec 30: Ghost members + newsletters extra flags. email/limit/page/filter/
  // rows are members-only; id/status are newsletter-update-only; name/description
  // above are reused for newsletter-create's own fields (mirrors board-create).
  email = null, limit = null, page = null, filter = null, rows = null, id = null, status = null,
  // Spec 31: mastodon follow/unfollow's --acct; nostr relay-list-set's --relays
  // (JSON) + list-set/list-get's --kind + list-set's --items (JSON). pin/unpin
  // reuse `id` (the explicit status id override) already destructured above.
  acct = null, relays = null, kind = null, items = null,
  // Spec 32: the Radar (beta) `radar` search verb's --query (the RadarQuery JSON) -
  // threaded through so the mock can echo the query's competitors into its canned
  // signals. lib/radar.mjs#runLaneRadar passes it in mock mode (no engine spawn).
  query = null,
} = {}) {
  // Root fence FIRST, outside the catch-all below: a mock run against a live
  // workspace must fail LOUD (throw to the caller), never degrade into an
  // ok:false envelope the scheduler would just log and retry.
  assertMockRootAllowed();
  try {
    switch (command) {
      case 'comments':
        return handleComments(platform, only);
      case 'reply':
        return handleReply(platform, only);
      case 'zap':
        return handleZap(platform, only, amount, nwcConfigured);
      case 'radar':
        return handleRadar(platform, query);
      case 'radar-followup':
        return handleRadarFollowup(platform, planPath, only);
      case 'reviews':
        return handleReviews(platform);
      case 'reply-to-review':
        return handleReplyToReview(platform, reviewId, text, remove);
      case 'media-add':
        return handleMediaAdd(platform, sourceUrl, filePath, category, format);
      case 'media-list':
        return handleMediaList(platform);
      case 'attributes-get':
        return handleAttributesGet(platform);
      case 'attributes-set':
        return handleAttributesSet(platform, attribute, value, valueType);
      case 'moderate':
        return handleModerate(platform, only, action);
      case 'react':
        return handleReact(platform, only, reaction, emoji, remove);
      case 'performance':
        return handlePerformance(platform);
      case 'demographics':
        return handleDemographics(platform);
      case 'discover':
        return handleDiscover(platform);
      case 'playlists-list':
        return handlePlaylistsList(platform);
      case 'playlist-create':
        return handlePlaylistCreate(platform, title, description, privacy);
      case 'playlist-add':
        return handlePlaylistAdd(platform, planPath, only, playlistId, videoId);
      case 'edit':
        return handleEdit(platform, planPath, only);
      case 'schedule-event':
        return handleScheduleEvent(platform, planPath, only, botTokenConfigured);
      case 'board-list':
        return handleBoardList(platform);
      case 'board-create':
        return handleBoardCreate(platform, name, description, privacy);
      case 'board-update':
        return handleBoardUpdate(platform, boardId, name);
      case 'board-section-create':
        return handleBoardSectionCreate(platform, boardId, name);
      case 'board-section-update':
        return handleBoardSectionUpdate(platform, boardId, sectionId, name);
      case 'members':
        void limit; void page; void filter; // mock returns the SAME canned page regardless (deterministic, no live pagination/NQL)
        return handleGhostMembers(platform);
      case 'member-create':
        return handleGhostMemberCreate(platform, email);
      case 'members-import':
        return handleGhostMembersImport(platform, rows, filePath);
      case 'newsletters':
        return handleGhostNewsletters(platform);
      case 'newsletter-create':
        return handleGhostNewsletterCreate(platform, name);
      case 'newsletter-update':
        return handleGhostNewsletterUpdate(platform, id, status);
      case 'probe':
        return { ok: true, results: [{ platform, action: 'probe', ok: true, detail: `mock mode - no live ${platform} connection` }] };
      case 'validate':
        return { ok: true, results: [{ platform, action: 'validate', ok: true, detail: 'mock validate - media accepted' }] };
      case 'set-thumbnail':
        return { ok: true, results: [{ platform, action: 'set-thumbnail', ok: true, detail: 'mock cover applied' }] };
      // The three native-object cancel verbs the delete/unschedule cascades ride
      // (lib/writes.mjs cancelNative). Each honors the PENDPOST_MOCK_FAIL seam so a
      // test can drive the cancel-failure path (the plan row stays intact and the
      // engine returns engine_failure) with no live API - the same convention the
      // publish path uses.
      case 'delete': {
        const fail = mockFailFor(platform);
        if (fail) return { ok: false, error: fail.message, results: [{ platform, action: 'delete', ok: false, errorCode: fail.code, errorMessage: fail.message }] };
        return { ok: true, results: [{ platform, action: 'delete', ok: true, detail: 'mock object deleted' }] };
      }
      case 'delete-event': {
        const fail = mockFailFor(platform);
        if (fail) return { ok: false, error: fail.message, results: [{ platform, action: 'delete-event', ok: false, errorCode: fail.code, errorMessage: fail.message }] };
        return { ok: true, results: [{ platform, action: 'delete-event', ok: true, detail: 'mock guild event deleted' }] };
      }
      case 'unschedule': {
        const fail = mockFailFor(platform);
        if (fail) return { ok: false, error: fail.message, results: [{ platform, action: 'unschedule', ok: false, errorCode: fail.code, errorMessage: fail.message }] };
        return { ok: true, results: [{ platform, action: 'unschedule', ok: true, detail: 'mock scheduled object cancelled' }] };
      }
      case 'resolve':
        return planPath ? handleResolve(platform, planPath, only) : { ok: true, results: [] };
      case 'refresh':
        return { ok: true, results: [{ platform, action: 'refresh', ok: true, detail: 'mock token refreshed' }] };
      case 'profile':
        // Spec 28 review (MINOR-6): the shared mock case previously ignored --probe
        // and always returned a single X-flavored profile-update row, so offline
        // (mock-mode) probe-vs-apply was indistinguishable and needs_scope was
        // unexercisable for the 4 new lanes (mastodon/nostr/telegram/youtube). Honor
        // --probe (a distinct profile-probe tier row) and the actual lane, mirroring
        // the live engines' own probe/apply row shapes. A probe additionally honors
        // the SAME PENDPOST_MOCK_UNGRANTED convention every other P9 mock degrade
        // uses, so a missing/blocked write scope is exercisable offline too - the
        // shared lib/writes.mjs#profileUpdate must ride this ok:false row back
        // inside an ok:true envelope (never convert it into an error), which is
        // exactly what the needsScope/"Authorize profile edit" Studio badge needs.
        if (probe && mockUngranted(platform)) {
          return { ok: true, results: [{ platform, action: 'profile-probe', ok: false, tier: 'blocked', detail: `mock mode - PENDPOST_MOCK_UNGRANTED=${platform} (simulated missing profile-edit scope)` }] };
        }
        return {
          ok: true,
          results: [probe
            ? { platform, action: 'profile-probe', ok: true, tier: 'permitted', detail: `mock mode - no live ${platform} connection` }
            : { platform, action: 'profile-update', ok: true, detail: `mock profile updated (no live ${platform} call)` }],
        };
      case 'release':
        // Mock release: a mock native post always verifies live (no real
        // privacy/status), so a release is just a successful acknowledgement.
        return planPath ? handleRelease(platform, planPath, only) : { ok: true, results: [] };
      case 'verify':
        return planPath ? handleVerify(platform, planPath, only) : { ok: true, results: [] };
      case 'insights':
        return planPath ? handleInsights(platform, planPath, only) : { ok: true, results: [] };
      case 'presubmit':
        return planPath ? handlePresubmit(platform, planPath, only) : { ok: true, results: [] };
      case 'pin':
        return handlePin(platform, planPath, only, id, true);
      case 'unpin':
        return handlePin(platform, planPath, only, id, false);
      case 'follow':
        return handleFollow(platform, acct, true);
      case 'unfollow':
        return handleFollow(platform, acct, false);
      case 'relay-list-set':
        return handleRelayListSet(platform, relays);
      case 'list-set':
        return handleListSet(platform, kind, items);
      case 'list-get':
        return handleListGet(platform, kind);
      default: // schedule | publish-due | publish | fbreel
        if (!planPath) return { ok: false, error: `mock ${command}: --plan required`, results: [] };
        return handlePublish(platform, planPath, only);
    }
  } catch (err) {
    return { ok: false, error: `mock ${command} failed: ${String(err.message || err).slice(0, 200)}`, results: [] };
  }
}
