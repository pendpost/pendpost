#!/usr/bin/env node
// test/archive-safety.test.mjs - the A4 archive safety sweep (ux-audit dim-4,
// matrix row 10): archiving a client must first surface its in-flight work.
// Locally-fired approved posts silently stop and go overdue invisibly, and
// NATIVELY scheduled platform objects (FB scheduled post, YouTube publishAt,
// mastodon queue entry, WP future, Ghost scheduled) STILL FIRE from the
// platform after archive (docs/specs/cloud-integration-contract.md). Proves:
//   - clientInFlightWork splits a client's approved in-flight posts into
//     locally-fired vs natively-scheduled;
//   - archiveClientSweep of an IDLE client behaves exactly like archiveClient
//     (reversible toggle, restore untouched by the sweep);
//   - archiving with native-scheduled work is REFUSED (needs_confirm + counts)
//     until acknowledgeInFlight or unscheduleInFlight is passed;
//   - unscheduleInFlight fans out over the existing unschedule verb: native
//     objects are cancelled (id fields dropped), every in-flight post parks,
//     THEN the client archives;
//   - acknowledgeInFlight archives while leaving the platform objects alone;
//   - the active-client refusal is preserved verbatim;
//   - the MCP client_archive twin keeps parity: owner+confirm still required,
//     and native-scheduled work still demands the explicit acknowledge.
// Mock mode; zero network (native cancels run the engines' mock driver).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-archive-safety-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { initMultiClient, clientRoot, readRegistry } = await import('../lib/multi-client.mjs');
initMultiClient();
const { createClient, setActiveClient } = await import('../lib/clients.mjs');
const { withClient } = await import('../lib/context.mjs');
const {
  createCampaign, createPost, approvePost, clientInFlightWork, archiveClientSweep,
} = await import('../lib/writes.mjs');

const CAMP = 'launch';
const planPath = (clientId) => path.join(clientRoot(clientId), 'data', 'plans', CAMP, 'post-plan.json');
const rawPost = (clientId, id) => JSON.parse(fs.readFileSync(planPath(clientId), 'utf8')).posts.find((p) => p.id === id);
const regStatus = (id) => readRegistry().clients.find((c) => c.id === id)?.status;

// Seed a client with one locally-fired approved post (text/linkedin: media-less)
// and, optionally, one natively-handed-off post (status scheduled + ytVideoId).
async function seedClient(id, { withWork = false } = {}) {
  const created = createClient({ id, displayName: id, actor: 'owner' });
  assert.ok(created.ok === true, `seed: createClient ${id} (${JSON.stringify(created)})`);
  if (!withWork) return;
  await withClient(clientRoot(id), async () => {
    await createCampaign({ id: CAMP, note: 'launch', timezone: 'UTC', actor: 'owner' });
    // p-local: approved + fully-scheduled, fired by the LOCAL scheduler at due time.
    await createPost({ campaign: CAMP, post: { id: 'p-local', type: 'text', platforms: ['linkedin'], scheduledAt: '2999-01-01T10:00:00Z', caption: 'local in-flight' }, actor: 'agent:claude' });
    await approvePost({ campaign: CAMP, postId: 'p-local', actor: 'owner' });
    // p-native: approved AND already handed off to the platform's own scheduler.
    await createPost({ campaign: CAMP, post: { id: 'p-native', type: 'text', platforms: ['linkedin'], scheduledAt: '2999-01-02T10:00:00Z', caption: 'native in-flight' }, actor: 'agent:claude' });
    await approvePost({ campaign: CAMP, postId: 'p-native', actor: 'owner' });
  });
  // Hand the native post off exactly as the scheduler's native lane would:
  // status 'scheduled' + the platform object id on the raw plan row.
  const abs = planPath(id);
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const p = plan.posts.find((x) => x.id === 'p-native');
  p.status = 'scheduled';
  p.ytVideoId = 'yt-native-1';
  fs.writeFileSync(abs, JSON.stringify(plan, null, 2));
}

