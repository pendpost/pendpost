#!/usr/bin/env node
// test/post-trash.test.mjs - planner bulk contract (2026-11-01), package T: a deleted post
// goes to a per-campaign trash for 30 days instead of vanishing, so the Studio can offer
// "Undo" with no confirm dialog. Proves the fixed interface the Studio builds against:
//   1. deletePost moves the post into the trash (a file beside the plan, never a post field,
//      so the plan content hash and the manifest are untouched) and returns
//      { trashed: true, restorableUntil: <ISO, +30 d> }; the post is gone from plan_get and
//      plan_list (never published, counted or linted from the trash);
//   2. restorePost puts it back at its old place; an approved post whose content is unchanged
//      stays approved, a changed one goes back to review, nothing else is ever approved;
//   3. restore twice -> not_in_trash; an id that exists again -> conflict;
//   4. the publish-evidence gate is unchanged (a published post still needs force);
//   5. a platform-side schedule the delete cancelled leaves no stale id on the restored post
//      and the result says the scheduler schedules it again (rescheduleNeeded);
//   6. a slot that came due while the post sat in the trash is restored parked, never fired
//      by surprise;
//   7. entries older than 30 days are purged (injected clock), on a throttled sweep the
//      scheduler tick calls;
//   8. REST POST /api/plans/:campaign/posts/:id/restore and MCP restore_post return the same
//      envelopes, and the route binds clientId exactly like the delete route.
//
// Zero-dep node:assert style. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-post-trash-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_MOCK_FAIL;
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const DAY = 24 * 3600 * 1000;
const future = (ms = DAY) => new Date(Date.now() + ms).toISOString();

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 100;
async function mcpCall(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}
function mockReq(body, method = 'POST', headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader() {}, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
async function api(handleApi, method, url, body = {}, headers = {}) {
  const res = mockRes();
  await handleApi(mockReq(body, method, headers), res, new URL(`http://127.0.0.1${url}`));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  const { createClient, setActiveClient } = await import('../lib/clients.mjs');
  const { withClient, activeRoot } = await import('../lib/context.mjs');
  const w = await import('../lib/writes.mjs');
  const { postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
  const { getActivity } = await import('../lib/scheduler.mjs');
  initMultiClient();
  createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' });
  createClient({ id: 'beta', displayName: 'Beta Co', actor: 'owner' });
  setActiveClient({ id: 'acme', actor: 'owner' });
  await w.createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  await withClient(clientRoot('beta'), () => w.createCampaign({ id: 'c2', note: 'c2', timezone: 'UTC', actor: 'owner' }));

  const ROOT = activeRoot();
  const planFile = path.join(ROOT, 'data', 'plans', 'c1', 'post-plan.json');
  const trashFile = path.join(ROOT, 'data', 'plans', 'c1', 'post-plan.trash.json');
  const plan = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const ids = () => plan().posts.map((p) => p.id);
  const raw = (id) => plan().posts.find((p) => p.id === id);
  const trash = () => (fs.existsSync(trashFile) ? JSON.parse(fs.readFileSync(trashFile, 'utf8')) : null);
  const trashEntry = (id) => (trash()?.entries || []).find((e) => e.post && e.post.id === id);
  const editTrash = (fn) => { const t = trash(); fn(t); fs.writeFileSync(trashFile, JSON.stringify(t, null, 2)); };
  const mk = (id, extra = {}) => w.createPost({ campaign: 'c1', post: { id, type: 'text', platforms: ['x', 'mastodon'], caption: `a plain and tidy caption for ${id}`, scheduledAt: future(), ...extra }, actor: 'agent:claude' });
  const injectRows = (rows) => {
    const p = plan();
    p.posts.push(...rows);
    fs.writeFileSync(planFile, JSON.stringify(p, null, 2));
  };

  for (const id of ['x1', 'd1', 'x2', 'a1', 'rj', 'tamper', 'cf', 'slot', 'exp', 'p1', 'nofile', 'api1', 'mcp1']) {
    const r = await mk(id);
    ok(r.ok === true, `seed post ${id} created (${r.code || ''} ${r.message || ''})`);
  }
  for (const id of ['a1', 'tamper', 'slot']) {
    const r = await w.approvePost({ campaign: 'c1', postId: id, actor: 'owner' });
    ok(r.ok === true, `seed post ${id} approved by the owner (${r.code || ''} ${r.message || ''})`);
  }
  ok((await w.rejectPost({ campaign: 'c1', postId: 'rj', actor: 'owner', note: 'no' })).ok === true, 'seed post rj rejected');
  injectRows([
    { id: 'pub', type: 'text', platforms: ['x'], caption: 'already out', status: 'posted', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z', xPostId: 'x-123' },
    { id: 'ghn', type: 'text', platforms: ['ghost'], caption: 'ghost queued', status: 'scheduled', approval: 'approved', scheduledAt: future(30 * DAY), ghostPostId: 'gh-queued' },
    { id: 'dce', type: 'text', platforms: ['discord'], caption: 'event post', status: 'planned', approval: 'draft', scheduledAt: future(), dcEvent: { name: 'Launch party', startTime: future(20 * DAY) }, dcEventId: 'ev-1' },
  ]);
  // The native row was approved over its exact content: stamp the hash the way setApproval does.
  {
    const p = plan();
    const g = p.posts.find((x) => x.id === 'ghn');
    g.approvedContentHash = postContentHash(g);
    fs.writeFileSync(planFile, JSON.stringify(p, null, 2));
  }

  // ===== 1. delete -> trashed, hidden =====
  const before = ids();
  const t0 = Date.now();
  const d1 = await w.deletePost({ campaign: 'c1', postId: 'd1', actor: 'owner' });
  ok(d1.ok === true && d1.trashed === true && d1.deleted?.id === 'd1' && d1.nativeCancelled === null,
    `delete returns ok + trashed:true + deleted.id + nativeCancelled:null (got ${JSON.stringify(d1)})`);
  const until = Date.parse(d1.restorableUntil || '');
  ok(Number.isFinite(until) && Math.abs(until - (t0 + 30 * DAY)) < 60_000 && /T.*Z$/.test(d1.restorableUntil),
    `restorableUntil is an ISO time 30 days out (got ${d1.restorableUntil})`);
  ok(!ids().includes('d1'), 'the deleted post is gone from the plan file');
  ok(trashEntry('d1') && trashEntry('d1').post.caption.includes('d1'), 'the post sits in post-plan.trash.json beside the plan');
  ok(!('trash' in plan()) && plan().posts.every((p) => !('trashedAt' in p)), 'nothing trash-related is written into the plan itself (no new post field, hash untouched)');
  const view = loadPlanStore().campaigns.find((c) => c.id === 'c1');
  ok(view && !view.posts.some((p) => p.id === 'd1'), 'the plan store (plan_get, scheduler, lint, counts) never sees the trashed post');
  const delRow = getActivity(20).find((r) => r.action === 'post-delete' && r.postId === 'd1');
  ok(delRow && delRow.ok === true && delRow.actor === 'owner' && delRow.campaign === 'c1', 'a post-delete activity row is written as before');

  const { handleApi } = await import('../lib/api.mjs');
  const { handleMcp, TOOLS } = await import('../lib/mcp.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const pg = await mcpCall(handleMcp, 'plan_get', { campaign: 'c1', postId: 'd1' });
  ok(pg.isError && pg.payload?.code === 'unknown_post', `plan_get does not find the trashed post (got ${JSON.stringify(pg.payload).slice(0, 160)})`);
  const pgAll = await mcpCall(handleMcp, 'plan_get', { campaign: 'c1' });
  ok(!pgAll.isError && Array.isArray(pgAll.payload?.posts) && !pgAll.payload.posts.some((p) => p.id === 'd1'), 'plan_get of the campaign lists no trashed post');

  // ===== 2. restore -> back in place =====
  const r1 = await w.restorePost({ campaign: 'c1', postId: 'd1', actor: 'owner' });
  ok(r1.ok === true && r1.restored?.id === 'd1' && r1.post?.id === 'd1' && typeof r1.rev === 'string',
    `restore returns ok + restored.id + post + rev (got ${JSON.stringify(r1)})`);
  ok(JSON.stringify(ids()) === JSON.stringify(before), `the post is back at its old place (${ids().join(',')})`);
  ok(raw('d1').approval === 'draft' && r1.post.approval === 'draft', 'a draft comes back a draft (never approved by a restore)');
  ok(r1.rescheduleNeeded === false && r1.nativeCancelled === null && r1.parked === false, 'nothing was cancelled platform-side, so nothing needs re-scheduling');
  ok(!trashEntry('d1'), 'the entry left the trash');
  const resRow = getActivity(20).find((r) => r.action === 'post-restore' && r.postId === 'd1');
  ok(resRow && resRow.ok === true && resRow.actor === 'owner' && resRow.campaign === 'c1', 'a post-restore activity row is written');

  // ===== 3. restore twice -> not_in_trash =====
  const r2 = await w.restorePost({ campaign: 'c1', postId: 'd1', actor: 'owner' });
  ok(r2.ok !== true && r2.code === 'not_in_trash', `a second restore answers not_in_trash (got ${JSON.stringify(r2)})`);
  const r3 = await w.restorePost({ campaign: 'c1', postId: 'never', actor: 'owner' });
  ok(r3.ok !== true && r3.code === 'not_in_trash', 'restoring a post that was never deleted answers not_in_trash');
  ok((await w.restorePost({ campaign: 'c1', postId: 'd1' })).code === 'invalid_input', 'restore requires an actor like every write');
  ok((await w.restorePost({ campaign: 'nope', postId: 'd1', actor: 'owner' })).code === 'unknown_campaign', 'restore on an unknown campaign answers unknown_campaign');

  // ===== 2b. approval kept when unchanged; reset when changed; rejected stays rejected =====
  const a1Hash = raw('a1').approvedContentHash;
  ok((await w.deletePost({ campaign: 'c1', postId: 'a1', actor: 'owner' })).trashed === true, 'an approved post goes to the trash too');
  // Security review 2026-11-01: an agent (or any caller that only TYPES actor "owner") must not be
  // able to bring back an approved post the owner deleted and have it publish. The approval is
  // kept only for the Studio's own restore, which carries the owner marker (REST + Studio token).
  const ra = await w.restorePost({ campaign: 'c1', postId: 'a1', actor: 'owner', [w.RESTORE_OWNER_ACTION]: true });
  ok(ra.ok === true && ra.post.approval === 'approved' && ra.approvalKept === true, `the owner's own restore of an unchanged approved post keeps the approval (got ${JSON.stringify(ra)})`);
  ok(raw('a1').approval === 'approved' && raw('a1').approvedContentHash === a1Hash && postContentHash(raw('a1')) === a1Hash, 'its approval still attests to the exact same content hash');
  await w.deletePost({ campaign: 'c1', postId: 'a1', actor: 'owner' });
  const rag = await w.restorePost({ campaign: 'c1', postId: 'a1', actor: 'agent:claude' });
  ok(rag.ok === true && rag.post.approval === 'draft' && rag.approvalKept === false, `an agent's restore of an approved post brings it back for review, never approved (got ${JSON.stringify(rag)})`);
  ok(!('approvedContentHash' in raw('a1')) && !('approvalBy' in raw('a1')) && /approve/i.test(rag.note || ''), 'the approval stamp is cleared and the note says it needs approval again');
  ok((await w.approvePost({ campaign: 'c1', postId: 'a1', actor: 'owner' })).ok === true, 'a1 is approved again');
  await w.deletePost({ campaign: 'c1', postId: 'a1', actor: 'owner' });
  const rtyped = await w.restorePost({ campaign: 'c1', postId: 'a1', actor: 'owner' });
  ok(rtyped.ok === true && rtyped.post.approval === 'draft' && rtyped.approvalKept === false, 'typing actor "owner" without the owner marker is not enough to keep the approval');
  await w.deletePost({ campaign: 'c1', postId: 'tamper', actor: 'owner' });
  editTrash((t) => { t.entries.find((e) => e.post.id === 'tamper').post.caption = 'changed while in the trash'; });
  const rt = await w.restorePost({ campaign: 'c1', postId: 'tamper', actor: 'owner' });
  ok(rt.ok === true && rt.post.approval === 'draft' && rt.approvalKept === false, `an approved post whose content changed comes back for review, not approved (got ${JSON.stringify(rt)})`);
  ok(!('approvedContentHash' in raw('tamper')) && !('approvalBy' in raw('tamper')), 'the stale approval stamp is cleared');
  await w.deletePost({ campaign: 'c1', postId: 'rj', actor: 'owner' });
  const rr = await w.restorePost({ campaign: 'c1', postId: 'rj', actor: 'owner' });
  ok(rr.ok === true && rr.post.approval === 'rejected' && rr.approvalKept === null, 'a rejected post comes back rejected (approvalKept null: there was no approval to keep)');

  // ===== 3b. conflict =====
  await w.deletePost({ campaign: 'c1', postId: 'cf', actor: 'owner' });
  ok((await mk('cf', { caption: 'a brand new post reusing the id' })).ok === true, 'a new post may reuse the id while the old one is in the trash');
  const rc = await w.restorePost({ campaign: 'c1', postId: 'cf', actor: 'owner' });
  ok(rc.ok !== true && rc.code === 'conflict', `restore over an existing id answers conflict (got ${JSON.stringify(rc)})`);
  ok(raw('cf').caption === 'a brand new post reusing the id' && trashEntry('cf'), 'the conflict changes nothing: the new post stays, the old one stays in the trash');
  await w.deletePost({ campaign: 'c1', postId: 'cf', actor: 'owner' });
  const rc2 = await w.restorePost({ campaign: 'c1', postId: 'cf', actor: 'owner' });
  ok(rc2.ok === true && raw('cf').caption === 'a brand new post reusing the id', 'with two trashed copies of one id, restore brings back the newest');

  // ===== 4. publish-evidence gate unchanged =====
  const pb1 = await w.deletePost({ campaign: 'c1', postId: 'pub', actor: 'owner' });
  ok(pb1.ok !== true && pb1.code === 'invalid_input' && ids().includes('pub') && !trashEntry('pub'), `a published post still needs force and is neither removed nor trashed (got ${pb1.code})`);
  const pb2 = await w.deletePost({ campaign: 'c1', postId: 'pub', force: true, actor: 'owner' });
  ok(pb2.ok === true && pb2.trashed === true && !ids().includes('pub'), 'with force the published post goes to the trash');
  const pb3 = await w.restorePost({ campaign: 'c1', postId: 'pub', actor: 'owner' });
  ok(pb3.ok === true && raw('pub').status === 'posted' && raw('pub').xPostId === 'x-123', 'restoring a published post keeps its publish evidence, so it is never published twice');

  // ===== 5. native schedule cancelled -> no stale id, rescheduleNeeded =====
  const gn = await w.deletePost({ campaign: 'c1', postId: 'ghn', force: true, actor: 'owner' });
  ok(gn.ok === true && gn.trashed === true && gn.nativeCancelled === 'ghost', `the natively scheduled ghost post cancels and trashes in one motion (got ${JSON.stringify(gn)})`);
  ok(trashEntry('ghn') && !('ghostPostId' in trashEntry('ghn').post) && trashEntry('ghn').post.status === 'planned', 'the trashed copy carries no id of the cancelled platform object, status back to planned');
  const rg = await w.restorePost({ campaign: 'c1', postId: 'ghn', actor: 'owner', [w.RESTORE_OWNER_ACTION]: true });
  ok(rg.ok === true && rg.rescheduleNeeded === true && rg.nativeCancelled === 'ghost' && /schedul/i.test(rg.note || ''), `restore says the scheduler schedules it again (got ${JSON.stringify(rg)})`);
  ok(!('ghostPostId' in raw('ghn')) && raw('ghn').status === 'planned' && raw('ghn').approval === 'approved' && raw('ghn').executionMode !== 'parked',
    'the restored post has no stale platform id, is approved and plannable, so the scheduler hands it off again');
  const dc = await w.deletePost({ campaign: 'c1', postId: 'dce', actor: 'owner' });
  ok(dc.ok === true && dc.nativeCancelled === 'discord', 'a Discord guild event is cancelled with the delete as before');
  const rd = await w.restorePost({ campaign: 'c1', postId: 'dce', actor: 'owner' });
  ok(rd.ok === true && !('dcEventId' in raw('dce')) && raw('dce').dcEvent && /discord_schedule_event/.test(rd.note || ''),
    `the restored post keeps its event intent, drops the dead event id, and the note says how to create the event again (got ${JSON.stringify(rd)})`);

  // ===== 6. slot came due while in the trash -> parked =====
  await w.deletePost({ campaign: 'c1', postId: 'slot', actor: 'owner' });
  editTrash((t) => {
    const e = t.entries.find((x) => x.post.id === 'slot');
    e.trashedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    e.post.scheduledAt = new Date(Date.now() - 60_000).toISOString();
  });
  const rs = await w.restorePost({ campaign: 'c1', postId: 'slot', actor: 'owner', [w.RESTORE_OWNER_ACTION]: true });
  ok(rs.ok === true && rs.parked === true && raw('slot').executionMode === 'parked' && raw('slot').approval === 'approved',
    `a post whose slot passed while it sat in the trash comes back approved but parked, never fired by surprise (got ${JSON.stringify(rs)})`);

  // ===== 7. expiry + purge (injected clock) + throttle =====
  await w.deletePost({ campaign: 'c1', postId: 'exp', actor: 'owner' });
  editTrash((t) => { t.entries.find((x) => x.post.id === 'exp').restorableUntil = new Date(Date.now() - 1000).toISOString(); });
  const re = await w.restorePost({ campaign: 'c1', postId: 'exp', actor: 'owner' });
  ok(re.ok !== true && re.code === 'not_in_trash', 'an entry past restorableUntil is not restorable even before the purge runs');
  const pr0 = await w.purgeTrash({ now: Date.now() });
  ok(pr0.ok === true && pr0.purged === 1 && !trashEntry('exp') && trashEntry('cf'), `the purge drops only the expired entry (got ${JSON.stringify(pr0)})`);
  await w.deletePost({ campaign: 'c1', postId: 'p1', actor: 'owner' });
  const pr1 = await w.purgeTrash({ now: Date.now() + 29 * DAY });
  ok(pr1.ok === true && pr1.purged === 0 && trashEntry('p1'), 'at 29 days the entry is kept');
  const pr2 = await w.purgeTrash({ now: Date.now() + 31 * DAY });
  ok(pr2.ok === true && pr2.purged === 2 && !trashEntry('p1') && !trashEntry('cf'), `at 31 days the purge removes every entry (got ${JSON.stringify(pr2)})`);
  ok(!fs.existsSync(trashFile), 'an emptied trash file is removed, the plan folder stays clean');
  ok((await w.restorePost({ campaign: 'c1', postId: 'p1', actor: 'owner' })).code === 'not_in_trash', 'a purged post answers not_in_trash');
  const T = Date.now();
  const s1 = await w.trashPurgeSweep({ now: T });
  const s2 = await w.trashPurgeSweep({ now: T + 10 * 60_000 });
  const s3 = await w.trashPurgeSweep({ now: T + 61 * 60_000 });
  ok(s1.ran === true && s2.ran === false && s3.ran === true, `the tick sweep runs at most once an hour per client (got ${JSON.stringify([s1, s2, s3])})`);
  const schedSrc = fs.readFileSync(new URL('../lib/scheduler.mjs', import.meta.url), 'utf8');
  const tickBody = schedSrc.slice(schedSrc.indexOf('export async function tick()'), schedSrc.indexOf('function ensureTimer()'));
  ok(/trashPurgeSweep\(\)/.test(tickBody), 'the scheduler tick calls trashPurgeSweep inside the per-client run');

  // ===== 1b. trash write failure never blocks the delete =====
  fs.mkdirSync(trashFile, { recursive: true });
  const nf = await w.deletePost({ campaign: 'c1', postId: 'nofile', actor: 'owner' });
  ok(nf.ok === true && nf.trashed === false && !('restorableUntil' in nf) && !ids().includes('nofile'), `an unwritable trash still deletes (delete always works), honestly trashed:false (got ${JSON.stringify(nf)})`);
  fs.rmSync(trashFile, { recursive: true, force: true });

  // ===== 8. REST + MCP parity, ?clientId= =====
  const tool = TOOLS.find((t) => t.name === 'restore_post');
  ok(tool && tool.inputSchema.properties.clientId && tool.inputSchema.properties.campaign && tool.inputSchema.properties.postId, 'MCP restore_post exists with campaign, postId and an optional clientId');
  const ad = await api(handleApi, 'DELETE', '/api/plans/c1/posts/api1', { actor: 'owner' });
  ok(ad.status === 200 && ad.body.trashed === true && typeof ad.body.restorableUntil === 'string', `DELETE route answers trashed + restorableUntil (got ${ad.status} ${JSON.stringify(ad.body)})`);
  const ar = await api(handleApi, 'POST', '/api/plans/c1/posts/api1/restore', { actor: 'owner' });
  ok(ar.status === 200 && ar.body.ok === true && ar.body.restored.id === 'api1' && ids().includes('api1'), `POST .../restore puts it back (got ${ar.status} ${JSON.stringify(ar.body)})`);
  const ar2 = await api(handleApi, 'POST', '/api/plans/c1/posts/api1/restore', {});
  ok(ar2.status === 404 && ar2.body.code === 'not_in_trash', `a second REST restore is a 404 not_in_trash (the Studio may omit actor) (got ${ar2.status} ${JSON.stringify(ar2.body)})`);
  await w.deletePost({ campaign: 'c1', postId: 'mcp1', actor: 'owner' });
  const mr = await mcpCall(handleMcp, 'restore_post', { campaign: 'c1', postId: 'mcp1', actor: 'agent:claude' });
  ok(!mr.isError && mr.payload.ok === true && mr.payload.restored.id === 'mcp1', `MCP restore_post puts it back (got ${JSON.stringify(mr)})`);
  const mr2 = await mcpCall(handleMcp, 'restore_post', { campaign: 'c1', postId: 'mcp1', actor: 'agent:claude' });
  ok(mr2.isError && mr2.payload.code === 'not_in_trash', 'MCP restore_post twice answers not_in_trash like REST');
  ok(Object.keys(mr.payload).sort().join() === Object.keys(ar.body).sort().join(), `REST and MCP return the same result shape (${Object.keys(ar.body).sort().join()})`);
  // The owner marker on the REST face comes from the Studio token, never from the body (spec 56).
  const { studioToken, STUDIO_TOKEN_HEADER } = await import('../lib/studio-token.mjs');
  ok((await w.approvePost({ campaign: 'c1', postId: 'a1', actor: 'owner' })).ok === true, 'a1 is approved again for the REST checks');
  await api(handleApi, 'DELETE', '/api/plans/c1/posts/a1', { actor: 'owner' });
  const rNoTok = await api(handleApi, 'POST', '/api/plans/c1/posts/a1/restore', { actor: 'owner' });
  ok(rNoTok.status === 200 && rNoTok.body.post.approval === 'draft' && rNoTok.body.approvalKept === false, `REST restore WITHOUT the Studio token brings an approved post back for review (got ${JSON.stringify(rNoTok.body)})`);
  ok((await w.approvePost({ campaign: 'c1', postId: 'a1', actor: 'owner' })).ok === true, 'a1 approved once more');
  await api(handleApi, 'DELETE', '/api/plans/c1/posts/a1', { actor: 'owner' });
  const rTok = await api(handleApi, 'POST', '/api/plans/c1/posts/a1/restore', { actor: 'owner' }, { [STUDIO_TOKEN_HEADER.toLowerCase()]: studioToken() });
  ok(rTok.status === 200 && rTok.body.post.approval === 'approved' && rTok.body.approvalKept === true, `the Studio's restore (token present) keeps the approval of unchanged content (got ${JSON.stringify(rTok.body)})`);
  const mApproved = await mcpCall(handleMcp, 'restore_post', { campaign: 'c1', postId: 'nope-not-trashed', actor: 'owner' });
  ok(mApproved.isError, 'sanity: MCP restore of an unknown id still errors');
  await w.deletePost({ campaign: 'c1', postId: 'api1', actor: 'owner' });
  await mk('api1');
  const ac = await api(handleApi, 'POST', '/api/plans/c1/posts/api1/restore', { actor: 'owner' });
  const mc = await mcpCall(handleMcp, 'restore_post', { campaign: 'c1', postId: 'api1', actor: 'owner' });
  ok(ac.status === 409 && ac.body.code === 'conflict' && mc.isError && mc.payload.code === 'conflict', `conflict: REST 409 and MCP isError, same code (got ${ac.status} ${JSON.stringify(ac.body)})`);

  // clientId scopes both routes to another client while acme stays active, bound exactly like
  // the DELETE route: handleApi reads it from the JSON body.
  await withClient(clientRoot('beta'), () => w.createPost({ campaign: 'c2', post: { id: 'b1', type: 'text', platforms: ['x'], caption: 'beta post', scheduledAt: future() }, actor: 'owner' }));
  const betaTrash = path.join(clientRoot('beta'), 'data', 'plans', 'c2', 'post-plan.trash.json');
  const betaPlan = () => JSON.parse(fs.readFileSync(path.join(clientRoot('beta'), 'data', 'plans', 'c2', 'post-plan.json'), 'utf8')).posts.map((p) => p.id);
  const bd = await api(handleApi, 'DELETE', '/api/plans/c2/posts/b1', { actor: 'owner', clientId: 'beta' });
  ok(bd.status === 200 && bd.body.trashed === true && fs.existsSync(betaTrash) && !betaPlan().includes('b1'), `DELETE with clientId beta trashes in beta's own plan folder (got ${bd.status} ${JSON.stringify(bd.body)})`);
  const br = await api(handleApi, 'POST', '/api/plans/c2/posts/b1/restore', { actor: 'owner', clientId: 'beta' });
  ok(br.status === 200 && br.body.ok === true && betaPlan().includes('b1'), `POST .../restore with clientId beta restores into beta (got ${br.status} ${JSON.stringify(br.body)})`);
  const bx = await api(handleApi, 'POST', '/api/plans/c2/posts/b1/restore', { actor: 'owner' });
  ok(bx.status === 404 && bx.body.code === 'unknown_campaign', 'without clientId the route stays on the active client (acme has no c2)');
  await withClient(clientRoot('beta'), () => w.deletePost({ campaign: 'c2', postId: 'b1', actor: 'owner' }));
  const bm = await mcpCall(handleMcp, 'restore_post', { campaign: 'c2', postId: 'b1', actor: 'owner', clientId: 'beta' });
  ok(!bm.isError && bm.payload.ok === true && betaPlan().includes('b1'), 'MCP restore_post honours clientId too');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

if (failures) {
  console.error(`[post-trash] FAIL - ${failures} failure(s), ${pass} passed`);
  process.exit(1);
}
console.log(`[post-trash] OK - deleted posts go to a 30-day trash and restore cleanly (${pass} assertions).`);
