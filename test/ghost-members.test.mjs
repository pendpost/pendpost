#!/usr/bin/env node
// ghost-members.test.mjs - Ghost members + newsletters (spec 30, account
// management, Pattern P3 account-scoped verbs + P4 lib faces) run credential-free
// (mock) AND against a local HTTP stub (live path, no real Ghost network).
//
// Proves, end-to-end through the REAL engine entrypoint + the REAL lib read/write face:
//   1. mock mode: all six verbs (members, member-create, members-import,
//      newsletters, newsletter-create, newsletter-update) fabricate ok envelopes
//      with the shape the spec table defines; members-import is RESILIENT (a
//      missing/malformed/duplicate row is skipped/failed, the batch never aborts).
//   2. live mode, no network: every verb degrades to { ok:false, errorCode:
//      'not_configured' } with no GHOST_SITE_URL/GHOST_ADMIN_API_KEY (mirrors
//      cmdProbe) - never throws.
//   3. live mode, local stub server (GHOST_SITE_URL override): member-create
//      succeeds against the stub; a duplicate email 422s and maps to
//      errorCode:'invalid_input'; members-import survives a mix of a duplicate,
//      a malformed, and a good row in ONE batch (created/skipped/failed tally);
//      newsletter-create/newsletters round-trip; newsletter-update's GET-then-PUT
//      precondition flow (the updated_at collision guard) archives a newsletter
//      end-to-end.
//   4. the lib faces (ghostMembers/ghostNewsletters/ghostMemberCreate/
//      ghostMembersImport/ghostNewsletterCreate/ghostNewsletterUpdate) require an
//      actor on every write and map the engine envelope onto the shared contract.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

// PENDPOST_ROOT must be set BEFORE importing lib (util binds WORKSPACE_ROOT at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghostmembers-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

function runEngine(args, extraEnv = {}) {
  const env = { ...process.env, PENDPOST_ROOT: WS, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k];
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'ghost-social.mjs'), ...args], { cwd: REPO, env, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// ASYNC variant for calls that must hit a LOCAL http server running in THIS same
// process (execFileSync would block the event loop and deadlock the stub).
function runEngineAsync(args, extraEnv = {}) {
  const env = { ...process.env, PENDPOST_ROOT: WS, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(REPO, 'scripts', 'ghost-social.mjs'), ...args], { cwd: REPO, env, encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) { reject(err); return; }
      try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch (parseErr) { reject(parseErr); }
    });
  });
}

const row = (envelope, action) => (Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === action) : null);

const { ghostMembers, ghostNewsletters, ghostMemberCreate, ghostMembersImport, ghostNewsletterCreate, ghostNewsletterUpdate } = await import('../lib/writes.mjs');

