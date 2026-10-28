#!/usr/bin/env node
// test/youtube-category-synthetic.test.mjs - issue #39: per-post YouTube category and the
// altered/synthetic content disclosure. Proves:
//   HASH (the upgrade trap): adding two keys to POST_CONTENT_FIELDS must NOT change the
//     content hash of a post that never set them, or every already-approved post would be
//     refused at publish with stale_content (lib/receipts.mjs mintAuthorizations). The golden
//     values below were computed on the code BEFORE this change. Setting either field DOES
//     change the hash, so an edit after approval re-fingerprints the post.
//   WRITE: createPost persists both fields, the DTO surfaces them, an invalid category or a
//     non-boolean disclosure is refused naming the field (with the valid ids listed), and an
//     edit of an approved post raises editedSinceApproval.
//   CONFIG: posting.youtube.defaultCategoryId defaults to '27', validates against the same
//     ids, and a partial write does not wipe the subtree.
//   ENGINE: buildMeta picks post -> brand default -> '27' and sends
//     status.containsSyntheticMedia only when the post says true; the release PUT
//     (part=status REPLACES the status part) re-sends the flag; edit uses the resolved
//     category.
//   CHECK: the YouTube preflight carries a warning naming the category and the disclosure.
//   MCP: plan_create_post lists both fields.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-cat-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const jsonRes = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

// The golden content hashes of a representative LEGACY post, computed on develop @ 6fff9e25
// (before youtubeCategoryId / containsSyntheticMedia existed). They must never move.
const LEGACY = {
  id: 'legacy-yt-1', type: 'youtube-short', platforms: ['youtube', 'instagram'], caption: 'Legacy caption #pendpost',
  title: 'Legacy title', description: 'Legacy description', tags: 'a,b', file: 'legacy.mp4', firstComment: null,
  publishAsDraft: null, scheduledAt: '2026-07-01T07:00:00Z', approval: 'approved', status: 'planned',
};
const GOLDEN_SHORT = '4b4a0554e770';
const GOLDEN_SHA256 = 'edcc93c19ca6c1a0744d749fe77e633815143d52b068478603864335f7cd10a9';
const BARE = { id: 'x', type: 'text', platforms: ['x'], caption: 'hi' };
const GOLDEN_BARE_SHORT = 'd2ce277896a4';
const GOLDEN_BARE_SHA256 = '3c43ea8ecdb8e1b0428478c64f836d22539a32bb38ca4081736af44a70eef46f';

