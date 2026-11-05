#!/usr/bin/env node
// test/also-story.test.mjs - "Also as story": one boolean on a plan post (alsoStory:true)
// makes the same post ALSO publish as a story on every story-capable lane in its
// platforms (Instagram, Facebook Page). The story is an extra TARGET of the one post:
// one row, one approval, one status.
//
// In-process against a stubbed global.fetch (the meta-fb-photo-posts precedent): no
// credentials, no network, fake ids. ffprobe/ffmpeg are stubbed through the engine's
// STORY_DEPS seam; a real-ffmpeg cut runs only where ffmpeg is installed. Covers:
//   1. IG reel + story: REELS then STORIES container, no caption on the story, ids, posted
//   2. IG image + story: the STORIES container fetches the same public image_url
//   3. FB video story (video_stories start/upload/finish) and FB photo story
//      (unpublished /photos + photo_stories), each after the main FB publish
//   4. a video over 59s is cut to a temp file, that cut is uploaded (never videoUrl),
//      and the temp file is removed; a failed cut is an honest failed attempt
//   5. a failed story is retried on the next run WITHOUT republishing the reel
//   5b. an unconfirmed FB story publish (timeout/5xx on photo_stories or the finish) is
//      never re-posted blind: marker, settle, Page stories check, adopt / re-finish / park;
//      a definitive 4xx clears the marker and retries normally
//   6. the write path and the checker refuse alsoStory where it cannot apply
//   7. an approved post without alsoStory keeps its exact content hash; flipping it
//      re-raises editedSinceApproval
//   8. the brand default posting.reelsAlsoStory applies only to NEW reels
//   9. cloudFiresPostFor is false for an alsoStory post until the cloud publishes stories; lanesOwed keeps owing meta
//      while a story is pending; the MCP schemas carry alsoStory
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-also-story-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans', 'st'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'st', path: 'data/plans/st/post-plan.json', active: true }] }));
// Facebook is deny-by-default: this workspace opts in.
const CONFIG = path.join(WS, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ platforms: { facebook: true } }));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'single.jpg'), JPG);
const VIDEO = Buffer.from('fake-video-bytes-of-the-full-reel');
fs.writeFileSync(path.join(WS, 'data', 'media', 'reel.mp4'), VIDEO);

const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });

const meta = await import('../scripts/meta-social.mjs');
const { RUN, STORY_DEPS } = meta;
const realDeps = { ...STORY_DEPS };

const planPath = path.join(WS, 'data', 'plans', 'st', 'post-plan.json');
const writePlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'st', timezone: 'UTC', posts }, null, 2));
const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);
const PAST = '2020-01-01T00:00:00Z';
const base = (over) => ({
  scheduledAt: PAST, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', caption: 'Neue Geige', ...over,
});