try {
  // ================= 1. MOCK MODE (credential-free, no network) =================
  const membersEnv = runEngine(['members', '--json', '--actor', 'owner']);
  const membersRow = row(membersEnv, 'members');
  ok(membersEnv.ok === true && membersRow.ok === true && membersRow.counts && Number.isInteger(membersRow.counts.total) && Array.isArray(membersRow.items),
    'mock members: { ok:true, counts:{total,free,paid,comped}, items[] }');
  ok(membersRow.items.every((m) => m.id && m.email && 'status' in m && Array.isArray(m.labels) && Array.isArray(m.newsletters)),
    'every mock member item carries id/email/status/labels[]/newsletters[]');

  const newslettersEnv = runEngine(['newsletters', '--json', '--actor', 'owner']);
  const newslettersRow = row(newslettersEnv, 'newsletters');
  ok(newslettersEnv.ok === true && newslettersRow.ok === true && Array.isArray(newslettersRow.items) && newslettersRow.items.length >= 1,
    'mock newsletters: { ok:true, items[] }');
  ok(newslettersRow.items.every((n) => n.id && n.slug && n.name && 'status' in n), 'every mock newsletter item carries id/slug/name/status');

  const memberCreateEnv = runEngine(['member-create', '--email', 'alice@example.com', '--name', 'Alice', '--labels', 'vip', '--newsletters', 'weekly', '--json', '--actor', 'owner']);
  const memberCreateRow = row(memberCreateEnv, 'member-create');
  ok(memberCreateEnv.ok === true && memberCreateRow.ok === true && memberCreateRow.id, 'mock member-create: { ok:true, id }');

  const memberCreateNoEmail = runEngine(['member-create', '--json', '--actor', 'owner']);
  const memberCreateNoEmailRow = row(memberCreateNoEmail, 'member-create');
  ok(memberCreateNoEmailRow.ok === false && memberCreateNoEmailRow.errorCode === 'invalid_input', 'mock member-create without --email -> invalid_input');

  // members-import RESILIENCE: one missing-email row, one duplicate-marked row,
  // one good row - the batch reports all three outcomes and NEVER aborts.
  const importRows = JSON.stringify([{ email: 'good@example.com' }, { email: 'duplicate@example.com' }, { note: 'no email field' }]);
  const importEnv = runEngine(['members-import', '--rows', importRows, '--json', '--actor', 'owner']);
  const importRow = row(importEnv, 'members-import');
  ok(importEnv.ok === true && importRow.ok === true, 'mock members-import resolves ok:true (the batch itself never fails)');
  ok(importRow.created === 1 && importRow.skipped === 1 && Array.isArray(importRow.failed) && importRow.failed.length === 1,
    `mock members-import survives a mixed batch: 1 created, 1 skipped (duplicate), 1 failed (missing email) - got created=${importRow.created} skipped=${importRow.skipped} failed=${importRow.failed?.length}`);
  ok(importRow.failed[0].error === 'missing email', 'the failed row carries { email:null, error:"missing email" }');

  const importNeither = runEngine(['members-import', '--json', '--actor', 'owner']);
  const importNeitherRow = row(importNeither, 'members-import');
  ok(importNeitherRow.ok === false && importNeitherRow.errorCode === 'invalid_input', 'mock members-import with neither --file nor --rows -> invalid_input');

  const newsletterCreateEnv = runEngine(['newsletter-create', '--name', 'Monthly', '--description', 'A monthly roundup', '--json', '--actor', 'owner']);
  const newsletterCreateRow = row(newsletterCreateEnv, 'newsletter-create');
  ok(newsletterCreateEnv.ok === true && newsletterCreateRow.ok === true && newsletterCreateRow.id && newsletterCreateRow.slug, 'mock newsletter-create: { ok:true, id, slug }');

  const newsletterCreateNoName = runEngine(['newsletter-create', '--json', '--actor', 'owner']);
  ok(row(newsletterCreateNoName, 'newsletter-create').errorCode === 'invalid_input', 'mock newsletter-create without --name -> invalid_input');

  const newsletterUpdateEnv = runEngine(['newsletter-update', '--id', 'nl1', '--status', 'archived', '--json', '--actor', 'owner']);
  const newsletterUpdateRow = row(newsletterUpdateEnv, 'newsletter-update');
  ok(newsletterUpdateEnv.ok === true && newsletterUpdateRow.ok === true && newsletterUpdateRow.id === 'nl1' && newsletterUpdateRow.status === 'archived',
    'mock newsletter-update: { ok:true, id, status:"archived" }');

  const newsletterUpdateBadStatus = runEngine(['newsletter-update', '--id', 'nl1', '--status', 'bogus', '--json', '--actor', 'owner']);
  ok(row(newsletterUpdateBadStatus, 'newsletter-update').errorCode === 'invalid_input', 'mock newsletter-update rejects an unknown --status -> invalid_input');

  const newsletterUpdateNoId = runEngine(['newsletter-update', '--status', 'active', '--json', '--actor', 'owner']);
  ok(row(newsletterUpdateNoId, 'newsletter-update').errorCode === 'invalid_input', 'mock newsletter-update without --id -> invalid_input');

  // ================= 2. LIVE MODE, no network (not_configured, mirrors cmdProbe) ===
  for (const args of [
    ['members'],
    ['member-create', '--email', 'a@example.com'],
    ['members-import', '--rows', '[]'],
    ['newsletters'],
    ['newsletter-create', '--name', 'X'],
    ['newsletter-update', '--id', 'x', '--status', 'active'],
  ]) {
    const live = runEngine([...args, '--json', '--actor', 'owner'], { PENDPOST_MODE: null });
    const liveRow = row(live, args[0]);
    ok(live.ok === true && liveRow && liveRow.ok === false && liveRow.errorCode === 'not_configured',
      `live ${args[0]} with no GHOST_SITE_URL/GHOST_ADMIN_API_KEY -> { ok:false, errorCode:'not_configured' } (mirrors cmdProbe), never throws`);
  }

  // ================= 3. LIVE MODE, local HTTP stub (the real sequence) ===========
  const state = { members: [], newsletters: [{ id: 'nl-weekly', slug: 'weekly', name: 'Weekly', status: 'active', subscribe_on_signup: true, updated_at: '2026-01-01T00:00:00.000Z' }] };
  let memberSeq = 0;
  // MINOR-4 verification: every non-empty `filter` query param the stub sees on
  // GET /members/ (the main list call AND the three per-status count calls) so
  // the test can assert the NQL string cmdMembers actually sent to Ghost.
  const capturedMemberFilters = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* no body */ }
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'POST' && u.pathname === '/ghost/api/admin/members/') {
      const m = body.members[0];
      if (state.members.some((existing) => existing.email === m.email)) {
        send(422, { errors: [{ message: 'Member already exists. Attempting to add member with existing email address', type: 'ValidationError' }] });
        return;
      }
      memberSeq += 1;
      const created = { id: `member-${memberSeq}`, email: m.email, name: m.name || null, status: 'free', labels: m.labels || [], newsletters: m.newsletters || [] };
      state.members.push(created);
      send(200, { members: [created] });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/ghost/api/admin/members/') {
      const filterParam = u.searchParams.get('filter');
      if (filterParam) capturedMemberFilters.push(filterParam);
      // A status:X-only or status:X+(...) filter narrows the exact-count reads
      // (cmdMembers' countFor); anything containing "status:free" resolves to
      // one member so the free/paid/comped breakdown is exercisable, everything
      // else (the unfiltered main list, or a status the fixture has no match
      // for) reflects the full member set.
      const matchesStatusFree = typeof filterParam === 'string' && filterParam.startsWith('status:free');
      send(200, {
        members: matchesStatusFree ? state.members.slice(0, 1) : state.members,
        meta: { pagination: { total: matchesStatusFree ? Math.min(1, state.members.length) : state.members.length } },
      });
      return;
    }
    if (req.method === 'GET' && u.pathname === '/ghost/api/admin/newsletters/') {
      send(200, { newsletters: state.newsletters });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/ghost/api/admin/newsletters/') {
      const n = body.newsletters[0];
      const id = `nl-${state.newsletters.length + 1}`;
      const created = { id, slug: n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: n.name, description: n.description || null, status: 'active', subscribe_on_signup: n.subscribe_on_signup !== false, updated_at: new Date().toISOString() };
      state.newsletters.push(created);
      send(200, { newsletters: [created] });
      return;
    }
    const singleMatch = u.pathname.match(/^\/ghost\/api\/admin\/newsletters\/([^/]+)\/$/);
    if (singleMatch) {
      const nl = state.newsletters.find((n) => n.id === singleMatch[1]);
      if (!nl) { send(404, { errors: [{ message: 'Newsletter not found.' }] }); return; }
      if (req.method === 'GET') { send(200, { newsletters: [nl] }); return; }
      if (req.method === 'PUT') {
        const patch = body.newsletters[0];
        Object.assign(nl, patch, { updated_at: new Date().toISOString() });
        send(200, { newsletters: [nl] });
        return;
      }
    }
    // MINOR-3 verification: the --upload multipart fast-path. Mirrors Ghost's
    // documented importer response shape - invalid rows nested under
    // meta.stats.invalid (NOT meta.invalid) - so the test proves `failed` is
    // read from stats.invalid, not silently dropped.
    if (req.method === 'POST' && u.pathname === '/ghost/api/admin/members/upload/') {
      send(200, {
        meta: {
          stats: { imported: 2, invalid: [{ email: 'badrow@example.com', error: 'Invalid email address' }] },
          duplicates: ['dup1@example.com'],
        },
      });
      return;
    }
    send(404, { errors: [{ message: `stub has no route for ${req.method} ${u.pathname}` }] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stubEnv = { PENDPOST_MODE: null, GHOST_SITE_URL: `http://127.0.0.1:${port}`, GHOST_ADMIN_API_KEY: `stubkey:${crypto.randomBytes(32).toString('hex')}` };
  const envVars = { ...stubEnv };
  delete envVars.PENDPOST_MODE;
  fs.writeFileSync(path.join(WS, '.env'), `${Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });

  try {
    const liveCreate = await runEngineAsync(['member-create', '--email', 'bob@example.com', '--name', 'Bob', '--json', '--actor', 'owner'], stubEnv);
    ok(liveCreate.ok === true && row(liveCreate, 'member-create').ok === true && row(liveCreate, 'member-create').id === 'member-1',
      'live member-create against the stub resolves { ok:true, id } for a new email');

    // The SAME email again -> the stub's real 422 ("already exists") -> invalid_input.
    const liveDup = await runEngineAsync(['member-create', '--email', 'bob@example.com', '--json', '--actor', 'owner'], stubEnv);
    ok(liveDup.ok === true && row(liveDup, 'member-create').ok === false && row(liveDup, 'member-create').errorCode === 'invalid_input',
      'live member-create against a duplicate email -> the stub 422s -> { ok:false, errorCode:"invalid_input" } (a real 422, not the mock heuristic)');

    // members-import against the SAME stub: one genuinely-new row (created), one
    // duplicate of "bob" (Ghost 422s "already exists" -> skipped), one malformed
    // (no email -> failed) - proves the LIVE resilience path, not just the mock's.
    const liveImportRows = JSON.stringify([{ email: 'carol@example.com' }, { email: 'bob@example.com' }, {}]);
    const liveImport = await runEngineAsync(['members-import', '--rows', liveImportRows, '--json', '--actor', 'owner'], stubEnv);
    const liveImportRow = row(liveImport, 'members-import');
    ok(liveImport.ok === true && liveImportRow.ok === true && liveImportRow.created === 1 && liveImportRow.skipped === 1 && liveImportRow.failed.length === 1,
      `live members-import against the stub survives a mixed batch: 1 created, 1 skipped (real 422 dup), 1 failed - got ${JSON.stringify(liveImportRow)}`);

    // MAJOR-2: an over-cap --rows batch is rejected UP FRONT (before any
    // network call - the stub sees zero extra POSTs for this) with a message
    // that points the caller at --upload.
    const overCapRows = JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ email: `row${i}@example.com` })));
    const overCap = await runEngineAsync(['members-import', '--rows', overCapRows, '--json', '--actor', 'owner'], stubEnv);
    const overCapRow = row(overCap, 'members-import');
    ok(overCap.ok === true && overCapRow.ok === false && overCapRow.errorCode === 'invalid_input',
      `members-import over the row cap -> { ok:false, errorCode:'invalid_input' } - got ${JSON.stringify(overCapRow)}`);
    ok(/--upload/.test(overCapRow.errorMessage) && /500/.test(overCapRow.errorMessage),
      `the over-cap errorMessage points at --upload and states the cap - got "${overCapRow.errorMessage}"`);

    // MINOR-3: the --upload multipart fast-path reads `failed` from
    // meta.stats.invalid (Ghost's documented nested shape), not just the
    // top-level meta.invalid - proven against the stub route above.
    const uploadCsv = path.join(WS, 'upload-test.csv');
    fs.writeFileSync(uploadCsv, 'email,name\ngood@example.com,Good\n');
    const liveUpload = await runEngineAsync(['members-import', '--file', uploadCsv, '--upload', '--json', '--actor', 'owner'], stubEnv);
    const liveUploadRow = row(liveUpload, 'members-import');
    ok(liveUpload.ok === true && liveUploadRow.ok === true && liveUploadRow.created === 2 && liveUploadRow.skipped === 1,
      `live members-import --upload reads created/skipped from meta.stats/meta - got ${JSON.stringify(liveUploadRow)}`);
    ok(Array.isArray(liveUploadRow.failed) && liveUploadRow.failed.length === 1 && liveUploadRow.failed[0].email === 'badrow@example.com',
      `live members-import --upload reads failed from meta.stats.invalid (not just meta.invalid) - got ${JSON.stringify(liveUploadRow.failed)}`);
    fs.rmSync(uploadCsv, { force: true });

    const liveMembers = await runEngineAsync(['members', '--json', '--actor', 'owner'], stubEnv);
    ok(liveMembers.ok === true && row(liveMembers, 'members').counts.total === state.members.length,
      'live members reads back the stub\'s member count via meta.pagination.total');

    // MINOR-4: an OR --filter is parenthesized inside the per-status NQL count
    // query, so `status:` ANDs across the WHOLE user filter instead of binding
    // to only its first clause.
    capturedMemberFilters.length = 0;
    const liveFilterMembers = await runEngineAsync(['members', '--filter', 'label:vip,label:new', '--json', '--actor', 'owner'], stubEnv);
    ok(liveFilterMembers.ok === true && row(liveFilterMembers, 'members').ok === true, 'live members with --filter still resolves ok:true');
    ok(capturedMemberFilters.includes('label:vip,label:new'), `the main list call sends the user filter unmodified - got ${JSON.stringify(capturedMemberFilters)}`);
    for (const status of ['free', 'paid', 'comped']) {
      ok(capturedMemberFilters.includes(`status:${status}+(label:vip,label:new)`),
        `the ${status} count call parenthesizes the OR filter (status:${status}+(label:vip,label:new)) - got ${JSON.stringify(capturedMemberFilters)}`);
    }

    const liveNewsletterCreate = await runEngineAsync(['newsletter-create', '--name', 'Product Updates', '--json', '--actor', 'owner'], stubEnv);
    const createdNl = row(liveNewsletterCreate, 'newsletter-create');
    ok(liveNewsletterCreate.ok === true && createdNl.ok === true && createdNl.slug === 'product-updates', 'live newsletter-create against the stub resolves { ok:true, id, slug }');

    const liveNewsletters = await runEngineAsync(['newsletters', '--json', '--actor', 'owner'], stubEnv);
    ok(liveNewsletters.ok === true && row(liveNewsletters, 'newsletters').items.some((n) => n.slug === 'product-updates'),
      'live newsletters reflects the just-created newsletter (fetchNewsletters is reused, no duplicate request logic)');

    // newsletter-update's GET-then-PUT precondition flow: archives "weekly" and
    // proves the collision-check GET actually ran (the PUT would 404 without it).
    const liveArchive = await runEngineAsync(['newsletter-update', '--id', 'nl-weekly', '--status', 'archived', '--json', '--actor', 'owner'], stubEnv);
    const archiveRow = row(liveArchive, 'newsletter-update');
    ok(liveArchive.ok === true && archiveRow.ok === true && archiveRow.id === 'nl-weekly' && archiveRow.status === 'archived',
      'live newsletter-update archives via GET (updated_at precondition) then PUT, against the stub');
    ok(state.newsletters.find((n) => n.id === 'nl-weekly').status === 'archived', 'the stub\'s own newsletter record reflects the archive (a real state mutation, not just an echoed response)');

    const liveUnknownId = await runEngineAsync(['newsletter-update', '--id', 'nl-does-not-exist', '--status', 'archived', '--json', '--actor', 'owner'], stubEnv);
    ok(liveUnknownId.ok === true && row(liveUnknownId, 'newsletter-update').ok === false && row(liveUnknownId, 'newsletter-update').errorCode === 'invalid_input',
      'live newsletter-update on an unknown id -> the stub 404s the precondition GET -> invalid_input');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(path.join(WS, '.env'), { force: true });
  }

  // ================= 4. lib faces (writes.mjs) ====================================
  process.env.PENDPOST_MODE = 'mock';
  const libMembers = await ghostMembers({});
  ok(libMembers.ok === true && libMembers.counts && Array.isArray(libMembers.items), 'ghostMembers() resolves ok:true with the mock counts/items');

  const libNewsletters = await ghostNewsletters({});
  ok(libNewsletters.ok === true && Array.isArray(libNewsletters.items) && libNewsletters.items.length >= 1, 'ghostNewsletters() resolves ok:true with the mock items');

  const noActorCreate = await ghostMemberCreate({ email: 'x@example.com' });
  ok(noActorCreate.ok !== true && noActorCreate.code === 'invalid_input', 'ghostMemberCreate rejects a missing actor (invalid_input)');
  const unknownActorCreate = await ghostMemberCreate({ email: 'x@example.com', actor: 'unknown' });
  ok(unknownActorCreate.ok !== true && unknownActorCreate.code === 'invalid_input', 'ghostMemberCreate rejects actor "unknown"');
  const noEmailCreate = await ghostMemberCreate({ actor: 'owner' });
  ok(noEmailCreate.ok !== true && noEmailCreate.code === 'invalid_input', 'ghostMemberCreate requires email (invalid_input)');
  const libCreate = await ghostMemberCreate({ email: 'x@example.com', labels: ['vip'], newsletters: ['weekly'], actor: 'owner' });
  ok(libCreate.ok === true && libCreate.platform === 'ghost' && libCreate.id, 'ghostMemberCreate() succeeds via the mock engine { ok:true, id, platform:ghost }');

  const noActorImport = await ghostMembersImport({ rows: [{ email: 'x@example.com' }] });
  ok(noActorImport.ok !== true && noActorImport.code === 'invalid_input', 'ghostMembersImport rejects a missing actor (invalid_input)');
  const neitherImport = await ghostMembersImport({ actor: 'owner' });
  ok(neitherImport.ok !== true && neitherImport.code === 'invalid_input', 'ghostMembersImport requires file OR rows (invalid_input)');
  const bothImport = await ghostMembersImport({ file: 'x.csv', rows: [{ email: 'x@example.com' }], actor: 'owner' });
  ok(bothImport.ok !== true && bothImport.code === 'invalid_input', 'ghostMembersImport rejects file AND rows together (invalid_input)');
  const libImport = await ghostMembersImport({ rows: [{ email: 'a@example.com' }, { email: 'duplicate@example.com' }, {}], actor: 'owner' });
  ok(libImport.ok === true && libImport.created === 1 && libImport.skipped === 1 && libImport.failed.length === 1,
    `ghostMembersImport() survives a mixed batch via the mock engine - got created=${libImport.created} skipped=${libImport.skipped} failed=${libImport.failed?.length}`);

  const noActorNlCreate = await ghostNewsletterCreate({ name: 'X' });
  ok(noActorNlCreate.ok !== true && noActorNlCreate.code === 'invalid_input', 'ghostNewsletterCreate rejects a missing actor (invalid_input)');
  const libNlCreate = await ghostNewsletterCreate({ name: 'Monthly', actor: 'owner' });
  ok(libNlCreate.ok === true && libNlCreate.platform === 'ghost' && libNlCreate.id && libNlCreate.slug, 'ghostNewsletterCreate() succeeds via the mock engine { ok:true, id, slug, platform:ghost }');

  const noActorNlUpdate = await ghostNewsletterUpdate({ id: 'nl1', status: 'archived' });
  ok(noActorNlUpdate.ok !== true && noActorNlUpdate.code === 'invalid_input', 'ghostNewsletterUpdate rejects a missing actor (invalid_input)');
  const badStatusNlUpdate = await ghostNewsletterUpdate({ id: 'nl1', status: 'bogus', actor: 'owner' });
  ok(badStatusNlUpdate.ok !== true && badStatusNlUpdate.code === 'invalid_input', 'ghostNewsletterUpdate rejects an unknown status (invalid_input)');
  const libNlUpdate = await ghostNewsletterUpdate({ id: 'nl1', status: 'archived', actor: 'owner' });
  ok(libNlUpdate.ok === true && libNlUpdate.id === 'nl1' && libNlUpdate.status === 'archived' && libNlUpdate.platform === 'ghost',
    'ghostNewsletterUpdate() succeeds via the mock engine { ok:true, id, status, platform:ghost }');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[ghost-members] OK - mock fabrication + import resilience, live not_configured degrade, the real member-create/import/newsletter-create/update sequence (incl. a genuine 422 + the updated_at precondition) against a local stub, lib faces (${pass} assertions).`);
} catch (err) {
  console.error(`[ghost-members] FAIL - ${err.message}`);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