const realFetch = globalThis.fetch;
try {
  // ===== HASH =====
  const { postContentHash, contentSha256 } = await import('../lib/plans.mjs');
  ok(postContentHash(LEGACY) === GOLDEN_SHORT, `content hash golden: legacy post postContentHash unchanged (got ${postContentHash(LEGACY)})`);
  ok(contentSha256(LEGACY) === GOLDEN_SHA256, 'content hash golden: legacy post contentSha256 unchanged');
  ok(postContentHash(BARE) === GOLDEN_BARE_SHORT && contentSha256(BARE) === GOLDEN_BARE_SHA256, 'content hash golden: bare text post unchanged');
  ok(postContentHash({ ...LEGACY, youtubeCategoryId: null, containsSyntheticMedia: null }) === GOLDEN_SHORT, 'explicit null on the new fields hashes like unset');
  ok(postContentHash({ ...LEGACY, containsSyntheticMedia: false }) === GOLDEN_SHORT, 'containsSyntheticMedia:false hashes like unset (only true is meaningful)');
  ok(postContentHash({ ...LEGACY, youtubeCategoryId: '22' }) !== GOLDEN_SHORT, 'setting youtubeCategoryId changes the hash (re-fingerprints)');
  ok(postContentHash({ ...LEGACY, containsSyntheticMedia: true }) !== GOLDEN_SHORT, 'setting containsSyntheticMedia:true changes the hash');
  ok(contentSha256({ ...LEGACY, containsSyntheticMedia: true }) !== GOLDEN_SHA256, 'contentSha256 also moves with the disclosure flag');

  // ===== WRITE =====
  const plansDir = path.join(WS, 'data', 'plans');
  fs.mkdirSync(path.join(plansDir, 'yt'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
  fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'yt', path: 'data/plans/yt/post-plan.json', active: true }] }));
  fs.writeFileSync(path.join(plansDir, 'yt', 'post-plan.json'), JSON.stringify({ campaign: 'YT', timezone: 'UTC', posts: [] }));
  const w = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const base = { type: 'youtube-short', platforms: ['youtube'], title: 'T', description: 'D', path: 'data/media/clip.mp4', scheduledAt: '2099-01-01T09:00:00Z' };
  const created = await w.createPost({ campaign: 'yt', actor: 'agent:test', post: { ...base, id: 'p1', youtubeCategoryId: '28', containsSyntheticMedia: true } });
  ok(created.ok === true, `createPost accepts both fields (got ${JSON.stringify(created).slice(0, 200)})`);
  const raw = JSON.parse(fs.readFileSync(path.join(plansDir, 'yt', 'post-plan.json'), 'utf8')).posts.find((p) => p.id === 'p1');
  ok(raw.youtubeCategoryId === '28' && raw.containsSyntheticMedia === true, 'createPost persists youtubeCategoryId + containsSyntheticMedia');
  const plain = await w.createPost({ campaign: 'yt', actor: 'agent:test', post: { ...base, id: 'p2', containsSyntheticMedia: false } });
  const rawPlain = JSON.parse(fs.readFileSync(path.join(plansDir, 'yt', 'post-plan.json'), 'utf8')).posts.find((p) => p.id === 'p2');
  ok(plain.ok === true && !('youtubeCategoryId' in rawPlain) && !('containsSyntheticMedia' in rawPlain), 'unset fields (and an explicit false) are not persisted');
  const dto = (id) => loadPlanStore().campaigns.find((c) => c.id === 'yt').posts.find((p) => p.id === id);
  ok(dto('p1').youtubeCategoryId === '28' && dto('p1').containsSyntheticMedia === true, 'DTO surfaces the set values');
  ok(dto('p2').youtubeCategoryId === null && dto('p2').containsSyntheticMedia === false, 'DTO defaults: youtubeCategoryId null, containsSyntheticMedia false');

  const bad = await w.createPost({ campaign: 'yt', actor: 'agent:test', post: { ...base, id: 'p3', youtubeCategoryId: '21' } });
  ok(bad.ok !== true && bad.code === 'invalid_input' && /youtubeCategoryId/.test(bad.message) && /22/.test(bad.message) && /27/.test(bad.message),
    `an unassignable category is refused naming the field and listing the ids (got ${JSON.stringify(bad)})`);
  const badNum = await w.createPost({ campaign: 'yt', actor: 'agent:test', post: { ...base, id: 'p3', youtubeCategoryId: 27 } });
  ok(badNum.ok !== true && badNum.code === 'invalid_input' && /youtubeCategoryId/.test(badNum.message), 'a numeric category id is refused (it must be a string)');
  const badBool = await w.createPost({ campaign: 'yt', actor: 'agent:test', post: { ...base, id: 'p3', containsSyntheticMedia: 'yes' } });
  ok(badBool.ok !== true && badBool.code === 'invalid_input' && /containsSyntheticMedia/.test(badBool.message), 'a non-boolean disclosure is refused naming the field');

  // An approved post that gains the disclosure re-fingerprints (editedSinceApproval).
  const planAbs = path.join(plansDir, 'yt', 'post-plan.json');
  const planJson = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  const p2 = planJson.posts.find((p) => p.id === 'p2');
  p2.approval = 'approved'; p2.approvalBy = 'owner'; p2.approvedContentHash = postContentHash(p2);
  fs.writeFileSync(planAbs, JSON.stringify(planJson));
  const { postRev } = await import('../lib/plans.mjs');
  const upd = await w.updatePost({ campaign: 'yt', postId: 'p2', ifRev: postRev(p2), actor: 'owner', fields: { containsSyntheticMedia: true } });
  ok(upd.ok === true && upd.post.editedSinceApproval === true, `setting the disclosure on an approved post raises editedSinceApproval (got ${JSON.stringify(upd).slice(0, 200)})`);
  const upd2 = await w.updatePost({ campaign: 'yt', postId: 'p2', ifRev: upd.rev, actor: 'owner', fields: { containsSyntheticMedia: null } });
  ok(upd2.ok === true && upd2.post.editedSinceApproval !== true, 'clearing it again restores the approved fingerprint');

  // ===== CONFIG =====
  const { getConfig, getPosting, setConfig } = await import('../lib/config.mjs');
  ok(getPosting().youtube?.defaultCategoryId === '27', `posting.youtube.defaultCategoryId defaults to 27 (got ${JSON.stringify(getPosting().youtube)})`);
  const cfgBad = setConfig({ ifRev: getConfig().rev, actor: 'agent:test', set: { posting: { youtube: { defaultCategoryId: '99' } } } });
  ok(cfgBad.ok !== true && cfgBad.code === 'invalid_input' && /defaultCategoryId/.test(cfgBad.message), 'an invalid brand default category is refused');
  const cfgOk = setConfig({ ifRev: getConfig().rev, actor: 'agent:test', set: { posting: { youtube: { defaultCategoryId: '22' } } } });
  ok(cfgOk.ok !== false && getPosting().youtube.defaultCategoryId === '22', 'an agent may set the brand default category (not owner-only)');
  const cfgPartial = setConfig({ ifRev: getConfig().rev, actor: 'agent:test', set: { posting: { youtube: {} } } });
  ok(cfgPartial.ok !== false && getPosting().youtube.defaultCategoryId === '22', 'a partial posting.youtube write keeps the stored default (shallow merge)');

  // ===== CHECK (preflight warning) =====
  const pv = await w.platformValidate({ campaign: 'yt', postId: 'p1' });
  const warns = pv.platforms.youtube.warnings || [];
  ok(warns.some((x) => /category 28/.test(x) && /Science & Technology/.test(x)), `Check names the category that will be sent (got ${JSON.stringify(warns)})`);
  ok(warns.some((x) => /altered or synthetic/i.test(x)), 'Check states the altered/synthetic disclosure when set');
  const pvDefault = await w.platformValidate({ campaign: 'yt', postId: 'p2' });
  const warnsDefault = pvDefault.platforms.youtube.warnings || [];
  // Critic A: the brand default stays silent, so a plain YouTube post shows no Check row.
  ok(!warnsDefault.some((x) => /category|synthetic/i.test(x)), `a post that sets neither field gets no category or disclosure line (got ${JSON.stringify(warnsDefault)})`);
  ok(pv.platforms.youtube.ready === pvDefault.platforms.youtube.ready, 'the category line is advisory (never changes readiness)');

  // ===== ENGINE =====
  const ENV_PATH = path.join(WS, '.env');
  fs.writeFileSync(ENV_PATH, 'YT_CLIENT_ID=cid\nYT_CLIENT_SECRET=csec\nYT_REFRESH_TOKEN=rtok\n');
  const yt = await import('../scripts/yt-social.mjs');
  const m1 = yt.buildMeta({ title: 'T', youtubeCategoryId: '28', containsSyntheticMedia: true }, { language: 'en', defaultCategoryId: '22' });
  ok(m1.snippet.categoryId === '28' && m1.status.containsSyntheticMedia === true, 'buildMeta: the post category wins and the disclosure rides status');
  const m2 = yt.buildMeta({ title: 'T' }, { language: 'en', defaultCategoryId: '22' });
  ok(m2.snippet.categoryId === '22' && !('containsSyntheticMedia' in m2.status), 'buildMeta: brand default when unset; disclosure not sent when unset');
  const m3 = yt.buildMeta({ title: 'T', containsSyntheticMedia: false });
  ok(m3.snippet.categoryId === '27' && !('containsSyntheticMedia' in m3.status), 'buildMeta: 27 is the last fallback; false is not sent');

  // Release: part=status REPLACES the status part, so the PUT must carry the flag.
  fs.mkdirSync(path.join(WS, 'data', 'plans', 'rel'), { recursive: true });
  const relPlan = path.join(WS, 'data', 'plans', 'rel', 'post-plan.json');
  fs.writeFileSync(relPlan, JSON.stringify({
    campaign: 'rel', timezone: 'UTC',
    posts: [
      { id: 's1', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2026-06-29T07:00:00Z', ytVideoId: 'VS1', status: 'scheduled', approval: 'approved', title: 'A', description: 'B', containsSyntheticMedia: true, youtubeCategoryId: '28' },
      { id: 's2', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2026-06-29T07:00:00Z', ytVideoId: 'VS2', status: 'scheduled', approval: 'approved', title: 'A', description: 'B' },
    ],
  }));
  const puts = [];
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok', expires_in: 3600 });
    if (u.includes('/videos') && init.method === 'PUT') { puts.push(JSON.parse(init.body)); return jsonRes({}); }
    if (u.includes('/videos')) return jsonRes({ items: [{ id: 'VS1', status: { privacyStatus: 'private', publishAt: '2026-06-29T07:00:00Z' } }, { id: 'VS2', status: { privacyStatus: 'private', publishAt: '2026-06-29T07:00:00Z' } }] });
    return jsonRes({ error: { message: `unexpected ${u}` } }, { status: 500, ok: false });
  };
  yt.RUN.results.length = 0;
  await yt.cmdRelease({ plan: relPlan });
  const putS1 = puts.find((b) => b.id === 'VS1');
  const putS2 = puts.find((b) => b.id === 'VS2');
  ok(putS1 && putS1.status.containsSyntheticMedia === true && putS1.status.privacyStatus === 'public' && putS1.status.selfDeclaredMadeForKids === false,
    `release PUT re-sends containsSyntheticMedia:true (got ${JSON.stringify(putS1)})`);
  ok(putS2 && !('containsSyntheticMedia' in putS2.status), `release PUT leaves the flag out for an undisclosed post (got ${JSON.stringify(putS2)})`);

  // Edit (critic D): a published video keeps its own category and language unless the
  // post sets youtubeCategoryId; a disclosure added after publish goes out with part=status,
  // re-sending the video's current writable status fields (part=status replaces the part).
  const edits = [];
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok', expires_in: 3600 });
    if (u.includes('/videos') && init.method === 'PUT') { edits.push({ part: new URL(u).searchParams.get('part'), body: JSON.parse(init.body) }); return jsonRes({}); }
    if (u.includes('/videos')) {
      const id = new URL(u).searchParams.get('id');
      return jsonRes({ items: [{ id, snippet: { title: 'old', categoryId: '24', defaultLanguage: 'fr', defaultAudioLanguage: 'fr' }, status: { privacyStatus: 'public', license: 'youtube', embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false, madeForKids: false, uploadStatus: 'processed' } }] });
    }
    return jsonRes({ error: { message: `unexpected ${u}` } }, { status: 500, ok: false });
  };
  await yt.cmdEdit({ plan: relPlan });
  const snip = (id) => edits.find((e) => e.part === 'snippet' && e.body.id === id)?.body.snippet;
  ok(snip('VS1')?.categoryId === '28', 'edit sends the category the post sets explicitly');
  ok(snip('VS2')?.categoryId === '24', `edit keeps the video's own category when the post sets none, not the brand default (got ${snip('VS2')?.categoryId})`);
  ok(snip('VS1')?.defaultLanguage === 'fr' && snip('VS2')?.defaultAudioLanguage === 'fr', "edit keeps the video's own language fields");
  const st = edits.find((e) => e.part === 'status' && e.body.id === 'VS1')?.body.status;
  ok(st && st.containsSyntheticMedia === true && st.privacyStatus === 'public' && st.license === 'youtube' && st.embeddable === true && st.selfDeclaredMadeForKids === false && !('uploadStatus' in st) && !('madeForKids' in st),
    `a disclosure added after publish is pushed with the video's current status fields (got ${JSON.stringify(st)})`);
  ok(!edits.some((e) => e.part === 'status' && e.body.id === 'VS2'), 'no status write for a post without the disclosure');
  globalThis.fetch = realFetch;

  // ===== MCP =====
  const { TOOLS } = await import('../lib/mcp.mjs');
  const create = TOOLS.find((t) => t.name === 'plan_create_post');
  const props = create.inputSchema.properties.post.properties;
  ok(props.youtubeCategoryId && props.youtubeCategoryId.type === 'string' && /27/.test(props.youtubeCategoryId.description), 'plan_create_post lists youtubeCategoryId with the valid ids');
  ok(props.containsSyntheticMedia && props.containsSyntheticMedia.type === 'boolean', 'plan_create_post lists containsSyntheticMedia');
  const update = TOOLS.find((t) => t.name === 'plan_update_post');
  ok(/youtubeCategoryId/.test(update.description) && /containsSyntheticMedia/.test(update.description), 'plan_update_post names both fields');
  const cfgTool = TOOLS.find((t) => t.name === 'config_set');
  ok(/defaultCategoryId/.test(JSON.stringify(cfgTool)), 'config_set mentions posting.youtube.defaultCategoryId');
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