// ---- the fetch stub: records every call, answers by URL ----
let calls = [];
let script = null; // optional per-test override: (call) => response | undefined
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
const fieldsOf = (body) => {
  if (!body || typeof body.entries !== 'function' || Buffer.isBuffer(body)) return {};
  const o = {};
  for (const [k, v] of body.entries()) o[k] = (typeof v === 'string') ? v : { blob: true, name: v.name, size: v.size };
  return o;
};
let seq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { url: u.toString(), host: u.host, path: u.pathname, method: init.method || 'GET', fields: fieldsOf(init.body), bodySize: Buffer.isBuffer(init.body) ? init.body.length : null };
  calls.push(call);
  if (script) { const r = await script(call); if (r) return r; }
  if (call.method === 'HEAD') return { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) };
  if (call.host === 'rupload.facebook.com') return json({ success: true });
  if (call.path.endsWith('/222/media')) { seq += 1; return json({ id: `igc${seq}` }); }
  if (call.path.endsWith('/222/media_publish')) return json({ id: `igm_${call.fields.creation_id}` });
  if (/\/igc\d+$/.test(call.path)) return json({ status_code: 'FINISHED' });
  if (call.path.endsWith('/111/video_reels')) {
    return json(call.fields.upload_phase === 'start' ? { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/v1' } : { success: true });
  }
  if (call.path.endsWith('/v1') && call.method === 'GET') return json({ id: 'v1', status: { video_status: 'ready' } });
  if (call.path.endsWith('/111/video_stories')) {
    return json(call.fields.upload_phase === 'start' ? { video_id: 'sv1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/sv1' } : { success: true, post_id: '111_555' });
  }
  if (call.path.endsWith('/111/photos')) {
    seq += 1;
    return json(call.fields.published === 'true' ? { id: `ph${seq}`, post_id: `111_9${seq}` } : { id: `ph${seq}` });
  }
  if (call.path.endsWith('/111/photo_stories')) return json({ success: true, post_id: '111_666' });
  if (/\/111_\d+$/.test(call.path) && call.method === 'GET') return json({ id: call.path.split('/').pop(), permalink_url: 'https://www.facebook.com/111/posts/1' });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};
const reset = () => { calls = []; script = null; RUN.results.length = 0; RUN.blocked368 = false; Object.assign(STORY_DEPS, realDeps); };
const igContainers = () => calls.filter((c) => c.path === '/v24.0/222/media' && c.method === 'POST');
const shortVideo = () => { STORY_DEPS.probe = async () => ({ kind: 'video', durationSec: 30 }); };

try {
  // ===== 1. IG reel + story =====
  reset();
  shortVideo();
  writePlan([base({ id: 'r1', type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4', alsoStory: true, firstComment: 'hi' })]);
  await meta.cmdPublishDue({ plan: planPath });
  let cs = igContainers();
  ok(cs.length === 2 && cs[0].fields.media_type === 'REELS' && cs[1].fields.media_type === 'STORIES', 'IG reel+story: a REELS container, then a STORIES container');
  ok(cs[1].fields.caption === undefined && cs[1].fields.share_to_feed === undefined && cs[1].fields.thumb_offset === undefined, 'IG story container: no caption, share_to_feed or cover');
  ok(cs[1].fields.upload_type === 'resumable', 'IG story: the local video goes up by resumable upload');
  const igUploads = calls.filter((c) => c.host === 'rupload.facebook.com' && c.path.includes('/ig-api-upload/'));
  ok(igUploads.length === 2 && igUploads.every((c) => c.bodySize === VIDEO.length), 'IG reel+story: both rupload the full (short) render');
  let p = readPost('r1');
  ok(p.igMediaId === 'igm_igc1' && p.igStoryId === 'igm_igc2', `IG reel+story: igMediaId and igStoryId recorded (${p.igMediaId}, ${p.igStoryId})`);
  ok(p.status === 'posted', 'IG reel+story: posted once the reel AND the story are out');
  ok(p.attempts.some((a) => a.platform === 'instagram' && a.action === 'publish-story' && a.ok === true), 'IG story: a publish-story attempt is recorded');
  ok(RUN.results.some((r) => r.action === 'publish-story' && r.platform === 'instagram' && r.ok && r.id === 'igm_igc2'), 'IG story: an ok publish-story result row');
  ok(calls.filter((c) => c.path.endsWith('/comments')).length === 1, 'IG story: the first comment rides the reel only, never the story');

  // ===== 2. IG image + story =====
  reset();
  writePlan([base({ id: 'i1', type: 'image', platforms: ['instagram'], path: 'data/media/single.jpg', imageUrl: 'https://cdn.example/single.jpg', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  cs = igContainers();
  ok(cs.length === 2 && cs[0].fields.image_url === 'https://cdn.example/single.jpg' && cs[0].fields.media_type === undefined, 'IG image+story: the feed IMAGE container first');
  ok(cs[1].fields.media_type === 'STORIES' && cs[1].fields.image_url === 'https://cdn.example/single.jpg' && cs[1].fields.caption === undefined, 'IG image story: STORIES container from the same public image_url, no caption');
  ok(!calls.some((c) => c.host === 'rupload.facebook.com'), 'IG image story: nothing is uploaded (Meta fetches the URL)');
  p = readPost('i1');
  ok(p.igMediaId && p.igStoryId && p.status === 'posted', 'IG image+story: both ids, posted');

  // ===== 3a. FB reel + FB video story =====
  reset();
  shortVideo();
  writePlan([base({ id: 'f1', type: 'reel', platforms: ['facebook'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  const vs = calls.filter((c) => c.path === '/v24.0/111/video_stories');
  ok(vs.length === 2 && vs[0].fields.upload_phase === 'start' && vs[1].fields.upload_phase === 'finish' && vs[1].fields.video_id === 'sv1', 'FB video story: video_stories start, then finish with the video_id');
  const storyUp = calls.find((c) => c.url === 'https://rupload.facebook.com/video-upload/v24.0/sv1');
  ok(storyUp && storyUp.bodySize === VIDEO.length, 'FB video story: the bytes go to the upload_url start returned (shared rupload helper)');
  const reelIdx = calls.findIndex((c) => c.path === '/v24.0/111/video_reels' && c.fields.upload_phase === 'finish');
  ok(reelIdx >= 0 && reelIdx < calls.indexOf(vs[0]), 'FB video story: runs after the reel is published');
  p = readPost('f1');
  ok(p.fbReelId === 'v1' && p.fbStoryId === '111_555' && p.status === 'posted', `FB reel+story: fbReelId, fbStoryId (${p.fbStoryId}), posted`);

  // ===== 3b. FB photo + FB photo story =====
  reset();
  writePlan([base({ id: 'f2', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  const photos = calls.filter((c) => c.path === '/v24.0/111/photos');
  ok(photos.length === 2 && photos[0].fields.published === 'true' && photos[1].fields.published === 'false', 'FB photo story: the Page photo post, then an UNPUBLISHED photo upload for the story');
  ok(photos[1].fields.caption === undefined && photos[1].fields.source && photos[1].fields.source.blob, 'FB photo story: local bytes, no caption');
  const ps = calls.find((c) => c.path === '/v24.0/111/photo_stories');
  ok(ps && ps.fields.photo_id === `ph${seq}`, 'FB photo story: photo_stories with the unpublished photo id');
  p = readPost('f2');
  ok(p.fbPostId && p.fbStoryId === '111_666' && p.status === 'posted', 'FB photo+story: fbPostId, fbStoryId, posted');

  // ===== 3c. a type=video post on facebook: the story is the only FB target =====
  reset();
  shortVideo();
  writePlan([base({ id: 'f3', type: 'video', platforms: ['instagram', 'facebook'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('f3');
  ok(!calls.some((c) => c.path.endsWith('/video_reels')) && p.fbStoryId === '111_555' && p.igStoryId && p.status === 'posted', 'type=video: the FB story publishes on its own (no FB reel), plus the IG reel + story');

  // ===== 3d. facebook disabled by policy: no FB story =====
  reset();
  shortVideo();
  fs.writeFileSync(CONFIG, JSON.stringify({ platforms: { facebook: false } }));
  writePlan([base({ id: 'f4', type: 'reel', platforms: ['facebook'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(!calls.some((c) => c.path.endsWith('/video_stories') || c.path.endsWith('/video_reels')), 'a disabled Facebook gets neither the reel nor the story');
  fs.writeFileSync(CONFIG, JSON.stringify({ platforms: { facebook: true } }));

  // ===== 4. a video over 59s is cut; the cut is uploaded; the temp file goes =====
  reset();
  let cutArgs = null;
  STORY_DEPS.probe = async () => ({ kind: 'video', durationSec: 75 });
  STORY_DEPS.cut = async (src, dest, sec) => { cutArgs = { src, dest, sec }; fs.writeFileSync(dest, 'cut'); };
  writePlan([base({ id: 'c1', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/reel.mp4', alsoStory: true, videoUrl: 'https://cloud.example/full.mp4' })]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(cutArgs && cutArgs.sec === 59 && cutArgs.src.endsWith('reel.mp4') && cutArgs.dest.startsWith(os.tmpdir()), 'cut: a 75s video is cut to its first 59s into os.tmpdir()');
  cs = igContainers();
  ok(cs[0].fields.video_url === 'https://cloud.example/full.mp4' && cs[1].fields.media_type === 'STORIES' && cs[1].fields.video_url === undefined && cs[1].fields.upload_type === 'resumable', 'cut: the reel may use videoUrl, the story never does (that is the full file)');
  const igStoryUp = calls.find((c) => c.host === 'rupload.facebook.com' && c.path.endsWith(`/igc${seq}`));
  ok(igStoryUp && igStoryUp.bodySize === 3, 'cut: the IG story uploads the cut bytes');
  const fbStoryUp = calls.find((c) => c.url.endsWith('/video-upload/v24.0/sv1'));
  ok(fbStoryUp && fbStoryUp.bodySize === 3, 'cut: the FB story uploads the same cut bytes');
  ok(!fs.existsSync(cutArgs.dest), 'cut: the temp file is removed after the stories');
  ok(RUN.results.filter((r) => r.action === 'publish-story' && r.ok && r.cutToSec === 59).length === 2, 'cut: the story rows say the video was cut to 59s');
  ok(readPost('c1').status === 'posted', 'cut: posted');

  // a public copy of the cut (post.storyVideoUrl, which the pendpost cloud uploads and
  // injects): the IG story fetches it by video_url instead of the resumable rupload, which
  // can time out on a long video. The FB story still uploads the local cut.
  reset();
  STORY_DEPS.probe = async () => ({ kind: 'video', durationSec: 75 });
  STORY_DEPS.cut = async (src, dest) => { fs.writeFileSync(dest, 'cut'); };
  writePlan([base({ id: 'c3', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/reel.mp4', alsoStory: true, videoUrl: 'https://cloud.example/full.mp4', storyVideoUrl: 'https://cloud.example/cut59.mp4' })]);
  await meta.cmdPublishDue({ plan: planPath });
  cs = igContainers();
  ok(cs[1].fields.media_type === 'STORIES' && cs[1].fields.video_url === 'https://cloud.example/cut59.mp4' && cs[1].fields.upload_type === undefined, 'cut + storyVideoUrl: the IG story fetches the public cut by video_url');
  ok(!calls.some((c) => c.host === 'rupload.facebook.com' && c.path.includes('/ig-api-upload/')), 'cut + storyVideoUrl: nothing goes up by the IG rupload');
  ok(calls.some((c) => c.url.endsWith('/video-upload/v24.0/sv1') && c.bodySize === 3), 'cut + storyVideoUrl: the FB story still uploads the local cut');
  ok(readPost('c3').status === 'posted', 'cut + storyVideoUrl: posted');
  // storyVideoUrl never replaces the full video when nothing was cut
  reset();
  shortVideo();
  writePlan([base({ id: 'c4', type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4', alsoStory: true, videoUrl: 'https://cloud.example/full.mp4', storyVideoUrl: 'https://cloud.example/cut59.mp4' })]);
  await meta.cmdPublishDue({ plan: planPath });
  cs = igContainers();
  ok(cs[1].fields.video_url === 'https://cloud.example/full.mp4', 'short video: the story uses videoUrl, never the cut url');

  // a failed cut: an honest failed attempt per story target, the reel stands
  reset();
  STORY_DEPS.probe = async () => ({ kind: 'video', durationSec: 90 });
  STORY_DEPS.cut = async () => { throw new Error('cutVideo: ffmpeg is not installed'); };
  writePlan([base({ id: 'c2', type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('c2');
  ok(p.igMediaId && !p.igStoryId && p.status === 'planned', 'failed cut: the reel is out, the story is not, the post stays planned');
  ok(p.attempts.some((a) => a.action === 'publish-story' && a.ok === false && a.errorCode === 'story_cut_failed'), 'failed cut: a story_cut_failed attempt is recorded');

  // ===== 5. a failed story retries without republishing the reel =====
  reset();
  shortVideo();
  script = (call) => (call.path === '/v24.0/222/media' && call.fields.media_type === 'STORIES' ? json({ error: { message: 'temporarily unavailable', code: 2 } }, 503) : undefined);
  writePlan([base({ id: 'x1', type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('x1');
  ok(p.igMediaId && !p.igStoryId && p.status === 'planned', 'story failure: the reel is out, the post stays planned for the story');
  ok(RUN.results.some((r) => r.action === 'publish-story' && r.ok === false), 'story failure: a failed publish-story row');
  {
    const { loadPlanStore } = await import('../lib/plans.mjs');
    const st = loadPlanStore().campaigns.find((c) => c.id === 'st').posts.find((x) => x.id === 'x1');
    ok(st.derivedState !== 'fired-assumed' && st.derivedState !== 'posted', `story failure: the post does not read as handed off while its story is pending (derivedState ${st.derivedState})`);
  }
  reset();
  shortVideo();
  await meta.cmdPublishDue({ plan: planPath });
  cs = igContainers();
  ok(cs.length === 1 && cs[0].fields.media_type === 'STORIES', 'retry: only the STORIES container is created, the reel is NOT republished');
  ok(!calls.some((c) => c.path.endsWith('/comments')), 'retry: no second first comment');
  p = readPost('x1');
  ok(p.igStoryId && p.status === 'posted', 'retry: the story lands and the post turns posted');
  reset();
  await meta.cmdPublishDue({ plan: planPath });
  ok(calls.length === 0, 'after both: a re-run makes zero calls');

  // ===== 5b. an unconfirmed FB story publish is never re-posted blind (C1/C3s) =====
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const agePending = (id, min = 4) => {
    const planRaw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const post = planRaw.posts.find((x) => x.id === id);
    post.fbPublishPending.at = minutesAgo(min);
    fs.writeFileSync(planPath, JSON.stringify(planRaw, null, 2));
  };
  const storyFinishes = () => calls.filter((c) => c.path === '/v24.0/111/video_stories' && c.fields.upload_phase === 'finish');
  const storyStarts = () => calls.filter((c) => c.path === '/v24.0/111/video_stories' && c.fields.upload_phase === 'start');
  const photoStories = () => calls.filter((c) => c.path === '/v24.0/111/photo_stories');
  const storyChecks = () => calls.filter((c) => c.path === '/v24.0/111/stories' && c.method === 'GET');
  const fbStoryRow = () => RUN.results.find((x) => x.platform === 'facebook' && x.action === 'publish-story');
  const err5 = () => json({ error: { message: 'An unknown error occurred', code: 1 } }, 500);

  // a 5xx on the video_stories finish: the marker was written before the call, the outcome is pending
  reset();
  shortVideo();
  let finishMarker = null;
  script = (call) => {
    if (call.path === '/v24.0/111/video_stories' && call.fields.upload_phase === 'finish') { finishMarker = readPost('u1').fbPublishPending || null; return err5(); }
    return undefined;
  };
  writePlan([base({ id: 'u1', type: 'reel', platforms: ['facebook'], path: 'data/media/reel.mp4', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u1');
  ok(finishMarker && finishMarker.kind === 'story' && finishMarker.videoId === 'sv1', 'C1 story: the story marker (kind story, videoId) is on disk before the finish leaves');
  ok(p.fbReelId === 'v1' && !p.fbStoryId && p.status === 'planned' && p.fbPublishPending && p.fbPublishPending.videoId === 'sv1', 'C2 story: a finish 5xx keeps the marker, the reel stands, the post stays planned');
  ok(storyFinishes().length === 1 && fbStoryRow().errorCode === 'publish_pending_check' && fbStoryRow().retriable === true && fbStoryRow().fbPublishPending, 'C2 story: publish_pending_check, no same-run retry, the row carries the marker');
  ok(!p.publishHold, 'C2 story: pending is not a park');
  // the next run inside the settle time: it waits, publishes nothing
  reset();
  shortVideo();
  await meta.cmdPublishDue({ plan: planPath });
  ok(storyStarts().length === 0 && storyFinishes().length === 0 && storyChecks().length === 0 && !calls.some((c) => c.path.endsWith('/video_reels')), 'C2 story settle: no publish, no check, no reel');
  ok(fbStoryRow().errorCode === 'publish_pending_check' && readPost('u1').fbPublishPending, 'C2 story settle: still pending, marker kept');
  // after the settle time the Page's stories list it: adopted, never posted a second time
  agePending('u1');
  reset();
  shortVideo();
  script = (call) => (call.path === '/v24.0/111/stories' ? json({ data: [
    { post_id: '111_other', media_id: 'sv0', media_type: 'video', creation_time: minutesAgo(3), status: 'PUBLISHED' },
    { post_id: '111_777', media_id: 'sv1', media_type: 'video', creation_time: minutesAgo(4), status: 'PUBLISHED', url: 'https://www.facebook.com/stories/111/777' },
  ] }) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u1');
  ok(storyChecks().length === 1 && storyStarts().length === 0 && storyFinishes().length === 0, 'C3s: the Page stories are checked, nothing is published');
  ok(p.fbStoryId === '111_777' && !p.fbPublishPending && p.status === 'posted', `C3s: the story with our video id is adopted, marker cleared, posted (${p.fbStoryId})`);
  ok(fbStoryRow().ok && fbStoryRow().adopted === true && p.attempts.some((a) => a.action === 'publish-story' && a.adopted === true), 'C3s: an ok publish-story row and attempt marked adopted');

  // a video story not listed yet whose video is still a draft: the SAME video is finished again
  reset();
  shortVideo();
  writePlan([base({ id: 'u2', type: 'reel', platforms: ['facebook'], path: 'data/media/reel.mp4', alsoStory: true, fbReelId: 'v1', fbPublishPending: { at: minutesAgo(4), kind: 'story', videoId: 'sv9' } })]);
  let refinishMarker = null;
  script = (call) => {
    if (call.path === '/v24.0/111/stories') return json({ data: [] });
    if (call.path === '/v24.0/sv9' && call.method === 'GET') return json({ id: 'sv9', from: { id: '111' }, published: false, status: { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'not_started' } } });
    if (call.path === '/v24.0/111/video_stories' && call.fields.upload_phase === 'finish') { refinishMarker = readPost('u2').fbPublishPending || null; return undefined; }
    return undefined;
  };
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u2');
  ok(storyStarts().length === 0 && storyFinishes().length === 1 && storyFinishes()[0].fields.video_id === 'sv9', 'C3s draft: no new upload, the same video sv9 is finished again');
  ok(refinishMarker && refinishMarker.videoId === 'sv9' && Date.parse(refinishMarker.at) > Date.now() - 60_000, 'C3s draft: a fresh marker is written before the re-finish');
  ok(p.fbStoryId === '111_555' && !p.fbPublishPending && p.status === 'posted', 'C3s draft: the confirmed re-finish records the story and clears the marker');

  // a photo story timeout, then a Page check that fails: parked for the owner, never re-posted
  reset();
  script = (call) => (call.path === '/v24.0/111/photo_stories' ? Promise.reject(new TypeError('fetch failed')) : undefined);
  writePlan([base({ id: 'u3', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u3');
  ok(p.fbPostId && !p.fbStoryId && p.fbPublishPending && p.fbPublishPending.kind === 'story' && /^ph\d+$/.test(p.fbPublishPending.photoId), 'C2 photo story: a dropped connection keeps the marker with the photo id');
  ok(photoStories().length === 1 && fbStoryRow().errorCode === 'publish_pending_check', 'C2 photo story: pending, no same-run retry');
  agePending('u3');
  reset();
  script = (call) => (call.path === '/v24.0/111/stories' ? err5() : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u3');
  ok(storyChecks().length === 1 && photoStories().length === 0 && !calls.some((c) => c.path === '/v24.0/111/photos'), 'C3s failed check: no second photo upload, no second photo_stories');
  ok(fbStoryRow().errorCode === 'publish_unconfirmed' && fbStoryRow().retriable === false, 'C3s failed check: publish_unconfirmed, not retriable');
  ok(p.publishHold && p.publishHold.code === 'publish_unconfirmed' && p.publishHold.lane === 'facebook' && p.fbPublishPending && !p.fbStoryId, 'C3s failed check: parked on the first strike, the marker kept for the owner');
  reset();
  await meta.cmdPublishDue({ plan: planPath });
  ok(calls.length === 0, 'C3s parked: a later run makes zero calls');

  // a photo story the Page does not list after the settle time: published once, with a fresh marker
  reset();
  writePlan([base({ id: 'u4', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', alsoStory: true, fbPostId: '111_1', fbPublishPending: { at: minutesAgo(4), kind: 'story', photoId: 'ph_old' } })]);
  script = (call) => (call.path === '/v24.0/111/stories' ? json({ data: [{ post_id: '111_x', media_id: 'ph_else', creation_time: minutesAgo(10) }] }) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u4');
  ok(storyChecks().length === 1 && photoStories().length === 1 && p.fbStoryId === '111_666' && !p.fbPublishPending && p.status === 'posted', 'C3s no match: the story provably did not land, so it publishes once and clears the marker');

  // a marker of another kind is not the story's to resolve: parked, nothing published
  reset();
  writePlan([base({ id: 'u5', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', alsoStory: true, fbPostId: '111_1', fbPublishPending: { at: minutesAgo(4), kind: 'photo', caption: 'Neue Geige', photoCount: 1 } })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u5');
  ok(photoStories().length === 0 && storyChecks().length === 0 && p.publishHold && p.publishHold.code === 'publish_unconfirmed' && p.fbPublishPending.kind === 'photo', 'foreign marker: the story parks instead of overwriting another FB marker');

  // a definitive 4xx on photo_stories published nothing: the marker goes, the next run retries normally
  reset();
  script = (call) => (call.path === '/v24.0/111/photo_stories' ? json({ error: { message: 'Invalid parameter', code: 100 } }, 400) : undefined);
  writePlan([base({ id: 'u6', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', alsoStory: true })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u6');
  ok(fbStoryRow().errorCode === 100 && !p.fbPublishPending && !p.fbStoryId && !p.publishHold && p.status === 'planned', '4xx story: the normal failed row, the marker cleared, no park');
  reset();
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u6');
  ok(storyChecks().length === 0 && photoStories().length === 1 && p.fbStoryId === '111_666' && p.status === 'posted', '4xx story: the next run publishes again without a Page check');

  // a success:false answer is a verdict too: no marker left behind
  reset();
  shortVideo();
  script = (call) => (call.path === '/v24.0/111/video_stories' && call.fields.upload_phase === 'finish' ? json({ success: false }) : undefined);
  writePlan([base({ id: 'u7', type: 'reel', platforms: ['facebook'], path: 'data/media/reel.mp4', alsoStory: true, fbReelId: 'v1' })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('u7');
  ok(!p.fbPublishPending && !p.fbStoryId && fbStoryRow().ok === false && fbStoryRow().errorCode !== 'publish_pending_check', 'success:false story: a plain failure, the marker cleared');

  // a post without alsoStory is untouched by the story path
  reset();
  shortVideo();
  writePlan([base({ id: 'n1', type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4' })]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(igContainers().length === 1 && readPost('n1').status === 'posted' && !readPost('n1').igStoryId, 'no alsoStory: one REELS container, posted, no story');

  // ===== 6. the write path and the checker refuse alsoStory where it cannot apply =====
  const w = await import('../lib/writes.mjs');
  const { postRev, postContentHash, contentCanonical, loadPlanStore } = await import('../lib/plans.mjs');
  writePlan([]);
  const mk = (over) => ({ id: over.id, type: 'reel', platforms: ['instagram'], scheduledAt: '2099-01-01T10:00:00Z', caption: 'c', ...over });
  let r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'v1', type: 'carousel', mediaItems: [{ file: 'a.jpg' }, { file: 'b.jpg' }], alsoStory: true }) });
  ok(r.ok !== true && r.code === 'invalid_input' && /carousel/.test(r.message) && /reel, video or single image/.test(r.message), `refuse: a carousel cannot also be a story (${r.message})`);
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'v2', type: 'text', platforms: ['instagram', 'linkedin'], alsoStory: true }) });
  ok(r.ok !== true && r.code === 'invalid_input' && /text post/.test(r.message), 'refuse: a text post cannot also be a story');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'v3', platforms: ['youtube'], alsoStory: true }) });
  ok(r.ok !== true && r.code === 'invalid_input' && /only on Instagram and Facebook Page/.test(r.message), 'refuse: a youtube-only reel has no story lane');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'v4', alsoStory: 'yes' }) });
  ok(r.ok !== true && r.code === 'invalid_input' && /alsoStory must be a boolean/.test(r.message), 'refuse: a non-boolean alsoStory');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'v5', type: 'story', path: 'data/media/single.jpg' }) });
  ok(r.ok !== true && r.code === 'invalid_input' && /story post needs a video/.test(r.message) && /alsoStory/.test(r.message), 'refuse: an image file on an Instagram story-type post');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'ok1', platforms: ['instagram', 'youtube'], alsoStory: true, path: 'data/media/reel.mp4' }) });
  ok(r.ok === true && r.post.alsoStory === true, 'accept: a reel on instagram+youtube with alsoStory');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'ok2', type: 'story', path: 'data/media/reel.mp4' }) });
  ok(r.ok === true, 'accept: a video on an Instagram story-type post');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'ok3', alsoStory: false, path: 'data/media/reel.mp4' }) });
  ok(r.ok === true && !('alsoStory' in readPost('ok3')), 'alsoStory:false is not persisted (absence = off)');
  // update: judged on the resulting post
  let raw = readPost('ok1');
  r = await w.updatePost({ campaign: 'st', postId: 'ok1', ifRev: postRev(raw), actor: 'owner', fields: { platforms: ['youtube'] } });
  ok(r.ok !== true && r.code === 'invalid_input' && /only on Instagram and Facebook Page/.test(r.message), 'update refuse: dropping the last story lane while alsoStory is on');
  r = await w.updatePost({ campaign: 'st', postId: 'ok1', ifRev: postRev(raw), actor: 'owner', fields: { type: 'carousel', mediaItems: [{ file: 'a.jpg' }, { file: 'b.jpg' }] } });
  ok(r.ok !== true && r.code === 'invalid_input', 'update refuse: switching an alsoStory post to a carousel');
  r = await w.updatePost({ campaign: 'st', postId: 'ok1', ifRev: postRev(raw), actor: 'owner', fields: { platforms: ['youtube'], alsoStory: null } });
  ok(r.ok === true && !('alsoStory' in readPost('ok1')), 'update accept: dropping the lane together with alsoStory:null');
  // the checker blocks a hand-edited plan
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.posts.push({ id: 'hand1', type: 'carousel', platforms: ['instagram', 'linkedin'], scheduledAt: '2099-01-01T10:00:00Z', caption: 'c', mediaItems: [{ file: 'a.jpg' }, { file: 'b.jpg' }], alsoStory: true, status: 'planned', approval: 'draft' });
  plan.posts.push({ id: 'hand2', type: 'reel', platforms: ['youtube'], scheduledAt: '2099-01-01T10:00:00Z', caption: 'c', title: 't', description: 'd', path: 'data/media/reel.mp4', alsoStory: true, status: 'planned', approval: 'draft' });
  plan.posts.push({ id: 'hand3', type: 'story', platforms: ['instagram'], scheduledAt: '2099-01-01T10:00:00Z', path: 'data/media/single.jpg', status: 'planned', approval: 'draft' });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  let v = await w.platformValidate({ campaign: 'st', postId: 'hand1' });
  ok(v.platforms.instagram.problemCodes.some((c) => c && c.code === 'validate.storyNotEligible') && !v.platforms.linkedin.problemCodes.some((c) => c && /story/.test(c.code)), 'checker: a carousel with alsoStory blocks the story lane only');
  v = await w.platformValidate({ campaign: 'st', postId: 'hand2' });
  ok(v.platforms.youtube.problemCodes.some((c) => c && c.code === 'validate.storyNoLane'), 'checker: alsoStory with no story lane blocks the lane it has');
  v = await w.platformValidate({ campaign: 'st', postId: 'hand3' });
  ok(v.platforms.instagram.problemCodes.some((c) => c && c.code === 'validate.storyNeedsVideo' && c.fix === 'edit'), 'checker: an image on an Instagram story-type post blocks, fixed in the editor');
  v = await w.platformValidate({ campaign: 'st', postId: 'ok3' });
  ok(!v.platforms.instagram.problemCodes.some((c) => c && /story/.test(c.code)), 'checker: a reel without alsoStory has no story problem');
  const dto = (id) => loadPlanStore().campaigns.find((c) => c.id === 'st').posts.find((x) => x.id === id);
  ok(dto('hand2').alsoStory === true && Array.isArray(dto('hand2').storyLanes) && dto('hand2').storyLanes.length === 0, 'DTO: alsoStory surfaced, storyLanes [] when no story lane');
  ok(dto('ok3').alsoStory === false && dto('ok3').ids.igStoryId === null && dto('ok3').ids.fbStoryId === null, 'DTO: alsoStory false, story ids null by default');

  // ===== 7. content hash: legacy posts unchanged, the flag is content =====
  const legacy = { id: 'L', type: 'reel', platforms: ['instagram'], caption: 'c', path: 'data/media/reel.mp4' };
  ok(!('alsoStory' in contentCanonical(legacy)), 'hash: alsoStory is left out of the canonical bytes while unset');
  ok(postContentHash({ ...legacy, alsoStory: false }) === postContentHash(legacy) && postContentHash({ ...legacy, alsoStory: null }) === postContentHash(legacy), 'hash: false and null hash like unset');
  ok(postContentHash({ ...legacy, alsoStory: true }) !== postContentHash(legacy), 'hash: alsoStory:true changes the hash');
  const appr = { ...legacy, id: 'ap1', scheduledAt: '2099-01-01T10:00:00Z', status: 'planned', approval: 'approved', approvalBy: 'owner', approvedContentHash: postContentHash(legacy) };
  const plan2 = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan2.posts.push(appr);
  fs.writeFileSync(planPath, JSON.stringify(plan2, null, 2));
  ok(postContentHash(readPost('ap1')) === readPost('ap1').approvedContentHash, 'hash: an approved post without alsoStory still matches its stamped hash');
  r = await w.updatePost({ campaign: 'st', postId: 'ap1', ifRev: postRev(readPost('ap1')), actor: 'owner', fields: { alsoStory: true } });
  ok(r.ok === true && readPost('ap1').editedSinceApproval === true, 'hash: turning alsoStory on for an approved post needs re-approval');
  r = await w.updatePost({ campaign: 'st', postId: 'ap1', ifRev: r.rev, actor: 'owner', fields: { alsoStory: null } });
  ok(r.ok === true && !readPost('ap1').editedSinceApproval, 'hash: turning it back off restores the approved content');

  // ===== 8. the brand default applies to NEW reels only =====
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  let cfg = getConfig();
  r = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { reelsAlsoStory: 'yes' } } });
  ok(r.ok !== true && /reelsAlsoStory must be a boolean/.test(r.message), 'config: reelsAlsoStory must be a boolean');
  cfg = getConfig();
  r = setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { reelsAlsoStory: true } } });
  ok(r.ok === true, 'config: an agent may set posting.reelsAlsoStory (not owner-gated)');
  const before = readPost('ok3');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'bd1', path: 'data/media/reel.mp4' }) });
  ok(r.ok === true && readPost('bd1').alsoStory === true, 'default: a new instagram reel gets alsoStory:true');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'bd2', alsoStory: false, path: 'data/media/reel.mp4' }) });
  ok(r.ok === true && !('alsoStory' in readPost('bd2')), 'default: an explicit alsoStory:false wins');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'bd3', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg' }) });
  ok(r.ok === true && !('alsoStory' in readPost('bd3')), 'default: reels only (an image post is untouched)');
  r = await w.createPost({ campaign: 'st', actor: 'agent:test', post: mk({ id: 'bd4', platforms: ['youtube'], title: 't', path: 'data/media/reel.mp4' }) });
  ok(r.ok === true && !('alsoStory' in readPost('bd4')), 'default: a reel with no story lane is untouched (and not refused)');
  ok(JSON.stringify(readPost('ok3')) === JSON.stringify(before), 'default: an existing reel is never changed retroactively');
  cfg = getConfig();
  setConfig({ ifRev: cfg.rev, actor: 'agent:test', set: { posting: { reelsAlsoStory: false } } });

  // ===== 9. cloud, lanesOwed, presubmit, MCP =====
  const { cloudFiresPostFor, storyLanesFor } = await import('../lib/capabilities.mjs');
  ok(cloudFiresPostFor({ type: 'reel', platforms: ['instagram'] }) === true && cloudFiresPostFor({ type: 'reel', platforms: ['instagram'], alsoStory: true }) === false, 'cloud: an alsoStory post stays local while the cloud has not said it publishes stories');
  ok(cloudFiresPostFor({ type: 'reel', platforms: ['instagram'], alsoStory: true }, false, true) === true, 'cloud: an alsoStory reel cloud-fires once the cloud publishes stories');
  ok(cloudFiresPostFor({ type: 'image', platforms: ['instagram'], alsoStory: true }, false, true) === false, 'cloud: the IG feed-image rule still applies to an alsoStory image');
  ok(storyLanesFor({ type: 'reel', platforms: ['instagram', 'facebook', 'youtube'], alsoStory: true }).join() === 'instagram,facebook', 'storyLanesFor: only instagram and facebook');
  const { lanesOwed } = await import('../lib/scheduler.mjs');
  const owedPost = { type: 'reel', platforms: ['instagram'], alsoStory: true, ids: { igMediaId: 'm1', igStoryId: null } };
  ok(lanesOwed(owedPost).includes('meta'), 'lanesOwed: the meta lane is still owed while the story is pending');
  ok(!lanesOwed({ ...owedPost, ids: { igMediaId: 'm1', igStoryId: 's1' } }).includes('meta'), 'lanesOwed: not owed once the story is out');
  ok(!lanesOwed({ ...owedPost, alsoStory: false }).includes('meta'), 'lanesOwed: a post without alsoStory is unchanged');
  const pre = await w.presubmitCheck({ campaign: 'st', postId: 'bd1' });
  ok(pre.ok === true && !pre.warnings, 'presubmit: no cloud warning when the brand is not always-on');
  const { TOOLS } = await import('../lib/mcp.mjs');
  const tool = (n) => TOOLS.find((t) => t.name === n);
  ok(tool('plan_create_post').inputSchema.properties.post.properties.alsoStory.type === 'boolean', 'MCP: plan_create_post carries alsoStory');
  ok(tool('plan_update_post').inputSchema.properties.fields.properties.alsoStory.type === 'boolean' && /alsoStory/.test(tool('plan_update_post').description), 'MCP: plan_update_post carries alsoStory');

  // ===== 10. the mock driver mirrors the story targets =====
  process.env.PENDPOST_MODE = 'mock';
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  writePlan([base({ id: 'm1', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/reel.mp4', alsoStory: true })]);
  const env = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath });
  p = readPost('m1');
  ok(p.igStoryId && p.fbStoryId && p.status === 'posted' && (env.results || []).filter((x) => x.action === 'publish-story' && x.ok).length === 2, 'mock: both story ids minted and the post converges to posted');
  delete process.env.PENDPOST_MODE;

  // ===== 11. the real cutVideo (only where ffmpeg is installed) =====
  let ff = null;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ff = 'ffmpeg'; } catch { /* absent */ }
  if (ff) {
    const src = path.join(WS, 'long.mp4');
    execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=96x160:rate=10', '-c:v', 'libx264', '-g', '10', src]);
    const { cutVideo, probeMedia } = await import('../lib/assets.mjs');
    const out = path.join(WS, 'cut', 'short.mp4');
    const res = await cutVideo(src, out, 2);
    const probe = await probeMedia(out);
    ok(res.ok && fs.existsSync(out) && probe.durationSec > 0 && probe.durationSec < 3, `cutVideo: a 6s video cut to ~2s (got ${probe.durationSec}s)`);
    await assert.rejects(() => cutVideo(src, out, 0), /positive number/);
    ok(true, 'cutVideo: refuses a non-positive length');
  } else {
    console.log('  ~ skip - ffmpeg absent: the real cutVideo run is not exercised');
  }

  // ===== 12. a post the cloud acknowledged BEFORE alsoStory was switched on =====
  // The cloud's vendored engine has no story targets: it fires the reel only. Reconcile and
  // the consumed-claim path must leave the post open while the story is owed, and the
  // story is then local work (no grace, no claim). Mock mode + a stubbed cloud.
  process.env.PENDPOST_MODE = 'mock';
  fs.appendFileSync(envPath(), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
  const cloud = await import('../lib/cloud-client.mjs');
  const { runDueExclusive } = await import('../lib/scheduler.mjs');
  const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
  const { activeClientId } = await import('../lib/multi-client.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const CLIENT = activeClientId();
  const FIRED_AT = '2026-11-05T08:00:00.000Z';
  let cloudResults = [];
  const claimCalls = [];
  const claimAnswer = {}; // postId -> claim verdict; default: the cloud holds a live lease
  const graphFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const cj = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/publish-claim') && method === 'POST') {
      const body = JSON.parse(init.body);
      claimCalls.push(body);
      const postIdOf = String(body.claimKey).split(':')[2];
      return cj(claimAnswer[postIdOf] || { granted: false, consumed: false, externalId: null, holder: 'cloud' });
    }
    if (url.endsWith('/v1/health')) return cj({ ok: true });
    if (url.endsWith('/v1/subscription')) return cj({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return cj({ alreadyPresent: true });
    if (url.endsWith('/v1/sync/push') && method === 'POST') {
      const body = JSON.parse(init.body);
      return cj({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
    }
    if (url.includes('/v1/sync/results')) return cj({ results: cloudResults });
    if (url.includes('/v1/vault/') && method === 'PUT') return cj({ ok: true });
    if (url.includes('/v1/brands') && method === 'PUT') return cj({ ok: true });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return cj({ requeued: [], skipped: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
  const doneReel = (postId, id) => ({
    jobId: `${CLIENT}:st:${postId}:meta`, clientId: CLIENT, campaign: 'st', postId, lane: 'meta', state: 'done',
    firedAt: FIRED_AT, refusedCode: null, results: [{ platform: 'instagram', id, action: 'publish', ok: true }],
  });
  const reelAttempts = (id) => (readPost(id).attempts || []).filter((a) => a.platform === 'instagram' && a.action === 'publish');
  const claimsFor = (id) => claimCalls.filter((b) => String(b.claimKey).split(':')[2] === id);
  const overdueIssue = (id) => (cloud.clientSyncStatus().issues || []).some((i) => i.code === 'overdue_unpublished' && i.postId === id);

  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  // Pushed and acknowledged while alsoStory was still off (the real ack path)...
  const reel = (id) => base({ id, type: 'reel', platforms: ['instagram'], path: 'data/media/reel.mp4', caption: `cloud reel ${id}` });
  writePlan([reel('ca1'), reel('ca2'), reel('cn1')]);
  await cloud.pushApprovedJobs();
  let st = loadState();
  ok(['ca1', 'ca2', 'cn1'].every((id) => st.cloudAccepted && st.cloudAccepted[`st:${id}:meta`]), 'cloud-acked: the cloud acknowledged all three reels before alsoStory');
  // ...then the owner switched alsoStory on (ca1, ca2). The cloud keeps its reel-only jobs.
  writePlan([{ ...readPost('ca1'), alsoStory: true }, { ...readPost('ca2'), alsoStory: true }, readPost('cn1')]);

  // (c) before the cloud fired: the fresh ack anchors the cloud's grace, so local does not
  // fire the reel (unchanged cloud path) and does not even ask for the claim yet.
  let tick = await runDueExclusive('scheduler');
  ok(!readPost('ca1').igMediaId && readPost('ca1').status !== 'posted' && reelAttempts('ca1').length === 0, '(c) cloud-acked alsoStory reel inside the grace: local does not fire the reel');
  ok(tick.ran.some((r) => r.postId === 'ca1' && r.lane === 'meta' && r.errorCode === 'cloud_held'), '(c) the meta lane is reported cloud_held (the cloud owns the reel)');
  ok(claimsFor('ca1').length === 0, '(c) no publish claim inside the grace');
  ok(overdueIssue('ca1'), 'status: a cloud-acked alsoStory reel still owed to the cloud and past due counts as overdue (reconcile has a reason to run)');

  // (a) the cloud fired the reel: reconcile patches igMediaId but the story is owed, so the
  // post stays open (patched_partial). (e) the post without alsoStory reconciles as before.
  cloudResults = [doneReel('ca1', 'ig_cloud_ca1'), doneReel('cn1', 'ig_cloud_cn1')];
  const rec = await cloud.reconcileCloudResults({});
  let p1 = readPost('ca1');
  ok(p1.igMediaId === 'ig_cloud_ca1' && !p1.igStoryId, '(a) reconcile patched the reel id from the cloud');
  ok(p1.status !== 'posted' && !p1.postedAt, '(a) the post stays open: the story is still owed');
  ok(rec.skipped.some((s) => s.postId === 'ca1' && s.outcome === 'patched_partial') && !rec.patched.some((x) => x.postId === 'ca1'), '(a) reconcile reports patched_partial for it');
  const n1 = readPost('cn1');
  ok(n1.igMediaId === 'ig_cloud_cn1' && n1.status === 'posted' && n1.postedAt === FIRED_AT, '(e) a post without alsoStory: id patched, posted at the cloud fire time');
  ok(rec.patched.some((x) => x.postId === 'cn1' && x.outcome === 'patched'), '(e) reconcile reports it patched, exactly as before');
  ok(!overdueIssue('ca1'), 'status: a cloud-acked alsoStory post with only its story pending is not a cloud overdue');
  const sync = cloud.clientSyncStatus();
  ok(sync.overdueCount === 1 && overdueIssue('ca2') && !(sync.issues || []).some((i) => i.postId === 'ca1'), 'status: only ca2 (reel still the cloud\'s) is overdue; the story-only post raises no cloud issue at all');

  // (b) the next local tick fires the story at once (the ack is still inside the cloud's
  // grace: proof there is no grace for it), with no claim, and only the story publishes.
  tick = await runDueExclusive('scheduler');
  p1 = readPost('ca1');
  ok(p1.igStoryId && p1.igMediaId === 'ig_cloud_ca1', '(b) the next tick published the story; the cloud reel id is untouched');
  ok(reelAttempts('ca1').length === 0 && (p1.attempts || []).some((a) => a.platform === 'instagram' && a.action === 'publish-story' && a.ok), '(b) the engine published the story only, never the reel');
  ok(p1.status === 'posted', '(b) the post is posted once the story is out');
  ok(claimsFor('ca1').length === 0 && !tick.ran.some((r) => r.postId === 'ca1' && (r.errorCode === 'cloud_held' || r.errorCode === 'cloud_claim_wait')), '(b) no grace, no claim, no hold for the story-only lane');
  ok(!readPost('ca2').igMediaId && reelAttempts('ca2').length === 0, '(b) the other acked post (reel not fired yet) is still left to the cloud');

  // (d) the claim path: past the grace the backstop asks for the claim, and the cloud says
  // it already fired (consumed). The claim names the reel only, never whether that run
  // published the story too (a cloud with story support may have), so it records nothing:
  // the lane stands down until the job's own result arrives through reconcile. Recording
  // the reel id from the claim would let the next tick fire the story locally on the claim's
  // word alone, a second story whenever the cloud's run had published one.
  st = loadState();
  st.cloudAccepted['st:ca2:meta'].at = '2020-01-01T00:00:00.000Z';
  saveState();
  claimAnswer.ca2 = { granted: false, consumed: true, externalId: 'ig_claim_ca2', externalPlatform: 'instagram', holder: 'cloud' };
  tick = await runDueExclusive('scheduler');
  let p2 = readPost('ca2');
  ok(claimsFor('ca2').length === 1, '(d) past the grace the backstop asked for the claim');
  ok(!p2.igMediaId && p2.status !== 'posted' && !p2.igStoryId, '(d) a consumed claim on an alsoStory post records no id and leaves the post open');
  ok(reelAttempts('ca2').length === 0, '(d) the reel was not fired locally');
  const direct = await cloud.markPostedFromClaim({ campaign: 'st', postId: 'ca2', platforms: ['instagram'], externalId: 'ig_claim_ca2', platform: 'instagram' });
  ok(direct.ok === true && direct.outcome === 'awaiting_cloud_result' && !readPost('ca2').igMediaId, '(d) markPostedFromClaim waits for the cloud result on a post with its story owed');
  tick = await runDueExclusive('scheduler');
  p2 = readPost('ca2');
  ok(!p2.igStoryId && claimsFor('ca2').length === 2, '(d) while the result is out, the next tick asks again and stands down: no story on the claim\'s word');
  // The job's result arrives: the reel only (it was acknowledged before alsoStory). The story
  // is now provably local work, and the same tick publishes just the story.
  cloudResults = [...cloudResults, doneReel('ca2', 'ig_cloud_ca2')];
  tick = await runDueExclusive('scheduler');
  p2 = readPost('ca2');
  ok(p2.igMediaId === 'ig_cloud_ca2' && p2.igStoryId && p2.status === 'posted' && reelAttempts('ca2').length === 0, '(d) once reconcile brings the reel-only result, only the story publishes locally and the post is posted');
  ok(claimsFor('ca2').length === 2, '(d) the story-only lane needs no further claim');

  globalThis.fetch = graphFetch;
  delete process.env.PENDPOST_MODE;

  console.log(`\n[also-story] OK - alsoStory engine, validation, default, cloud and MCP (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
