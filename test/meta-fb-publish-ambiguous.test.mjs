#!/usr/bin/env node
// test/meta-fb-publish-ambiguous.test.mjs - the unconfirmed-publish contract for the Facebook
// half of the meta engine (issue #7; owner decision 2026-10-14; critic round 1, contract
// C1-C3 shared with the pendpost-cloud port).
//
//   C1 intent marker BEFORE the call: right before a publishing call (a single photo's
//      published=true /photos, an album's final /feed, a reel's finish) the engine writes
//      fbPublishPending = { at, kind, caption, photoCount | videoId } to the plan on disk, and
//      clears it only on a confirmed outcome. A crash mid-call therefore leaves it behind.
//   C2 no same-run retry, a settle time, the marker decides: an ambiguous failure returns
//      publish_pending_check (transient) and publishes nothing more this run. A later run
//      waits until 3 minutes after the marker, then checks the Page against the MARKER
//      (caption, kind, photo count), paging /posts back to the marker time: one strict own
//      match adopts, no match publishes (with a fresh marker), a failed or ambiguous check
//      parks as publish_unconfirmed.
//   C3 a reel whose finish failed ambiguously: its video existing and not in an error state
//      counts as accepted (adopted, never re-finished or re-uploaded).
//   Security (review of 0dfe9e5f): only the Page's own posts, never on an empty caption,
//   the attachment shape must match, exactly one candidate.
//
// In-process, stubbed global.fetch, fake ids, no network (the meta-fb-photo-posts harness).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-ambiguous-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans', 'fb'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
for (const f of ['a.jpg', 'b.jpg', 'single.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), JPG);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from('fake-video'));
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });

const meta = await import('../scripts/meta-social.mjs');
const { isTransientFailure, isTerminalRefusal } = await import('../lib/publish-hold.mjs');
const { RUN } = meta;