try {
  await seedClient('idle');
  await seedClient('busy', { withWork: true });
  await seedClient('acked', { withWork: true });
  // Mandate H auto-promoted the FIRST seeded client ('idle') to active; pin the
  // active client back to 'default' so the seeded clients are archivable and the
  // active-client refusal check (6) targets a known id.
  assert.ok(setActiveClient({ id: 'default', actor: 'owner' }).ok === true, 'seed: default re-activated');

  // ===== (1) clientInFlightWork: the local/native split =====================
  const work = clientInFlightWork('busy');
  ok(work.total === 2 && work.local === 1 && work.native === 1,
    `busy has 2 in-flight posts, split 1 local / 1 native (got ${JSON.stringify({ total: work.total, local: work.local, native: work.native })})`);
  const nativeRow = work.posts.find((p) => p.postId === 'p-native');
  ok(nativeRow && nativeRow.native.includes('youtube') && nativeRow.campaign === CAMP,
    'the native row names its lane (youtube) and campaign');
  const idleWork = clientInFlightWork('idle');
  ok(idleWork.total === 0 && idleWork.local === 0 && idleWork.native === 0, 'an idle client reports zero in-flight work');

  // ===== (2) idle client: archive unchanged, restore untouched ==============
  const idleArchived = await archiveClientSweep({ id: 'idle', actor: 'owner' });
  ok(idleArchived.ok === true && idleArchived.client.status === 'archived',
    'archiving an idle client succeeds with no acknowledge needed');
  ok(idleArchived.inFlight && idleArchived.inFlight.total === 0 && idleArchived.unscheduled === 0,
    'the idle archive reports zero in-flight work and zero unschedules');
  const idleRestored = await archiveClientSweep({ id: 'idle', actor: 'owner' });
  ok(idleRestored.ok === true && idleRestored.client.status === 'active',
    'restore (archived -> active) still just toggles, no sweep');

  // ===== (3) native-scheduled work refuses a blind archive ==================
  const refused = await archiveClientSweep({ id: 'busy', actor: 'owner' });
  ok(refused.ok !== true && refused.code === 'needs_confirm',
    `archive with native-scheduled work is refused with needs_confirm (got ${JSON.stringify(refused.code)})`);
  ok(refused.inFlight && refused.inFlight.native === 1 && refused.inFlight.local === 1,
    'the refusal carries the in-flight counts');
  ok(/platform/i.test(refused.message) && /unscheduleInFlight/.test(refused.message),
    'the refusal explains the platform keeps firing and names the unschedule flag');
  ok(regStatus('busy') === 'active', 'the refused client is NOT archived');
  ok(rawPost('busy', 'p-native').ytVideoId === 'yt-native-1', 'the platform object is untouched by the refusal');

  // ===== (4) unscheduleInFlight: cancel native, park all, then archive ======
  const swept = await archiveClientSweep({ id: 'busy', actor: 'owner', unscheduleInFlight: true });
  ok(swept.ok === true && swept.client.status === 'archived', 'unscheduleInFlight archives the client');
  ok(swept.unscheduled === 2, `both in-flight posts were unscheduled (got ${swept.unscheduled})`);
  const nat = rawPost('busy', 'p-native');
  ok(nat.ytVideoId === undefined, 'the native platform object id is gone (cancelled via the unschedule verb)');
  ok(nat.status === 'planned' && nat.executionMode === 'parked', 'the native post is parked');
  const loc = rawPost('busy', 'p-local');
  ok(loc.executionMode === 'parked', 'the locally-fired post is parked too (no invisible overdue)');
  ok(regStatus('busy') === 'archived', 'the registry shows busy archived');

  // ===== (5) acknowledgeInFlight: archive anyway, platform objects intact ===
  const acked = await archiveClientSweep({ id: 'acked', actor: 'owner', acknowledgeInFlight: true });
  ok(acked.ok === true && acked.client.status === 'archived' && acked.unscheduled === 0,
    'acknowledgeInFlight archives without touching the in-flight work');
  ok(rawPost('acked', 'p-native').ytVideoId === 'yt-native-1',
    'the acknowledged archive leaves the platform object alone (owner chose that)');

  // ===== (6) active-client refusal preserved verbatim =======================
  const activeRefusal = await archiveClientSweep({ id: 'default', actor: 'owner' });
  ok(activeRefusal.ok !== true && activeRefusal.code === 'invalid_input' && /active client/i.test(activeRefusal.message),
    'archiving the ACTIVE client is still refused (switch first)');

  // ===== (7) MCP parity: client_archive carries the same acknowledge gate ===
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  async function rpc(msg) {
    const body = JSON.stringify(msg);
    const req = Readable.from([Buffer.from(body, 'utf8')]);
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
  async function call(name, args) {
    const reply = await rpc({ jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
    const result = reply && reply.result;
    const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
    return { isError: Boolean(result && result.isError), payload };
  }
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  const tool = TOOLS.find((t) => t.name === 'client_archive');
  ok(tool && 'acknowledgeInFlight' in tool.inputSchema.properties && 'unscheduleInFlight' in tool.inputSchema.properties,
    'client_archive schema declares acknowledgeInFlight + unscheduleInFlight');

  await seedClient('mcp-busy', { withWork: true });
  const mcpNoConfirm = await call('client_archive', { id: 'mcp-busy', actor: 'owner' });
  ok(mcpNoConfirm.isError && mcpNoConfirm.payload.code === 'needs_confirm',
    'MCP: the owner+confirm gate is unchanged (no confirm -> needs_confirm)');
  const mcpBlind = await call('client_archive', { id: 'mcp-busy', actor: 'owner', confirm: true });
  ok(mcpBlind.isError && mcpBlind.payload.code === 'needs_confirm' && mcpBlind.payload.inFlight?.native === 1,
    'MCP: confirm:true alone is NOT enough with native-scheduled work - the counts come back');
  ok(regStatus('mcp-busy') === 'active', 'MCP: the client stays active after the refusal');
  const mcpSwept = await call('client_archive', { id: 'mcp-busy', actor: 'owner', confirm: true, unscheduleInFlight: true });
  ok(!mcpSwept.isError && mcpSwept.payload.ok === true && mcpSwept.payload.unscheduled === 2,
    'MCP: confirm + unscheduleInFlight cancels the work and archives');
  ok(rawPost('mcp-busy', 'p-native').ytVideoId === undefined, 'MCP: the native object was cancelled on the way out');

  console.log(`[archive-safety] OK - archive surfaces in-flight work, native-scheduled objects gate on acknowledge, unschedule sweep cancels them (${pass} assertions).`);
} catch (err) {
  console.error('[archive-safety] FAIL:', err.message);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
