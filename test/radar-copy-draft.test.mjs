#!/usr/bin/env node
// test/radar-copy-draft.test.mjs - copy-paste drafts for reply-incapable sources (HN first).
//
// The north star this closes: "see possible interactions and have answers drafted
// automatically" worked for reddit and never for Hacker News, because draftableSignals
// filtered to RADAR_REPLY_SOURCES and HN has no write API. Now a copyDraft source is
// drafted by the SAME phase-2 child through the SAME radar_queue_reply tool, and the
// server stores the text ON the signal ({ text, mode:'copy', ts }) instead of creating a
// plan post - so nothing unpostable ever sits in the approvals queue and no auto-reply
// policy can ever touch it.
//
// What this pins:
//   1. capability derivation: RADAR_COPY_DRAFT_SOURCES = ['hackernews'], disjoint from
//      RADAR_REPLY_SOURCES; the queue-reply enum widens, the reply-post validator does NOT.
//   2. the full press: ONE Scan (research -> drafting) with NO campaign configured still
//      drafts the HN copy suggestion (the no-campaign gate blocks only reply-POSTS),
//      the draft rides listRadar as signal.draft.mode==='copy', drafted counts it,
//      and the plan store stays EMPTY.
//   3. the fences hold on the copy path: empty research fence refuses, web is refused,
//      an uncached signal is refused (a copy draft needs a signal to live on).
//   4. the GUI/chat path keeps working disarmed, campaign stays REQUIRED for reply-posts.
//   5. mergeSignals keeps a stored copy draft when a re-scan re-finds the thread with a
//      higher score (sticky, like watched/ingested).
//
// HERMETIC: the one spawn goes to a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-copy-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