const planPath = path.join(WS, 'data', 'plans', 'fb', 'post-plan.json');
const writePlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'fb', timezone: 'UTC', posts }, null, 2));
const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);
const base = (over) => ({ scheduledAt: '2020-01-01T00:00:00Z', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', caption: 'Neue Geige', ...over });
const album = (id, extra = {}) => base({ id, type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }], ...extra });
const single = (id, extra = {}) => base({ id, type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', ...extra });
const reel = (id, extra = {}) => base({ id, type: 'reel', platforms: ['facebook'], path: 'data/media/clip.mp4', ...extra });
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const marker = (kind, extra = {}) => ({ at: minutesAgo(4), kind, caption: 'Neue Geige', ...(kind === 'reel' ? {} : { photoCount: kind === 'album' ? 2 : 1 }), ...extra });

let calls = [];
let script = null;
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
const err5 = () => json({ error: { message: 'An unexpected error has occurred. Please retry your request later.', type: 'OAuthException', code: 2, is_transient: true } }, 500);
const fieldsOf = (body) => {
  if (!body || typeof body.entries !== 'function') return {};
  const o = {};
  for (const [k, v] of body.entries()) o[k] = typeof v === 'string' ? v : { blob: true };
  return o;
};
let seq = 0;
const iso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { path: u.pathname, method: init.method || 'GET', fields: fieldsOf(init.body), query: Object.fromEntries(u.searchParams) };
  calls.push(call);
  if (script) { const r = await script(call); if (r) return r; }
  if (call.path === '/v24.0/111/photos') { seq += 1; return json(call.fields.published === 'true' ? { id: `ph${seq}`, post_id: `111_9${seq}` } : { id: `ph${seq}` }); }
  if (call.path === '/v24.0/111/feed' && call.method === 'POST') return json({ id: '111_777' });
  if (call.path === '/v24.0/111/posts' && call.method === 'GET') return json({ data: [] });
  if (/\/111_\d+$/.test(call.path)) return json({ permalink_url: `https://www.facebook.com/111/posts/${call.path.split('_').pop()}` });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};
const reset = () => { calls = []; script = null; RUN.results.length = 0; RUN.blocked368 = false; };
const feedPosts = () => calls.filter((c) => c.path === '/v24.0/111/feed' && c.method === 'POST');
const pageChecks = () => calls.filter((c) => c.path === '/v24.0/111/posts' && c.method === 'GET');
const publishCalls = () => calls.filter((c) => c.method === 'POST');
const fbRow = () => RUN.results.find((r) => r.platform === 'facebook');
const own = (id, shape, extra = {}) => ({
  id, message: 'Neue Geige', created_time: iso(new Date(Date.now() - 3 * 60_000)), from: { id: '111' },
  attachments: { data: [shape === 'album' ? { type: 'album', subattachments: { data: [{ type: 'photo' }, { type: 'photo' }] } } : { type: 'photo' }] },
  ...extra,
});
const pageAnswers = (posts) => (c) => (c.path === '/v24.0/111/posts' && c.method === 'GET' ? json({ data: posts }) : undefined);

try {
  // ---- C1: the marker is on disk BEFORE the publishing call, and a crash leaves it ----
  for (const [kind, post, isPublishCall] of [
    ['album', album('k1'), (c) => c.path === '/v24.0/111/feed' && c.method === 'POST'],
    ['photo', single('k2'), (c) => c.path === '/v24.0/111/photos' && c.fields.published === 'true'],
  ]) {
    reset();
    writePlan([post]);
    let atCall = null;
    script = (c) => {
      if (isPublishCall(c)) { atCall = readPost(post.id).fbPublishPending || null; throw new Error('the process was killed mid-call'); }
      return undefined;
    };
    await meta.cmdPublishDue({ plan: planPath });
    ok(atCall && atCall.kind === kind && atCall.caption === 'Neue Geige' && atCall.photoCount === (kind === 'album' ? 2 : 1) && Date.parse(atCall.at),
      `C1 ${kind}: the intent marker is on disk when the publishing call leaves (${JSON.stringify(atCall)})`);
    const after = readPost(post.id);
    ok(after.fbPublishPending && after.fbPublishPending.at === atCall.at && !after.fbPostId, `C1 ${kind}: a crash mid-call leaves the marker behind, nothing adopted`);
    ok(fbRow() && fbRow().errorCode === 'publish_pending_check', `C1 ${kind}: an unknown outcome is publish_pending_check`);
  }

  // ---- C2: a 5xx never re-publishes in the same run ----
  reset();
  writePlan([album('a1')]);
  script = (c) => (c.path === '/v24.0/111/feed' && c.method === 'POST' ? err5() : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  let p = readPost('a1');
  ok(feedPosts().length === 1 && pageChecks().length === 0, 'C2: a 5xx on /feed makes ONE publish call and no same-run check or retry');
  ok(fbRow().errorCode === 'publish_pending_check' && isTransientFailure({ ok: false, errorCode: fbRow().errorCode, errorMessage: fbRow().errorMessage }), 'C2: publish_pending_check, transient (a later tick may try)');
  ok(!isTerminalRefusal({ ok: false, errorCode: fbRow().errorCode, errorMessage: fbRow().errorMessage }) && !p.publishHold, 'C2: not parked');
  ok(p.fbPublishPending && p.fbPublishPending.kind === 'album', 'C2: the marker stays for the next run');

  // ---- C2: the settle time ----
  reset();
  writePlan([album('a2', { fbPublishPending: marker('album', { at: minutesAgo(1) }) })]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(calls.length === 0, 'C2 settle: one minute after the attempt nothing is called at all (no check, no publish)');
  ok(fbRow() && fbRow().errorCode === 'publish_pending_check' && readPost('a2').fbPublishPending, 'C2 settle: it reports pending and keeps the marker');

  // ---- C2: after the settle, paging past 25 to the match ----
  reset();
  writePlan([album('a3', { fbPublishPending: marker('album') })]);
  const filler = Array.from({ length: 25 }, (_, i) => own(`111_10${i}`, 'album', { message: `anderer Beitrag ${i}`, created_time: iso(new Date(Date.now() - 60_000)) }));
  script = (c) => {
    if (c.path === '/v24.0/111/posts' && c.method === 'GET') {
      return c.query.after === 'CUR2'
        ? json({ data: [own('111_555', 'album', { permalink_url: 'https://www.facebook.com/111/posts/555' })] })
        : json({ data: filler, paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/v24.0/111/posts?after=CUR2' } });
    }
    return undefined;
  };
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('a3');
  ok(pageChecks().length === 2 && pageChecks()[1].query.after === 'CUR2', 'C2 paging: the check pages /posts past the first 25');
  ok(/from/.test(pageChecks()[0].query.fields) && /attachments/.test(pageChecks()[0].query.fields), 'C2 paging: it reads author and attachments');
  ok(p.fbPostId === '111_555' && !p.fbPublishPending && publishCalls().length === 0, 'C2 paging: the match on page two is adopted, nothing published');
  ok(fbRow().ok === true && fbRow().adopted === true && fbRow().permalink === 'https://www.facebook.com/111/posts/555', 'C2 paging: an ok adopted row with the permalink (receipt flow)');

  // ---- C2: the MARKER's caption decides, not the current post ----
  reset();
  writePlan([album('a4', { caption: 'Nach dem Versuch bearbeitet', fbPublishPending: marker('album') })]);
  script = pageAnswers([own('111_556', 'album')]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(readPost('a4').fbPostId === '111_556' && publishCalls().length === 0, 'C2 marker: a caption edited after the attempt still matches the post the attempt made');

  // ---- C2: no match -> publish, with a fresh marker first ----
  reset();
  const oldAt = minutesAgo(10);
  writePlan([album('a5', { fbPublishPending: marker('album', { at: oldAt }) })]);
  let freshAt = null;
  script = (c) => {
    if (c.path === '/v24.0/111/feed' && c.method === 'POST') { freshAt = (readPost('a5').fbPublishPending || {}).at || null; return undefined; }
    return undefined;
  };
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('a5');
  ok(pageChecks().length >= 1 && feedPosts().length === 1, 'C2 no match: checked, then published once');
  ok(freshAt && Date.parse(freshAt) > Date.parse(oldAt), 'C2 no match: a FRESH marker is on disk before the new publishing call');
  ok(p.fbPostId === '111_777' && !p.fbPublishPending, 'C2 no match: the confirmed publish clears the marker');

  // ---- C2: a failed check parks, owner decides ----
  reset();
  writePlan([album('a6', { fbPublishPending: marker('album') })]);
  script = (c) => (c.path === '/v24.0/111/posts' ? err5() : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('a6');
  ok(publishCalls().length === 0 && fbRow().errorCode === 'publish_unconfirmed', 'C2 failed check: nothing published, publish_unconfirmed');
  ok(p.publishHold && p.publishHold.code === 'publish_unconfirmed' && p.fbPublishPending, 'C2 failed check: parked on the first strike, the marker kept');
  ok(/could not confirm it on the Page/.test(fbRow().errorMessage) && !/[\u2013\u2014]/.test(fbRow().errorMessage), 'C2 failed check: a plain sentence');

  // ---- security: only one strict own match is ever adopted ----
  const checkCase = async (id, posts, extra = {}) => {
    reset();
    writePlan([album(id, { fbPublishPending: marker('album', extra) })]);
    script = pageAnswers(posts);
    await meta.cmdPublishDue({ plan: planPath });
    return readPost(id);
  };
  p = await checkCase('s1', [own('111_601', 'album', { from: { id: '999' } })]);
  ok(p.fbPostId === '111_777' && feedPosts().length === 1, 'security: a VISITOR post with our caption is not adopted (we publish)');
  p = await checkCase('s2', [own('111_602', 'album', { from: undefined })]);
  ok(p.fbPostId === '111_777', 'security: a post with no author is never ours');
  p = await checkCase('s3', [own('111_603', 'album', { message: '' })], { caption: '  ' });
  ok(!p.fbPostId && publishCalls().length === 0 && fbRow().errorCode === 'publish_unconfirmed', 'security: an EMPTY caption never adopts and never re-publishes');
  p = await checkCase('s4', [own('111_604', 'album'), own('111_605', 'album')]);
  ok(!p.fbPostId && publishCalls().length === 0 && fbRow().errorCode === 'publish_unconfirmed', 'security: two matches never adopt');
  p = await checkCase('s5', [own('111_606', 'photo')]);
  ok(p.fbPostId === '111_777', 'security: a single photo never matches an album');
  p = await checkCase('s6', [own('111_607', 'album', { attachments: { data: [{ type: 'album', subattachments: { data: [{ type: 'photo' }] } }] } })]);
  ok(p.fbPostId === '111_777', 'security: a different photo count is not ours');
  p = await checkCase('s7', [own('111_608', 'album', { attachments: undefined })]);
  ok(!p.fbPostId && fbRow().errorCode === 'publish_unconfirmed', 'security: an own caption match with an unreadable shape is ambiguous');
  p = await checkCase('s8', [own('111_609', 'album', { from: { id: '999' } }), own('111_610', 'album')]);
  ok(p.fbPostId === '111_610' && publishCalls().length === 0, 'security: a genuine own match is adopted');
  p = await checkCase('s9', [own('111_611', 'album', { created_time: iso(new Date(Date.now() - 60 * 60_000)) })]);
  ok(p.fbPostId === '111_777', 'security: a post older than the attempt is never adopted');

  // ---- a definitive 4xx: nothing was published, no marker left ----
  reset();
  writePlan([album('r4')]);
  script = (c) => (c.path === '/v24.0/111/feed' && c.method === 'POST' ? json({ error: { message: '(#100) Invalid parameter', type: 'OAuthException', code: 100 } }, 400) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  ok(fbRow().errorCode === 100 && !readPost('r4').fbPublishPending && pageChecks().length === 0, 'a 4xx refusal is definitive: the normal row, the marker cleared, no check');

  // ---- C3: reels ----
  // After a fresh upload or an accepted finish in the run, the video reads ready (the
  // post-publish poll); before that, `status` answers for the pending marker's video.
  const reelScript = ({ finish, status }) => {
    let uploaded = false;
    return (c) => {
      if (c.path === '/v24.0/111/video_reels' && c.fields.upload_phase === 'start') { uploaded = true; return json({ video_id: 'v9', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/v9' }); }
      if (c.path.startsWith('/video-upload/')) return json({ success: true });
      if (c.path === '/v24.0/111/video_reels' && c.fields.upload_phase === 'finish') { const r = finish ? finish(c) : json({ success: true }); if (r && r.ok) uploaded = true; return r; }
      if (c.path === '/v24.0/v9' && c.method === 'GET') return (status && !uploaded) ? status(c) : json({ status: { video_status: 'ready' } });
      return undefined;
    };
  };
  const starts = () => calls.filter((c) => c.fields.upload_phase === 'start');
  const finishes = () => calls.filter((c) => c.fields.upload_phase === 'finish');
  reset();
  writePlan([reel('v1')]);
  let reelAtCall = null;
  script = reelScript({ finish: () => { reelAtCall = readPost('v1').fbPublishPending || null; return err5(); } });
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('v1');
  ok(reelAtCall && reelAtCall.kind === 'reel' && reelAtCall.videoId === 'v9' && reelAtCall.caption === 'Neue Geige', 'C1 reel: the marker (kind reel, videoId) is on disk before the finish call');
  ok(finishes().length === 1 && fbRow().errorCode === 'publish_pending_check' && !p.fbReelId && p.fbPublishPending, 'C2 reel: a finish 5xx is pending, no same-run re-finish');

  const reelNextRun = async (id, status) => {
    reset();
    writePlan([reel(id, { fbPublishPending: { at: minutesAgo(4), kind: 'reel', caption: 'Neue Geige', videoId: 'v9' } })]);
    script = reelScript({ status });
    await meta.cmdPublishDue({ plan: planPath });
    return readPost(id);
  };
  p = await reelNextRun('v2', () => json({ id: 'v9', from: { id: '111' }, status: { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'in_progress', publish_status: 'published' } } }));
  ok(p.fbReelId === 'v9' && starts().length === 0 && finishes().length === 0, 'C3: a reel genuinely publishing after an accepted finish is adopted, never re-finished or re-uploaded');

  // C3 revised (owner, after critic round 1): a reel whose finish never took effect is still
  // an unpublished DRAFT. Adopting it would lose the post, so the SAME video is re-finished
  // (a finish on our own video id cannot create a second reel); never a new upload.
  for (const [id, status] of [
    ['v2d', { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'not_started', publish_status: 'draft' } }],
    ['v2e', { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'not_started' } }],
  ]) {
    let refinishMarker = null;
    reset();
    writePlan([reel(id, { fbPublishPending: { at: minutesAgo(4), kind: 'reel', caption: 'Neue Geige', videoId: 'v9' } })]);
    const reelBase = reelScript({ status: () => json({ id: 'v9', from: { id: '111' }, published: false, status }) });
    script = (c) => {
      if (c.path === '/v24.0/111/video_reels' && c.fields.upload_phase === 'finish') refinishMarker = readPost(id).fbPublishPending || null;
      return reelBase(c);
    };
    await meta.cmdPublishDue({ plan: planPath });
    p = readPost(id);
    ok(starts().length === 0 && finishes().length === 1 && finishes()[0].fields.video_id === 'v9' && finishes()[0].fields.video_state === 'PUBLISHED',
      `C3 ${id}: a reel that is still a draft is RE-FINISHED on the same video id, never uploaded again`);
    ok(refinishMarker && refinishMarker.videoId === 'v9' && Date.parse(refinishMarker.at) > Date.now() - 60_000, `C3 ${id}: a fresh marker for the same video is on disk before the re-finish`);
    ok(p.fbReelId === 'v9' && !p.fbPublishPending, `C3 ${id}: the confirmed re-finish records the reel and clears the marker`);
  }
  reset();
  writePlan([reel('v2f', { fbPublishPending: { at: minutesAgo(4), kind: 'reel', caption: 'Neue Geige', videoId: 'v9' } })]);
  script = reelScript({ finish: () => err5(), status: () => json({ id: 'v9', from: { id: '111' }, published: false, status: { video_status: 'ready', uploading_phase: { status: 'complete' }, processing_phase: { status: 'complete' }, publishing_phase: { status: 'not_started', publish_status: 'draft' } } }) });
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('v2f');
  ok(finishes().length === 1 && fbRow().errorCode === 'publish_pending_check' && p.fbPublishPending && p.fbPublishPending.videoId === 'v9' && !p.fbReelId, 'C3: a re-finish that fails ambiguously keeps the marker on the same video (no same-run retry)');
  p = await reelNextRun('v3', () => json({ id: 'v9', from: { id: '111' }, status: { video_status: 'ready', publishing_phase: { status: 'complete', publish_status: 'published' } } }));
  ok(p.fbReelId === 'v9' && starts().length === 0, 'C3: a published reel is adopted');
  p = await reelNextRun('v4', () => json({ id: 'v9', from: { id: '111' }, status: { video_status: 'error', processing_phase: { status: 'error', error: { message: 'Resolution too low' } } } }));
  ok(starts().length === 1 && p.fbReelId === 'v9', 'C3: a reel in an error state is not accepted: a fresh upload publishes');
  p = await reelNextRun('v5', () => json({ error: { message: "Unsupported get request. Object with ID 'v9' does not exist", code: 100, type: 'GraphMethodException' } }, 400));
  ok(starts().length === 1, 'C3: a video that does not exist was never accepted: a fresh upload publishes');
  p = await reelNextRun('v6', () => err5());
  ok(publishCalls().length === 0 && fbRow().errorCode === 'publish_unconfirmed' && p.fbPublishPending, 'C3: a failed video read parks as publish_unconfirmed');
  p = await reelNextRun('v7', () => json({ id: 'v9', from: { id: '999' }, status: { video_status: 'ready' } }));
  ok(!p.fbReelId && fbRow().errorCode === 'publish_unconfirmed', 'C3: a video that is not the Page\'s own is never adopted');

  console.log(`\n[meta-fb-publish-ambiguous] OK - marker first, settle, check, then publish (${pass} assertions).`);
} finally {
  delete globalThis.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