// ONE stub for BOTH phases. Every spawn it (a) ingests one HN signal (research's job;
// deduped on the second pass) and (b) tries to save the copy draft. During RESEARCH the
// fence is armed EMPTY, so (b) is refused; during DRAFTING the fence carries the picked
// key, so (b) lands. The final state - one draft, zero posts - is the proof.
const comboBin = path.join(WS, 'combo-claude');
fs.writeFileSync(comboBin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8'));
const call = (name, args) => fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json());
call('radar_ingest', { clientId: 'default', actor: 'agent:radar-scan', queryId: 'q1', signals: [{
  source: 'hackernews', externalId: 'hn1', url: 'https://news.ycombinator.com/item?id=1',
  text: 'I would love a social media management tool, all the ones I found were insanely expensive or unusable.', score: 70, reason: 'open pain point' }] })
  .then(() => call('radar_queue_reply', { clientId: 'default', actor: 'agent:radar-draft', confirm: true,
    source: 'hackernews', externalId: 'hn1', signalUrl: 'https://news.ycombinator.com/item?id=1',
    text: 'We hit the same wall and ended up building our own; happy to share what worked.' }))
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.1 })));
`);
fs.chmodSync(comboBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, queueRadarReply, listRadar } = await import('../lib/writes.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { RADAR_CAPABILITIES, RADAR_REPLY_SOURCES, RADAR_COPY_DRAFT_SOURCES, mergeSignals } = await import('../lib/radar.mjs');
  const { radarDraftPrompt } = await import('../lib/radar-prompt.mjs');
  const { beginDraftFence, endDraftFence } = await import('../lib/agent-runner.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  // DELIBERATELY no campaign: the copy path must not need one.

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const out = await handleRpc(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PENDPOST_PORT = String(server.address().port);

  // ===== (1) capability derivation ==========================================
  ok(RADAR_CAPABILITIES.hackernews.reply === false && RADAR_CAPABILITIES.hackernews.copyDraft === true,
    'hackernews stays reply:false and gains copyDraft:true');
  ok(JSON.stringify([...RADAR_COPY_DRAFT_SOURCES]) === JSON.stringify(['hackernews', 'x']),
    'RADAR_COPY_DRAFT_SOURCES derives to exactly [hackernews, x] (x: X refuses API replies to strangers; nostr flipped to the reply lane, wave 5)');
  ok(!RADAR_REPLY_SOURCES.includes('hackernews'),
    'RADAR_REPLY_SOURCES is untouched - the reply-post validator and auto-reply lanes never see HN');
  ok(RADAR_COPY_DRAFT_SOURCES.every((s) => !RADAR_REPLY_SOURCES.includes(s)),
    'the two sets are disjoint by construction');

  // The drafting brief tells the child about the copy path, and drops the campaign line
  // when there is no campaign (the copy-only run).
  const brief = radarDraftPrompt([{ source: 'hackernews', externalId: 'hn1', url: 'u', text: 't' }], { campaign: null });
  ok(/hackernews, x have no reply path from pendpost/.test(brief), 'the drafting brief explains the copy-paste path (derived - nostr auto-dropped on its reply flip)');
  ok(!/campaign: "/.test(brief), 'with no campaign, the brief omits the campaign line instead of interpolating null');

  // ===== (2) the full press, campaign-less ==================================
  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['social'] }],
      agent: { provider: 'claude-code', maxPerRun: 20 },
    } } },
  }));

  process.env[BIN_VAR] = comboBin;
  const r = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(r.ok === true && r.job && r.job.state === 'done', 'the press settles done');
  ok(r.job.drafted === 1, `drafted counts the copy draft (got ${r.job.drafted}) - it lives on the signal, not in a plan`);

  const feed = await asClient(() => listRadar({}));
  const sig = feed.items.find((s) => s.source === 'hackernews' && s.externalId === 'hn1');
  ok(Boolean(sig), 'the HN signal is in the feed');
  ok(sig && sig.draft && sig.draft.mode === 'copy' && /same wall/.test(sig.draft.text),
    'the copy draft rides listRadar as signal.draft { mode:"copy", text } - the card can render it');
  const store = asClient(() => loadPlanStore());
  ok((store.campaigns || []).flatMap((c) => c.posts || []).length === 0,
    'ZERO plan posts exist - a copy draft can never become an unpostable pending post or an auto-fired reply');

  // The research spawn ALSO tried the copy call, with the fence armed empty - the fact the
  // feed holds exactly the drafting phase's text (one draft, not two writes racing) plus the
  // direct proof below pins that refusal.
  beginDraftFence([]);
  const inResearch = await asClient(() => queueRadarReply({
    source: 'hackernews', externalId: 'hn1', signalUrl: 'https://news.ycombinator.com/item?id=1',
    text: 'injected during research', actor: 'agent:radar-draft', confirm: true,
  }));
  endDraftFence();
  ok(inResearch.ok !== true && /not one of the signals/.test(inResearch.message || ''),
    'the empty research fence refuses a copy draft exactly like a reply');

  // ===== (3) refusals on the copy path ======================================
  const web = await asClient(() => queueRadarReply({
    source: 'web', externalId: 'w1', signalUrl: 'https://example.com/x',
    text: 'hi', actor: 'owner', confirm: true,
  }));
  ok(web.ok !== true && web.code === 'invalid_input', 'web is still refused - no thread to answer');
  const uncached = await asClient(() => queueRadarReply({
    source: 'hackernews', externalId: 'hn_GHOST', signalUrl: 'https://news.ycombinator.com/item?id=9',
    text: 'hi', actor: 'owner', confirm: true,
  }));
  ok(uncached.ok !== true && /not in the feed/.test(uncached.message || ''),
    'a copy draft for a signal NOT in the feed is refused - it has nowhere to live');

  // ===== (4) disarmed GUI/chat path + reply-posts still need a campaign ======
  const gui = await asClient(() => queueRadarReply({
    source: 'hackernews', externalId: 'hn1', signalUrl: 'https://news.ycombinator.com/item?id=1',
    text: 'the operator rewrote this by hand', actor: 'owner', confirm: true,
  }));
  ok(gui.ok === true && gui.mode === 'copy' && gui.approval === null,
    'disarmed, a human can (re)write the copy draft; the response says mode:"copy", no approval state');
  const feed2 = await asClient(() => listRadar({}));
  ok(/rewrote this by hand/.test(feed2.items.find((s) => s.externalId === 'hn1').draft.text),
    'the rewrite landed - last write wins on the signal');
  const noCampaign = await asClient(() => queueRadarReply({
    source: 'reddit', externalId: 't3_1', signalUrl: 'https://reddit.com/r/x/1',
    text: 'hi', actor: 'owner', confirm: true,
  }));
  ok(noCampaign.ok !== true && noCampaign.code === 'invalid_input',
    'a reply-POST still requires a campaign - only the copy path is exempt');

  // ===== (5) mergeSignals keeps the draft sticky ============================
  const prior = { source: 'hackernews', externalId: 'hn1', url: 'u', text: 't', intentScore: 40, draft: { text: 'kept', mode: 'copy', ts: '2026-07-17T00:00:00Z' } };
  const fresher = { source: 'hackernews', externalId: 'hn1', url: 'u', text: 't', intentScore: 90 };
  const merged = mergeSignals([prior], [fresher], [], Date.now());
  ok(merged.length === 1 && merged[0].intentScore === 90 && merged[0].draft && merged[0].draft.text === 'kept',
    'a re-scan re-finding the thread (higher score wins) KEEPS the stored copy draft - sticky like watched');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-copy-draft] OK - HN gets drafted answers via the copy path: on-signal storage, zero plan posts, fences hold, campaign-less runs draft (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-copy-draft] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
